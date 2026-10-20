# stellar.toml corridor playground

Interactive web playground for [`stellar-toml-lint`](../../README.md), built around the payment
corridor DAG visualizer.

## What it shows

A cross-border payment is a chain of parties: a wallet authenticates (SEP-10), passes KYC (SEP-12),
asks for a quote (SEP-38), hands funds to an anchor that speaks SEP-6, SEP-24, or SEP-31, and
settles on the Stellar ledger. Each hop exists only because a field in `stellar.toml` wires it up,
and each of those fields is individually optional — so the interesting failures are _relationships_.

```
User Wallet → SEP-10 Auth → SEP-12 KYC → SEP-38 Quote → SEP-6/24/31 Anchor → Horizon Ledger
```

The visualizer draws that chain and marks every stage:

- **green** — the stage’s endpoints are declared and usable;
- **red (solid)** — missing: the stage has no endpoint at all;
- **red (dashed)** — misconfigured: the endpoint is present but wrong (`http://`, a trailing slash,
  an unparseable URL), or a cross-field rule says the corridor cannot work.

Two cross-field rules are called out because no single-field check can see them:

- an authenticated leg (SEP-12, SEP-24, SEP-31, SEP-38) declared with **no `WEB_AUTH_ENDPOINT`** —
  the anchor is configured, but nothing can authenticate to it;
- **`DIRECT_PAYMENT_SERVER` (SEP-31) with no `KYC_SERVER`** — the sender’s customer has nowhere to
  be sent.

Clicking a node jumps the source pane to the line that declared the field, and the inspector lists
every bridge on that stage with the reason it is not healthy.

## Run it

```bash
cd apps/playground
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/, servable from any host or file://
npm test           # the corridor model tests (no browser needed)
```

The page lints with `stellar-toml-lint/browser`, so it works offline and never sends the file
anywhere.

## How it is put together

| File                                    | Role                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `src/corridor-graph.ts`                 | The model. Pure data in, pure data out — no React, no Cytoscape.          |
| `src/components/CorridorVisualizer.tsx` | The renderer. Turns the model into Cytoscape elements and handles clicks. |
| `test/corridor-graph.test.ts`           | Pins the model down: stage order, statuses, line numbers, broken bridges. |

Keeping the model framework-free is what makes it testable: `toCytoscapeElements(graph)` is asserted
directly, so the health classes Cytoscape styles into red are covered without a DOM.
