/**
 * Interactive DAG of a multi-party anchor payment corridor.
 *
 * The heavy lifting lives in `../corridor-graph.ts`; this component only has to
 * put it on screen. Cytoscape was chosen over a hand-rolled SVG because the
 * three things the issue asks for — zoom, pan, and a hit-testable node graph —
 * are its defaults rather than features to build, and because its element model
 * is plain JSON, which is what lets the model be tested without a DOM.
 *
 * Missing or misconfigured service bridges are drawn red by the stylesheet
 * (`node.missing`, `node.misconfigured`, `edge.missing`, `edge.misconfigured`).
 * Clicking a node calls `onSelectLine` so the host page can jump the editor to
 * the TOML line that declared the field.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import {
  buildCorridorGraph,
  toCytoscapeElements,
  type CorridorDiagnostic,
  type CorridorGraph,
  type CorridorNode,
} from '../corridor-graph.js';

/** Props for {@link CorridorVisualizer}. */
export interface CorridorVisualizerProps {
  /** The `stellar.toml` source text. */
  source: string;
  /** Linter findings; error-severity ones turn their stage red. */
  diagnostics?: readonly CorridorDiagnostic[];
  /** Serving domain, used to label the wallet when there is no ORG_NAME. */
  domain?: string;
  /** Called when a node is clicked, with the TOML line to jump to. */
  onSelectLine?: (line: number, node: CorridorNode) => void;
  /** Rendered height of the graph area. */
  height?: number;
}

const STYLESHEET: cytoscape.Stylesheet[] = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': 11,
      color: '#1f2328',
      'background-color': '#dafbe1',
      'border-width': 2,
      'border-color': '#1a7f37',
      width: 132,
      height: 46,
      shape: 'round-rectangle',
      'text-wrap': 'wrap',
      'text-max-width': '120px',
    },
  },
  {
    selector: 'node.stage-wallet',
    style: { shape: 'round-tag', 'background-color': '#ddf4ff', 'border-color': '#0969da' },
  },
  {
    selector: 'node.stage-ledger',
    style: { shape: 'hexagon', 'background-color': '#f3f0ff', 'border-color': '#6639ba' },
  },
  { selector: 'node.missing', style: { 'background-color': '#ffebe9', 'border-color': '#cf222e' } },
  {
    selector: 'node.misconfigured',
    style: { 'background-color': '#ffebe9', 'border-color': '#cf222e', 'border-style': 'dashed' },
  },
  {
    selector: 'edge',
    style: {
      width: 2,
      'line-color': '#1a7f37',
      'target-arrow-color': '#1a7f37',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'arrow-scale': 1,
    },
  },
  { selector: 'edge.missing', style: { 'line-color': '#cf222e', 'target-arrow-color': '#cf222e' } },
  {
    selector: 'edge.misconfigured',
    style: {
      'line-color': '#cf222e',
      'target-arrow-color': '#cf222e',
      'line-style': 'dashed',
    },
  },
  {
    // Only a broken bridge carries a label, so the graph stays quiet when the
    // corridor is healthy.
    selector: 'edge[label != ""]',
    style: {
      label: 'data(label)',
      'font-size': 9,
      color: '#cf222e',
      'text-background-color': '#ffffff',
      'text-background-opacity': 0.85,
    },
  },
];

export function CorridorVisualizer({
  source,
  diagnostics = [],
  domain,
  onSelectLine,
  height = 420,
}: CorridorVisualizerProps): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [selected, setSelected] = useState<CorridorNode | null>(null);

  // The model is derived data, so it is recomputed rather than stored.
  const graph: CorridorGraph = useMemo(
    () =>
      buildCorridorGraph({
        source,
        diagnostics,
        ...(domain === undefined ? {} : { domain }),
      }),
    [source, diagnostics, domain],
  );

  const elements = useMemo(() => toCytoscapeElements(graph), [graph]);

  // Keep the latest onSelectLine without re-creating the Cytoscape instance,
  // which would throw away the user's zoom and pan on every keystroke.
  const selectLine = useRef(onSelectLine);
  selectLine.current = onSelectLine;

  useEffect(() => {
    if (container.current === null) return undefined;

    const cy = cytoscape({
      container: container.current,
      elements,
      style: STYLESHEET,
      layout: { name: 'breadthfirst', directed: true, spacingFactor: 1.4, padding: 20 },
      // Zoom and pan are the point of the widget, so both stay on.
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      wheelSensitivity: 0.25,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (event: cytoscape.EventObject) => {
      const id = String(event.target.id()) as CorridorNode['id'];
      const node = graph.nodes.find((candidate) => candidate.id === id) ?? null;
      setSelected(node);
      if (node?.line !== undefined) selectLine.current?.(node.line, node);
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // Re-running on `graph` keeps the instance's element data in step with the
    // source; `graph` only changes when the source or diagnostics do.
  }, [graph, elements]);

  return (
    <div className="corridor-visualizer">
      <div className="corridor-visualizer__toolbar">
        <span className={`corridor-badge corridor-badge--${worstOf(graph)}`}>
          {graph.summary.brokenBridges === 0
            ? 'Corridor intact'
            : `${graph.summary.brokenBridges} broken bridge(s)`}
        </span>
        <button type="button" onClick={() => cyRef.current?.fit(undefined, 30)}>
          Fit
        </button>
        <button type="button" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.2)}>
          Zoom in
        </button>
        <button type="button" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() / 1.2)}>
          Zoom out
        </button>
      </div>

      <div className="corridor-visualizer__body">
        <div
          ref={container}
          className="corridor-visualizer__canvas"
          style={{ height }}
          role="img"
          aria-label="Payment corridor directed acyclic graph"
        />

        <aside className="corridor-visualizer__inspector" aria-live="polite">
          {selected === null ? (
            <p className="corridor-visualizer__hint">
              Select a stage to see which fields wire it up and where they are declared.
            </p>
          ) : (
            <>
              <h3>{selected.label}</h3>
              <p className={`corridor-status corridor-status--${selected.status}`}>
                {selected.status}
                {selected.line === undefined ? '' : ` · line ${selected.line}`}
              </p>
              <p>{selected.detail}</p>
              <ul>
                {selected.bridges.map((bridge) => (
                  <li
                    key={bridge.key}
                    className={`corridor-bridge corridor-bridge--${bridge.status}`}
                  >
                    <code>{bridge.key}</code>
                    {bridge.value === undefined ? null : <span> = {bridge.value}</span>}
                    {bridge.reason === undefined ? null : (
                      <em className="corridor-bridge__reason">{bridge.reason}</em>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The status the toolbar badge should mirror. */
function worstOf(graph: CorridorGraph): 'ok' | 'missing' | 'misconfigured' {
  if (graph.summary.misconfigured > 0) return 'misconfigured';
  if (graph.summary.missing > 0) return 'missing';
  return 'ok';
}

export default CorridorVisualizer;
