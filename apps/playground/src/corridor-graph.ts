/**
 * Turns a `stellar.toml` into the model behind the corridor visualizer.
 *
 * A cross-border payment runs through a fixed chain of parties: the user's
 * wallet authenticates (SEP-10), passes KYC (SEP-12), asks for a quote
 * (SEP-38), hands the money to an anchor that speaks SEP-6, SEP-24, or SEP-31,
 * and settles on the Stellar ledger. Every hop is a hop *because* a field in
 * the info file wires it up. Drop `KYC_SERVER` and the SEP-31 leg has nowhere
 * to send its customer — a bridge is missing, and no single-field rule can see
 * it because each field on its own is optional.
 *
 * This module is deliberately free of React and Cytoscape. It is the part with
 * the opinions, so it is the part the test suite pins down as plain data; the
 * component is a thin renderer over {@link toCytoscapeElements}.
 */
import { parse } from 'smol-toml';

/** Health of one node or bridge. Anything but `ok` renders red. */
export type CorridorStatus = 'ok' | 'missing' | 'misconfigured';

/** The stages of a corridor, in the order money flows through them. */
export type CorridorStage = 'wallet' | 'sep10' | 'sep12' | 'sep38' | 'anchor' | 'ledger';

/** A `stellar.toml` field that wires one stage to the next. */
export interface CorridorBridge {
  /** Field name, e.g. `WEB_AUTH_ENDPOINT`. */
  key: string;
  /** The value as written, when the field is present and a string. */
  value?: string;
  /** 1-based line of the key in the source, for jump-to-line. */
  line?: number;
  /** Whether the field is present and usable. */
  status: CorridorStatus;
  /** Why the bridge is not `ok`, in a sentence a person can act on. */
  reason?: string;
}

/** One stage of the corridor. */
export interface CorridorNode {
  id: CorridorStage;
  label: string;
  /** Worst health across the node's own bridges and cross-field constraints. */
  status: CorridorStatus;
  /** Worst severity across the diagnostics attached to this node. */
  severity: 'error' | 'warning' | 'info' | 'none';
  /** One-line explanation shown in the inspector. */
  detail: string;
  /** Line to jump to when the node is clicked, when it has one. */
  line?: number;
  /** Protocol badges, e.g. `['SEP-10']`. */
  protocols: string[];
  /** The TOML fields that make this stage work. */
  bridges: CorridorBridge[];
}

/** A directed hop between two stages. */
export interface CorridorEdge {
  id: string;
  source: CorridorStage;
  target: CorridorStage;
  /** `ok` only when both endpoints are healthy. */
  status: CorridorStatus;
  /** Why the hop is broken, when it is. */
  detail: string;
}

/** The whole picture, ready to render. */
export interface CorridorGraph {
  nodes: CorridorNode[];
  edges: CorridorEdge[];
  summary: {
    ok: number;
    missing: number;
    misconfigured: number;
    /** Edges whose endpoints are not both healthy. */
    brokenBridges: number;
  };
}

/** A diagnostic shaped the way `stellar-toml-lint` reports them. */
export interface CorridorDiagnostic {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
}

/** Input to {@link buildCorridorGraph}. */
export interface CorridorGraphOptions {
  /** The `stellar.toml` source text. */
  source: string;
  /** Findings from the linter; error-severity ones turn their stage red. */
  diagnostics?: readonly CorridorDiagnostic[];
  /** Serving domain, used for the wallet label when there is no ORG_NAME. */
  domain?: string;
}

/** The default Horizon a wallet falls back to, mirroring the SEP-1 default. */
const PUBLIC_HORIZON = 'https://horizon.stellar.org';

/** Anchor legs, keyed by the field that declares them. */
const ANCHOR_KEYS: readonly { key: string; protocol: string }[] = [
  { key: 'TRANSFER_SERVER', protocol: 'SEP-6' },
  { key: 'TRANSFER_SERVER_SEP0024', protocol: 'SEP-24' },
  { key: 'DIRECT_PAYMENT_SERVER', protocol: 'SEP-31' },
];

/**
 * The chain, and the stage each node's diagnostics belong to.
 *
 * Declared once so the model, the Cytoscape layout, and the diagnostic routing
 * cannot disagree about the order of the corridor.
 */
const CHAIN: readonly CorridorStage[] = ['wallet', 'sep10', 'sep12', 'sep38', 'anchor', 'ledger'];

const TITLES: Record<CorridorStage, string> = {
  wallet: 'User Wallet',
  sep10: 'SEP-10 Auth',
  sep12: 'SEP-12 KYC',
  sep38: 'SEP-38 Quote',
  anchor: 'SEP-6/24/31 Anchor',
  ledger: 'Horizon Ledger',
};

/** Fields whose diagnostics belong to a given stage. */
const DIAGNOSTIC_FIELDS: Record<CorridorStage, readonly string[]> = {
  wallet: [],
  sep10: ['WEB_AUTH_ENDPOINT', 'SIGNING_KEY', 'URI_REQUEST_SIGNING_KEY', 'WEB_AUTH_CONTRACT_ID'],
  sep12: ['KYC_SERVER'],
  sep38: ['ANCHOR_QUOTE_SERVER'],
  anchor: [
    'TRANSFER_SERVER',
    'TRANSFER_SERVER_SEP0024',
    'DIRECT_PAYMENT_SERVER',
    'CURRENCIES',
    'NETWORK_PASSPHRASE',
  ],
  ledger: ['HORIZON_URL', 'NETWORK_PASSPHRASE'],
};

/**
 * Builds the corridor model from a `stellar.toml`.
 *
 * Never throws on a malformed file: a graph that shows the parse failure is
 * more useful than a blank screen, so every node degrades to `missing`.
 */
export function buildCorridorGraph(options: CorridorGraphOptions): CorridorGraph {
  const { source, diagnostics = [] } = options;
  const parsed = parseSafely(source);

  const bridges: Record<CorridorStage, CorridorBridge[]> = {
    wallet: [],
    sep10: [],
    sep12: [],
    sep38: [],
    anchor: [],
    ledger: [],
  };

  bridges.sep10.push(serviceBridge(source, parsed, 'WEB_AUTH_ENDPOINT'));
  bridges.sep12.push(serviceBridge(source, parsed, 'KYC_SERVER'));
  bridges.sep38.push(serviceBridge(source, parsed, 'ANCHOR_QUOTE_SERVER'));
  for (const { key } of ANCHOR_KEYS) bridges.anchor.push(serviceBridge(source, parsed, key));
  bridges.ledger.push(horizonBridge(source, parsed));

  const nodes = CHAIN.map((id) => buildNode(id, bridges[id], parsed, options));
  attachDiagnostics(nodes, diagnostics);
  applyCrossFieldRules(nodes, parsed);

  const edges = buildEdges(nodes);
  const brokenBridges = edges.filter((edge) => edge.status !== 'ok').length;

  return {
    nodes,
    edges,
    summary: {
      ok: nodes.filter((node) => node.status === 'ok').length,
      missing: nodes.filter((node) => node.status === 'missing').length,
      misconfigured: nodes.filter((node) => node.status === 'misconfigured').length,
      brokenBridges,
    },
  };
}

/** Converts the model to Cytoscape's element array, with health as a class. */
export function toCytoscapeElements(graph: CorridorGraph): CytoscapeElement[] {
  const elements: CytoscapeElement[] = graph.nodes.map((node) => ({
    data: {
      id: node.id,
      label: node.label,
      status: node.status,
      detail: node.detail,
      ...(node.line === undefined ? {} : { line: String(node.line) }),
      protocols: node.protocols.join(', '),
    },
    classes: `stage stage-${node.id} ${node.status}`,
  }));

  for (const edge of graph.edges) {
    elements.push({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.status === 'ok' ? '' : 'broken',
      },
      classes: `bridge ${edge.status}`,
    });
  }

  return elements;
}

/** Cytoscape renders arbitrary JSON; this is the subset we rely on. */
export interface CytoscapeElement {
  data: Record<string, string>;
  classes: string;
}

function buildNode(
  id: CorridorStage,
  bridges: CorridorBridge[],
  parsed: Record<string, unknown>,
  options: CorridorGraphOptions,
): CorridorNode {
  if (id === 'wallet') {
    const org = nestedString(parsed, 'DOCUMENTATION', 'ORG_NAME');
    const label = org ?? options.domain ?? TITLES.wallet;
    return {
      id,
      label: org === undefined ? TITLES.wallet : `${label}`,
      status: 'ok',
      severity: 'none',
      detail:
        org === undefined
          ? 'Entry point. The wallet reads this file before it can do anything else.'
          : `${org} — the wallet that starts the corridor.`,
      protocols: [],
      bridges,
    };
  }

  const present = bridges.filter((bridge) => bridge.status !== 'missing');
  const broken = bridges.filter((bridge) => bridge.status === 'misconfigured');
  const status: CorridorStatus =
    present.length === 0 ? 'missing' : broken.length > 0 ? 'misconfigured' : 'ok';

  const lines = bridges
    .map((bridge) => bridge.line)
    .filter((line): line is number => line !== undefined);
  const anchorProtocols = ANCHOR_KEYS.filter(({ key }) =>
    bridges.some((bridge) => bridge.key === key && bridge.status !== 'missing'),
  ).map(({ protocol }) => protocol);

  const label =
    id === 'anchor' && anchorProtocols.length > 0
      ? `${anchorProtocols.join('/')} Anchor`
      : TITLES[id];

  const detail =
    status === 'missing'
      ? missingDetail(id)
      : status === 'misconfigured'
        ? (broken[0]?.reason ?? 'One of this stage’s endpoints is not usable.')
        : `${bridges.filter((bridge) => bridge.value !== undefined).length} endpoint(s) declared.`;

  return {
    id,
    label,
    status,
    severity: status === 'ok' ? 'none' : 'error',
    detail,
    ...(lines.length === 0 ? {} : { line: Math.min(...lines) }),
    protocols: id === 'anchor' ? anchorProtocols : id === 'ledger' ? [] : [protocolOf(id)],
    bridges,
  };
}

function missingDetail(id: CorridorStage): string {
  switch (id) {
    case 'sep10':
      return 'No WEB_AUTH_ENDPOINT: wallets have no way to prove who they are.';
    case 'sep12':
      return 'No KYC_SERVER: identity can never be sent, so regulated corridors stall here.';
    case 'sep38':
      return 'No ANCHOR_QUOTE_SERVER: no exchange rate can be negotiated up front.';
    case 'anchor':
      return 'No transfer server declared: the corridor has nothing to hand funds to.';
    case 'ledger':
      return 'No HORIZON_URL: clients fall back to the public Horizon.';
    default:
      return '';
  }
}

/**
 * Marks the field an unauthenticated anchor leg depends on.
 *
 * SEP-38, SEP-12, and SEP-24 are all authenticated protocols, so a transfer
 * server with no `WEB_AUTH_ENDPOINT` is a corridor that looks complete and
 * fails at the first request. That is precisely the red bridge this visualizer
 * exists to show, and it is invisible to a per-field check.
 */
function applyCrossFieldRules(nodes: CorridorNode[], parsed: Record<string, unknown>): void {
  const requiresAuth = ['sep12', 'sep38', 'anchor'].filter((stage) => {
    const node = nodes.find((candidate) => candidate.id === stage);
    return node !== undefined && node.status !== 'missing';
  });
  const sep10 = nodes.find((node) => node.id === 'sep10');
  const webAuth = stringValue(parsed, 'WEB_AUTH_ENDPOINT');

  if (sep10 !== undefined && requiresAuth.length > 0 && webAuth === undefined) {
    const dependents = requiresAuth.map((stage) => TITLES[stage as CorridorStage]).join(', ');
    sep10.status = 'misconfigured';
    sep10.severity = 'error';
    sep10.detail = `Required by ${dependents}, but WEB_AUTH_ENDPOINT is not declared.`;
  }

  const directPayment = stringValue(parsed, 'DIRECT_PAYMENT_SERVER');
  const kyc = stringValue(parsed, 'KYC_SERVER');
  const anchor = nodes.find((node) => node.id === 'anchor');
  if (
    directPayment !== undefined &&
    kyc === undefined &&
    anchor !== undefined &&
    anchor.status === 'ok'
  ) {
    anchor.status = 'misconfigured';
    anchor.severity = 'error';
    anchor.detail =
      'DIRECT_PAYMENT_SERVER (SEP-31) needs KYC_SERVER; the customer has nowhere to go.';
  }
}

function attachDiagnostics(
  nodes: CorridorNode[],
  diagnostics: readonly CorridorDiagnostic[],
): void {
  for (const node of nodes) {
    const fields = DIAGNOSTIC_FIELDS[node.id];
    const mine = diagnostics.filter((diagnostic) => {
      const path = diagnostic.path ?? '';
      return fields.some((field) => path.startsWith(field)) || path.startsWith(node.id);
    });
    if (mine.length === 0) continue;

    const worst = mine.some((diagnostic) => diagnostic.severity === 'error')
      ? 'error'
      : mine.some((diagnostic) => diagnostic.severity === 'warning')
        ? 'warning'
        : 'info';

    if (worst === 'error') {
      node.status = 'misconfigured';
      node.detail =
        mine.find((diagnostic) => diagnostic.severity === 'error')?.message ?? node.detail;
    }
    node.severity = worseSeverity(node.severity, worst);
  }
}

function worseSeverity(
  a: CorridorNode['severity'],
  b: CorridorNode['severity'],
): CorridorNode['severity'] {
  const rank = { none: 0, info: 1, warning: 2, error: 3 } as const;
  return rank[a] >= rank[b] ? a : b;
}

function buildEdges(nodes: CorridorNode[]): CorridorEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: CorridorEdge[] = [];

  for (let i = 0; i < CHAIN.length - 1; i++) {
    const source = CHAIN[i] as CorridorStage;
    const target = CHAIN[i + 1] as CorridorStage;
    const from = byId.get(source);
    const to = byId.get(target);
    const status = worstStatus(from?.status ?? 'ok', to?.status ?? 'ok');

    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      status,
      detail:
        status === 'ok'
          ? 'Bridge intact.'
          : `${TITLES[source]} → ${TITLES[target]} is broken: ${
              from?.status !== 'ok' && from !== undefined
                ? from.detail
                : (to?.detail ?? 'unavailable')
            }`,
    });
  }

  return edges;
}

function worstStatus(a: CorridorStatus, b: CorridorStatus): CorridorStatus {
  if (a === 'missing' || b === 'missing') return 'missing';
  if (a === 'misconfigured' || b === 'misconfigured') return 'misconfigured';
  return 'ok';
}

function protocolOf(id: CorridorStage): string {
  switch (id) {
    case 'sep10':
      return 'SEP-10';
    case 'sep12':
      return 'SEP-12';
    case 'sep38':
      return 'SEP-38';
    default:
      return '';
  }
}

/** Builds the bridge for a URL-shaped service endpoint. */
function serviceBridge(
  source: string,
  parsed: Record<string, unknown>,
  key: string,
): CorridorBridge {
  const line = findKeyLine(source, key);
  const value = stringValue(parsed, key);

  if (value === undefined) {
    return { key, status: 'missing', ...(line === undefined ? {} : { line }) };
  }

  return {
    key,
    value,
    status: classifyEndpoint(value),
    ...(line === undefined ? {} : { line }),
    ...(endpointProblem(value) === undefined ? {} : { reason: endpointProblem(value) as string }),
  };
}

/** Horizon is the special case: absence is normal, and the public default applies. */
function horizonBridge(source: string, parsed: Record<string, unknown>): CorridorBridge {
  const line = findKeyLine(source, 'HORIZON_URL');
  const value = stringValue(parsed, 'HORIZON_URL');

  if (value === undefined) {
    return {
      key: 'HORIZON_URL',
      value: PUBLIC_HORIZON,
      status: 'ok',
      reason: 'Not declared; clients use the public Horizon.',
      ...(line === undefined ? {} : { line }),
    };
  }

  const problem = endpointProblem(value);
  return {
    key: 'HORIZON_URL',
    value,
    status: problem === undefined ? 'ok' : 'misconfigured',
    ...(line === undefined ? {} : { line }),
    ...(problem === undefined ? {} : { reason: problem }),
  };
}

function classifyEndpoint(value: string): CorridorStatus {
  return endpointProblem(value) === undefined ? 'ok' : 'misconfigured';
}

/** The reason an endpoint cannot be used, or `undefined` when it is fine. */
function endpointProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'The endpoint is empty.';
  if (!trimmed.startsWith('https://')) {
    return 'Must be an https:// URL; a wallet will refuse to send credentials over anything else.';
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Not a valid URL.';
  }
  if (url.hostname === '') return 'Not a valid URL: no host.';
  if (url.pathname.endsWith('/')) {
    return 'Trailing slash turns client sub-routes into //info, tripping redirects that drop Authorization.';
  }
  return undefined;
}

/** 1-based line of `KEY = ...` in the source, tolerating quoted keys. */
export function findKeyLine(source: string, key: string): number | undefined {
  const pattern = new RegExp(`^\\s*"?${escapeRegExp(key)}"?\\s*=`);
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] as string)) return i + 1;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSafely(source: string): Record<string, unknown> {
  try {
    const value = parse(source);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** Reads a top-level string field. */
function stringValue(parsed: Record<string, unknown>, key: string): string | undefined {
  const value = parsed[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads `table.key` when both are present and a string. */
function nestedString(
  parsed: Record<string, unknown>,
  table: string,
  key: string,
): string | undefined {
  const section = parsed[table];
  if (!isRecord(section)) return undefined;
  const value = section[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
