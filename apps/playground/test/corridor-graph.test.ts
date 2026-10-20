import { describe, expect, it } from 'vitest';
import {
  buildCorridorGraph,
  findKeyLine,
  toCytoscapeElements,
  type CorridorStatus,
} from '../src/corridor-graph.js';

/** A complete hosted anchor: every stage of the corridor is wired up. */
const FULL_ANCHOR = `VERSION = "1.0.0"
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"
SIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
KYC_SERVER = "https://anchor.example.com/kyc"
ANCHOR_QUOTE_SERVER = "https://anchor.example.com/sep38"
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"

[DOCUMENTATION]
ORG_NAME = "Example Anchor"
`;

function statusOf(source: string, id: string): CorridorStatus {
  const node = buildCorridorGraph({ source }).nodes.find((candidate) => candidate.id === id);
  return node?.status ?? 'missing';
}

describe('buildCorridorGraph', () => {
  it('lays the corridor out in the order money flows', () => {
    const graph = buildCorridorGraph({ source: FULL_ANCHOR });
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'wallet',
      'sep10',
      'sep12',
      'sep38',
      'anchor',
      'ledger',
    ]);
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      'wallet->sep10',
      'sep10->sep12',
      'sep12->sep38',
      'sep38->anchor',
      'anchor->ledger',
    ]);
  });

  it('marks every stage of a complete anchor green', () => {
    const graph = buildCorridorGraph({ source: FULL_ANCHOR });
    for (const node of graph.nodes) {
      expect(node.status, `${node.id} should be ok`).toBe('ok');
    }
    expect(graph.summary).toEqual({ ok: 6, missing: 0, misconfigured: 0, brokenBridges: 0 });
  });

  it('names the anchor legs the file actually declares', () => {
    const graph = buildCorridorGraph({ source: FULL_ANCHOR });
    const anchor = graph.nodes.find((node) => node.id === 'anchor');
    expect(anchor?.protocols).toEqual(['SEP-24']);
    expect(anchor?.label).toBe('SEP-24 Anchor');
  });

  it('labels the wallet from ORG_NAME', () => {
    const graph = buildCorridorGraph({ source: FULL_ANCHOR });
    expect(graph.nodes[0]?.label).toBe('Example Anchor');
  });

  it('reports the line each bridge is declared on', () => {
    const graph = buildCorridorGraph({ source: FULL_ANCHOR });
    expect(findKeyLine(FULL_ANCHOR, 'WEB_AUTH_ENDPOINT')).toBe(4);
    expect(graph.nodes.find((node) => node.id === 'sep10')?.line).toBe(4);
    expect(graph.nodes.find((node) => node.id === 'sep38')?.line).toBe(6);
  });

  it('highlights a corridor with no services as four missing bridges', () => {
    const graph = buildCorridorGraph({ source: 'VERSION = "1.0.0"\n' });
    expect(statusOf('VERSION = "1.0.0"\n', 'wallet')).toBe('ok');
    expect(statusOf('VERSION = "1.0.0"\n', 'sep10')).toBe('missing');
    expect(statusOf('VERSION = "1.0.0"\n', 'sep12')).toBe('missing');
    expect(statusOf('VERSION = "1.0.0"\n', 'sep38')).toBe('missing');
    expect(statusOf('VERSION = "1.0.0"\n', 'anchor')).toBe('missing');
    // A wallet without HORIZON_URL is normal: the public network is the default.
    expect(statusOf('VERSION = "1.0.0"\n', 'ledger')).toBe('ok');
    expect(graph.summary.missing).toBe(4);
    expect(graph.summary.brokenBridges).toBe(5);
  });

  it('marks an http endpoint misconfigured rather than missing', () => {
    const source = `VERSION = "1.0.0"
WEB_AUTH_ENDPOINT = "http://anchor.example.com/auth"
`;
    const node = buildCorridorGraph({ source }).nodes.find((candidate) => candidate.id === 'sep10');
    expect(node?.status).toBe('misconfigured');
    expect(node?.detail).toContain('https://');
    expect(node?.severity).toBe('error');
  });

  it('flags a trailing slash, which would break client sub-routes', () => {
    const source = `VERSION = "1.0.0"
ANCHOR_QUOTE_SERVER = "https://anchor.example.com/sep38/"
`;
    const node = buildCorridorGraph({ source }).nodes.find((candidate) => candidate.id === 'sep38');
    expect(node?.status).toBe('misconfigured');
    expect(node?.detail).toContain('Trailing slash');
  });

  it('fails the auth bridge when an authenticated leg has no WEB_AUTH_ENDPOINT', () => {
    const source = `VERSION = "1.0.0"
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"
`;
    const graph = buildCorridorGraph({ source });
    // SEP-24 is authenticated: the anchor is configured, but the bridge to it is not.
    expect(graph.nodes.find((node) => node.id === 'anchor')?.status).toBe('ok');
    const sep10 = graph.nodes.find((node) => node.id === 'sep10');
    expect(sep10?.status).toBe('misconfigured');
    expect(sep10?.detail).toContain('WEB_AUTH_ENDPOINT');
    expect(graph.edges.find((edge) => edge.id === 'sep10->sep12')?.status).not.toBe('ok');
  });

  it('fails the SEP-31 leg when KYC is not declared', () => {
    const source = `VERSION = "1.0.0"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
DIRECT_PAYMENT_SERVER = "https://anchor.example.com/sep31"
`;
    const anchor = buildCorridorGraph({ source }).nodes.find(
      (candidate) => candidate.id === 'anchor',
    );
    expect(anchor?.status).toBe('misconfigured');
    expect(anchor?.detail).toContain('KYC_SERVER');
    expect(anchor?.protocols).toEqual(['SEP-31']);
  });

  it('turns a stage red when the linter reports an error against its field', () => {
    const graph = buildCorridorGraph({
      source: FULL_ANCHOR,
      diagnostics: [
        {
          rule: 'network/trailing-slash',
          severity: 'error',
          message: 'ANCHOR_QUOTE_SERVER ends with a slash.',
          path: 'ANCHOR_QUOTE_SERVER',
        },
      ],
    });
    const node = graph.nodes.find((candidate) => candidate.id === 'sep38');
    expect(node?.status).toBe('misconfigured');
    expect(node?.detail).toBe('ANCHOR_QUOTE_SERVER ends with a slash.');
  });

  it('cites the failed range on a broken edge', () => {
    const graph = buildCorridorGraph({ source: 'VERSION = "1.0.0"\n' });
    const edge = graph.edges.find((candidate) => candidate.id === 'sep10->sep12');
    expect(edge?.status).toBe('missing');
    expect(edge?.detail).toContain('SEP-10 Auth');
    expect(edge?.detail).toContain('SEP-12 KYC');
  });

  it('survives an unparseable file instead of throwing', () => {
    const graph = buildCorridorGraph({ source: 'this is not = = toml\n' });
    expect(graph.nodes).toHaveLength(6);
    expect(graph.summary.ok).toBe(2); // wallet and the defaulted ledger
  });
});

describe('toCytoscapeElements', () => {
  it('carries health as a class Cytoscape can style red', () => {
    const graph = buildCorridorGraph({ source: 'VERSION = "1.0.0"\n' });
    const elements = toCytoscapeElements(graph);

    const sep10 = elements.find((element) => element.data.id === 'sep10');
    expect(sep10?.classes).toContain('missing');
    expect(sep10?.data.line).toBeUndefined();

    const wallet = elements.find((element) => element.data.id === 'wallet');
    expect(wallet?.classes).toContain('ok');
  });

  it('emits one edge element per bridge with source and target', () => {
    const graph = buildCorridorGraph({ source: FULL_ANCHOR });
    const elements = toCytoscapeElements(graph);
    const edges = elements.filter((element) => element.classes.includes('bridge'));
    expect(edges).toHaveLength(5);
    expect(edges[0]?.data).toMatchObject({
      id: 'wallet->sep10',
      source: 'wallet',
      target: 'sep10',
    });
  });

  it('labels a broken bridge for a tooltip', () => {
    const graph = buildCorridorGraph({ source: 'VERSION = "1.0.0"\n' });
    const broken = toCytoscapeElements(graph).find((element) => element.data.id === 'sep10->sep12');
    expect(broken?.data.label).toBe('broken');
  });
});
