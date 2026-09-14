/**
 * A Studio graph is a set of rows, not an ordering contract. PostgREST reads
 * those rows in id order, while React Flow keeps its in-memory insertion
 * order. Canonicalizing only the persisted copy makes signatures stable across
 * save/reopen without mutating the live canvas arrays or their visual stacking.
 */
export function canonicalizeStudioPersistableGraph<
  NodeRow extends { id: string },
  EdgeRow extends { id: string },
>(graph: { nodes: NodeRow[]; edges: EdgeRow[] }): { nodes: NodeRow[]; edges: EdgeRow[] } {
  const byId = <Row extends { id: string }>(left: Row, right: Row) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return {
    nodes: [...graph.nodes].sort(byId),
    edges: [...graph.edges].sort(byId),
  };
}

type StoredStudioGraphRow = { id: string } & Record<string, unknown>;
export type StoredStudioGraph = {
  nodes: StoredStudioGraphRow[];
  edges: StoredStudioGraphRow[];
};

/** Normalize a graph read from browser storage without trusting its shape. */
export function canonicalizeStoredStudioGraph(value: unknown): StoredStudioGraph | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;
  const validRow = (row: unknown): row is StoredStudioGraphRow =>
    Boolean(row) && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string';
  if (!candidate.nodes.every(validRow) || !candidate.edges.every(validRow)) return null;
  return canonicalizeStudioPersistableGraph({ nodes: candidate.nodes, edges: candidate.edges });
}

/**
 * Version-1 recovery snapshots stored the base as JSON text. Normalize that
 * old insertion-ordered representation during upgrade so a valid unsaved edit
 * is not stranded when the new backend reloads the same rows in id order.
 */
export function canonicalizeStoredStudioGraphSignature(signature: string): string | null {
  try {
    const graph = canonicalizeStoredStudioGraph(JSON.parse(signature));
    return graph ? JSON.stringify(graph) : null;
  } catch {
    return null;
  }
}

/**
 * Finalization is checked after the materialization-receipt await. A graph can
 * change while that request is in flight; clearing browser recovery is safe
 * only when no caller requested another drain and the newest graph is still
 * the exact graph confirmed by the server.
 */
export function canFinalizeStudioSave(
  latest: { boardId: string; sig: string } | null,
  boardId: string,
  confirmedSig: string | null,
  saveRequestedDuringReceipt: boolean,
): boolean {
  return (
    !saveRequestedDuringReceipt
    && confirmedSig !== null
    && latest?.boardId === boardId
    && latest.sig === confirmedSig
  );
}
