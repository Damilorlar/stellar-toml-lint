import { describe, expect, it } from 'vitest';

import {
  financialProductNodeOf,
  formatJsonLd,
  formatJsonLdScript,
  generateJsonLd,
  organizationNodeOf,
  ORGANIZATION_NODE_ID,
  SCHEMA_ORG_CONTEXT,
  validateJsonLd,
  type JsonLdNode,
} from '../../src/generators/jsonld.js';

const ANCHOR_DOC: Record<string, unknown> = {
  DOCUMENTATION: {
    ORG_NAME: 'Example Anchor',
    ORG_DBA: 'Example',
    ORG_URL: 'https://example.com',
    ORG_LOGO: 'https://example.com/logo.png',
    ORG_DESCRIPTION: 'A reference anchor.',
    ORG_OFFICIAL_EMAIL: 'office@example.com',
    ORG_SUPPORT_EMAIL: 'support@example.com',
    ORG_PHONE_NUMBER: '+1 555 0100',
    ORG_PHYSICAL_ADDRESS: '1 Example Plaza, Example City',
    ORG_TWITTER: '@example',
    ORG_GITHUB: 'https://github.com/example',
  },
  PRINCIPALS: [
    {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      twitter: 'ada',
      github: '@adalovelace',
      keybase: 'ada',
    },
    { name: 'No Contact' },
  ],
  CURRENCIES: [
    {
      code: 'USD',
      issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      desc: 'US dollar token',
      status: 'live',
      anchor_asset_type: 'fiat',
      is_asset_anchored: true,
      image: 'https://example.com/usd.png',
      regulated: true,
    },
    {
      contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      name: 'Example Points',
    },
  ],
};

describe('Schema.org JSON-LD generator (#382)', () => {
  it('builds an Organization node from [DOCUMENTATION]', () => {
    const node = organizationNodeOf(ANCHOR_DOC)!;

    expect(node).toEqual(
      expect.objectContaining({
        '@type': 'Organization',
        '@id': ORGANIZATION_NODE_ID,
        name: 'Example Anchor',
        alternateName: 'Example',
        url: 'https://example.com',
        logo: 'https://example.com/logo.png',
        description: 'A reference anchor.',
        email: 'office@example.com',
        telephone: '+1 555 0100',
        address: {
          '@type': 'PostalAddress',
          streetAddress: '1 Example Plaza, Example City',
        },
        contactPoint: {
          '@type': 'ContactPoint',
          contactType: 'customer support',
          email: 'support@example.com',
        },
      }),
    );
    expect(node.sameAs).toEqual(['https://twitter.com/example', 'https://github.com/example']);
  });

  it('maps [[PRINCIPALS]] to Person members with normalized profiles', () => {
    const members = organizationNodeOf(ANCHOR_DOC)!.member as JsonLdNode[];

    expect(members).toHaveLength(2);
    expect(members[0]).toEqual({
      '@type': 'Person',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      sameAs: [
        'https://twitter.com/ada',
        'https://github.com/adalovelace',
        'https://keybase.io/ada',
      ],
    });
    expect(members[1]).toEqual({ '@type': 'Person', name: 'No Contact' });
  });

  it('emits no organization when the file names nothing', () => {
    expect(organizationNodeOf({})).toBeUndefined();
    expect(organizationNodeOf({ DOCUMENTATION: { ORG_TWITTER: '@anchor' } })).toBeUndefined();
  });

  it('maps a currency entry to a FinancialProduct and Currency node', () => {
    const currencies = ANCHOR_DOC.CURRENCIES as Record<string, unknown>[];
    const node = financialProductNodeOf(currencies[0]!, 0)!;

    expect(node).toEqual(
      expect.objectContaining({
        '@type': ['FinancialProduct', 'Currency'],
        name: 'USD',
        identifier: 'USD',
        alternateName: 'USD',
        category: 'fiat',
        description: 'US dollar token',
        image: 'https://example.com/usd.png',
        regulated: true,
      }),
    );
    expect(node.additionalProperty).toEqual([
      {
        '@type': 'PropertyValue',
        name: 'issuer',
        propertyID: 'stellar:issuer',
        value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
      { '@type': 'PropertyValue', name: 'status', propertyID: 'stellar:status', value: 'live' },
      {
        '@type': 'PropertyValue',
        name: 'anchor_asset_type',
        propertyID: 'stellar:anchor_asset_type',
        value: 'fiat',
      },
    ]);
  });

  it('falls back to the contract identifier when a currency has no code', () => {
    const node = financialProductNodeOf({ contract: 'CAAAA', name: 'Example Points' }, 0)!;

    expect(node.name).toBe('Example Points');
    expect(node.identifier).toBe('CAAAA');
    expect(node.additionalProperty).toEqual([
      {
        '@type': 'PropertyValue',
        name: 'contract',
        propertyID: 'stellar:contract',
        value: 'CAAAA',
      },
    ]);
  });

  it('skips currency entries that identify nothing', () => {
    expect(financialProductNodeOf({}, 0)).toBeUndefined();
    expect(financialProductNodeOf({ code: 'USD' }, 0)).toBeDefined();
  });

  it('assembles a single @graph document that cross-links currencies', () => {
    const document = generateJsonLd(ANCHOR_DOC);
    const graph = document['@graph'] as JsonLdNode[];

    expect(document['@context']).toBe(SCHEMA_ORG_CONTEXT);
    expect(graph).toHaveLength(3);
    expect(graph[0]!['@type']).toBe('Organization');
    expect(graph[1]!.provider).toEqual({ '@id': ORGANIZATION_NODE_ID });
    expect(graph[1]!['@id']).toBe('#currency-usd-0');
    expect(graph[2]!['@id']).toMatch(/^#currency-c[a-z0-9]+-1$/);
  });

  it('omits the provider link when there is no organization', () => {
    const document = generateJsonLd({ CURRENCIES: [{ code: 'USD' }] });
    const graph = document['@graph'] as JsonLdNode[];

    expect(graph).toHaveLength(1);
    expect(graph[0]).not.toHaveProperty('provider');
  });

  it('formats the document as pretty JSON and a script tag', () => {
    const document = generateJsonLd(ANCHOR_DOC);
    const text = formatJsonLd(document);

    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(document);

    const script = formatJsonLdScript(document);
    expect(script.startsWith('<script type="application/ld+json">\n')).toBe(true);
    expect(script.endsWith('</script>\n')).toBe(true);
    expect(
      JSON.parse(script.slice(script.indexOf('\n') + 1, script.lastIndexOf('\n</script>'))),
    ).toEqual(document);
  });

  it('does not let a closing script tag inside data end the tag early', () => {
    const script = formatJsonLdScript({
      '@context': SCHEMA_ORG_CONTEXT,
      '@graph': [{ '@type': 'Organization', description: 'a </script> injection' }],
    });

    expect(script).not.toContain('a </script> injection');
    expect(script).toContain('<\\/script> injection');
  });

  it('validates the generated document', () => {
    expect(validateJsonLd(generateJsonLd(ANCHOR_DOC))).toEqual({ valid: true, errors: [] });
    expect(validateJsonLd(generateJsonLd({}))).toEqual({ valid: true, errors: [] });
  });

  it('rejects a wrong context, unknown types, and missing required properties', () => {
    expect(
      validateJsonLd({ '@context': 'https://example.com', '@graph': [] }).errors,
    ).toContainEqual(expect.stringContaining('@context'));

    const unknown = validateJsonLd({
      '@context': SCHEMA_ORG_CONTEXT,
      '@graph': [{ '@type': 'Spaceship', name: 'x' }],
    });
    expect(unknown.valid).toBe(false);
    expect(unknown.errors[0]).toContain('Spaceship');

    const missing = validateJsonLd({
      '@context': SCHEMA_ORG_CONTEXT,
      '@graph': [{ '@type': 'FinancialProduct' }],
    });
    expect(missing.errors).toContainEqual(expect.stringContaining('"name"'));

    const person = validateJsonLd({
      '@context': SCHEMA_ORG_CONTEXT,
      '@graph': [{ '@type': 'Organization', member: [{ '@type': 'Person' }] }],
    });
    expect(person.errors).toContainEqual(expect.stringContaining('Person'));
  });

  it('rejects malformed roots and graphs', () => {
    expect(validateJsonLd('nope').valid).toBe(false);
    expect(validateJsonLd(['nope']).valid).toBe(false);
    expect(
      validateJsonLd({ '@context': SCHEMA_ORG_CONTEXT, '@graph': 'nope' }).errors,
    ).toContainEqual(expect.stringContaining('@graph'));
    expect(
      validateJsonLd({ '@context': SCHEMA_ORG_CONTEXT, '@graph': ['nope'] }).errors,
    ).toContainEqual(expect.stringContaining('must be a JSON-LD node object'));
  });
});
