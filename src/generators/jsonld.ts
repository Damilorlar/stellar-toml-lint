/**
 * Schema.org JSON-LD structured data generator (issue #382).
 *
 * Anchors want their organization metadata and issued currencies discoverable
 * in search engines. Converting `stellar.toml` into Schema.org JSON-LD lets a
 * website embed machine-readable structured data (`<script
 * type="application/ld+json">`) that search engines index automatically:
 *
 * - `[DOCUMENTATION]` becomes an `Organization`, with the physical address as
 *   a `PostalAddress` and the support address as a `ContactPoint`.
 * - `[[PRINCIPALS]]` become `Person` nodes linked as the organization's
 *   `member`s.
 * - every `[[CURRENCIES]]` entry becomes a `FinancialProduct` (also typed
 *   `Currency`), carrying its issuer or Soroban contract as a `PropertyValue`
 *   so indexers can link the token back to its on-chain identity.
 *
 * {@link validateJsonLd} checks the generated document the way the Schema.org
 * JSON-LD validator does — context, known types, and the required properties
 * of every emitted node — so a malformed mapping fails loudly instead of
 * publishing invisible structured data.
 */
import { isEmail, isHttpsUrl, isString, isUrl } from '../predicates.js';

/** The JSON-LD context every document is emitted against. */
export const SCHEMA_ORG_CONTEXT = 'https://schema.org';

/** Stable `@id` for the organization node, used to cross-link currencies. */
export const ORGANIZATION_NODE_ID = '#organization';

/** Schema.org types this generator emits or accepts in generated output. */
export const KNOWN_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  'Organization',
  'FinancialProduct',
  'Currency',
  'Person',
  'PostalAddress',
  'ContactPoint',
  'PropertyValue',
  'ImageObject',
  'MonetaryAmount',
  'CurrencyConversionService',
]);

/** A JSON-LD node: an object with an `@type` and any number of properties. */
export type JsonLdNode = Record<string, unknown>;

export interface JsonLdValidation {
  valid: boolean;
  /** One message per violation, empty when {@link valid} is true. */
  errors: string[];
}

function tableOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Non-empty string test, so whitespace does not become a Schema.org value. */
function filled(value: unknown): value is string {
  return isString(value) && value.trim() !== '';
}

/** Reads the `[DOCUMENTATION]` table, or `undefined` when it is absent. */
function documentationOf(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  return tableOf(doc.DOCUMENTATION);
}

function entriesOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(tableOf)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

/** Normalizes `@handle`, `handle`, or a full URL into a profile URL. */
function profileUrl(value: unknown, base: string): string | undefined {
  if (!filled(value)) return undefined;
  if (isUrl(value)) return value;
  return `${base}/${value.replace(/^@/, '')}`;
}

/** Builds a `PostalAddress` from the free-text SEP-1 address line. */
function postalAddress(value: unknown): JsonLdNode | undefined {
  if (!filled(value)) return undefined;
  return {
    '@type': 'PostalAddress',
    streetAddress: value,
  };
}

/** Maps `[[PRINCIPALS]]` entries to Schema.org `Person` nodes. */
function principalsOf(doc: Record<string, unknown>): JsonLdNode[] {
  return entriesOf(doc.PRINCIPALS)
    .filter((principal) => filled(principal.name))
    .map((principal) => {
      const node: JsonLdNode = {
        '@type': 'Person',
        name: principal.name,
        ...(isEmail(principal.email) ? { email: principal.email } : {}),
      };
      const sameAs = [
        profileUrl(principal.twitter, 'https://twitter.com'),
        profileUrl(principal.github, 'https://github.com'),
        profileUrl(principal.keybase, 'https://keybase.io'),
      ].filter((url): url is string => url !== undefined);
      if (sameAs.length > 0) node.sameAs = sameAs;
      return node;
    });
}

/**
 * Maps `[DOCUMENTATION]` and `[[PRINCIPALS]]` to a Schema.org `Organization`.
 *
 * Returns `undefined` when the file documents no organization at all, so an
 * empty node is never published just to have one.
 */
export function organizationNodeOf(doc: Record<string, unknown>): JsonLdNode | undefined {
  const documentation = documentationOf(doc);
  if (documentation === undefined) return undefined;

  const members = principalsOf(doc);
  const sameAs = [
    profileUrl(documentation.ORG_TWITTER, 'https://twitter.com'),
    profileUrl(documentation.ORG_GITHUB, 'https://github.com'),
    profileUrl(documentation.ORG_KEYBASE, 'https://keybase.io'),
  ].filter((url): url is string => url !== undefined);

  const node: JsonLdNode = {
    '@type': 'Organization',
    '@id': ORGANIZATION_NODE_ID,
    ...(filled(documentation.ORG_NAME) ? { name: documentation.ORG_NAME } : {}),
    ...(filled(documentation.ORG_DBA) ? { alternateName: documentation.ORG_DBA } : {}),
    ...(isHttpsUrl(documentation.ORG_URL) ? { url: documentation.ORG_URL } : {}),
    ...(isUrl(documentation.ORG_LOGO) ? { logo: documentation.ORG_LOGO } : {}),
    ...(filled(documentation.ORG_DESCRIPTION)
      ? { description: documentation.ORG_DESCRIPTION }
      : {}),
    ...(isEmail(documentation.ORG_OFFICIAL_EMAIL)
      ? { email: documentation.ORG_OFFICIAL_EMAIL }
      : {}),
    ...(filled(documentation.ORG_PHONE_NUMBER)
      ? { telephone: documentation.ORG_PHONE_NUMBER }
      : {}),
  };

  const address = postalAddress(documentation.ORG_PHYSICAL_ADDRESS);
  if (address !== undefined) node.address = address;

  if (isEmail(documentation.ORG_SUPPORT_EMAIL)) {
    node.contactPoint = {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: documentation.ORG_SUPPORT_EMAIL,
    };
  }

  if (sameAs.length > 0) node.sameAs = sameAs;
  if (members.length > 0) node.member = members;

  // A node that names nothing would help no indexer.
  if (!('name' in node) && !('url' in node) && !('logo' in node) && !('description' in node)) {
    return undefined;
  }
  return node;
}

/** Builds the embedded `PropertyValue` list for a currency entry. */
function currencyProperties(entry: Record<string, unknown>): JsonLdNode[] {
  const properties: JsonLdNode[] = [];
  if (filled(entry.issuer)) {
    properties.push({
      '@type': 'PropertyValue',
      name: 'issuer',
      propertyID: 'stellar:issuer',
      value: entry.issuer,
    });
  }
  if (filled(entry.contract)) {
    properties.push({
      '@type': 'PropertyValue',
      name: 'contract',
      propertyID: 'stellar:contract',
      value: entry.contract,
    });
  }
  if (filled(entry.status)) {
    properties.push({
      '@type': 'PropertyValue',
      name: 'status',
      propertyID: 'stellar:status',
      value: entry.status,
    });
  }
  if (filled(entry.anchor_asset_type)) {
    properties.push({
      '@type': 'PropertyValue',
      name: 'anchor_asset_type',
      propertyID: 'stellar:anchor_asset_type',
      value: entry.anchor_asset_type,
    });
  }
  return properties;
}

/** Maps one `[[CURRENCIES]]` entry to a `FinancialProduct` / `Currency` node. */
export function financialProductNodeOf(
  entry: Record<string, unknown>,
  index: number,
): JsonLdNode | undefined {
  const code = filled(entry.code) ? entry.code : undefined;
  const name = filled(entry.name) ? entry.name : code;
  const identifier = code ?? entry.contract;
  if (name === undefined || !filled(identifier)) return undefined;

  const properties = currencyProperties(entry);
  return {
    '@type': ['FinancialProduct', 'Currency'],
    '@id': `#currency-${String(identifier).toLowerCase()}-${index}`,
    name,
    identifier,
    // SEP-1 calls this field `anchor_asset_type`; Schema.org calls it category.
    ...(filled(entry.anchor_asset_type) ? { category: entry.anchor_asset_type } : {}),
    ...(filled(entry.desc) ? { description: entry.desc } : {}),
    ...(isUrl(entry.image) ? { image: entry.image } : {}),
    ...(filled(entry.code) ? { alternateName: entry.code } : {}),
    ...(properties.length > 0 ? { additionalProperty: properties } : {}),
    ...(entry.regulated === true ? { regulated: true } : {}),
  };
}

/**
 * Generates the complete JSON-LD document for a stellar.toml.
 *
 * The result is a single `@graph` document rooted at `https://schema.org`, so
 * one `<script>` tag publishes everything and the organization node can be
 * referenced by `@id` from the currency nodes. Fields Schema.org has no
 * equivalent for (issuer, contract, status, anchor_asset_type) travel as
 * `PropertyValue` nodes rather than being dropped.
 */
export function generateJsonLd(doc: Record<string, unknown>): JsonLdNode {
  const graph: JsonLdNode[] = [];

  const organization = organizationNodeOf(doc);
  if (organization !== undefined) graph.push(organization);

  for (const node of entriesOf(doc.CURRENCIES).map(financialProductNodeOf).filter(isPresent)) {
    // Cross-link the token to the organization node when one exists.
    if (organization !== undefined) node.provider = { '@id': ORGANIZATION_NODE_ID };
    graph.push(node);
  }

  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@graph': graph,
  };
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Serializes a generated document as pretty-printed JSON with a newline. */
export function formatJsonLd(document: JsonLdNode): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Wraps a generated document in the `<script>` tag a web page embeds.
 *
 * JSON is only a subset of JavaScript, so the closing-tag sequence is split to
 * keep a `</script>` inside a description from ending the tag early.
 */
export function formatJsonLdScript(document: JsonLdNode): string {
  const json = JSON.stringify(document, null, 2).replace(/<\/script/gi, '<\\/script');
  return `<script type="application/ld+json">\n${json}\n</script>\n`;
}

/** Required properties per Schema.org type, mirroring the official validator. */
const REQUIRED_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  Organization: [],
  FinancialProduct: ['name'],
  Currency: ['name'],
  Person: ['name'],
  PostalAddress: ['streetAddress'],
  ContactPoint: ['email'],
  PropertyValue: ['name', 'value'],
};

function typeNamesOf(node: JsonLdNode): string[] {
  const type = node['@type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type))
    return type.filter((value): value is string => typeof value === 'string');
  return [];
}

/**
 * Validates a generated document the way the Schema.org JSON-LD validator
 * does: the context must be `https://schema.org`, every `@type` must be a type
 * Schema.org defines, every node must carry its type's required properties,
 * and every value must survive JSON serialization.
 */
export function validateJsonLd(document: unknown): JsonLdValidation {
  const errors: string[] = [];

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { valid: false, errors: ['The document root must be a JSON-LD object.'] };
  }

  const root = document as Record<string, unknown>;
  const context = root['@context'];
  const contextOk =
    context === SCHEMA_ORG_CONTEXT ||
    (Array.isArray(context) && context.includes(SCHEMA_ORG_CONTEXT)) ||
    (typeof context === 'object' &&
      context !== null &&
      (context as Record<string, unknown>)['@vocab'] === SCHEMA_ORG_CONTEXT);
  if (!contextOk) {
    errors.push(`@context must be "${SCHEMA_ORG_CONTEXT}" or include it.`);
  }

  const graphValue = root['@graph'];
  const nodes = Array.isArray(graphValue)
    ? graphValue
    : graphValue === undefined
      ? []
      : [graphValue];
  if (!Array.isArray(graphValue) && graphValue !== undefined) {
    errors.push('@graph must be an array of nodes.');
  }

  nodes.forEach((node, index) => {
    validateNode(node, `@graph[${index}]`, errors);
  });

  if (errors.length === 0) {
    try {
      JSON.parse(JSON.stringify(document));
    } catch {
      errors.push('The document contains values that cannot be JSON-serialized.');
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateNode(node: unknown, at: string, errors: string[]): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    errors.push(`${at} must be a JSON-LD node object.`);
    return;
  }
  const record = node as JsonLdNode;
  const types = typeNamesOf(record);
  if (types.length === 0) {
    errors.push(`${at} has no @type.`);
    return;
  }

  for (const type of types) {
    if (!KNOWN_SCHEMA_TYPES.has(type)) {
      errors.push(`${at} uses the unknown Schema.org type "${type}".`);
      continue;
    }
    for (const property of REQUIRED_PROPERTIES[type] ?? []) {
      const value = record[property];
      if (value === undefined || value === null || value === '') {
        errors.push(`${at} (${type}) is missing the required property "${property}".`);
      }
    }
  }

  // Nested nodes (member, address, contactPoint, additionalProperty, ...).
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@')) continue;
    const nested = Array.isArray(value) ? value : [value];
    for (const item of nested) {
      if (
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        (item as JsonLdNode)['@type'] !== undefined
      ) {
        validateNode(item, `${at}.${key}`, errors);
      }
    }
  }
}
