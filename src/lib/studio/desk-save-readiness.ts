type SavedGraphNode = { id: string; kind?: string };

/**
 * A desk row is created before its canvas node is saved. Keep that node's
 * context preview pending until an acknowledged board snapshot contains the
 * matching desk node. The input Set is never mutated so React can use object
 * identity to avoid a redundant render when an unrelated graph save lands.
 */
export function reconcilePendingDeskNodeIds(
  pending: Set<string>,
  savedNodes: readonly SavedGraphNode[],
): Set<string> {
  let next: Set<string> | null = null;
  for (const node of savedNodes) {
    if (node.kind !== 'desk' || !pending.has(node.id)) continue;
    next ??= new Set(pending);
    next.delete(node.id);
  }
  return next ?? pending;
}

/** Recovery may contain a desk node that the acknowledged server graph has
 * never seen. Treat it exactly like a freshly created desk until the recovery
 * graph itself receives a save receipt. */
export function recoveredPendingDeskNodeIds(
  savedNodes: readonly SavedGraphNode[],
  recoveredNodes: readonly SavedGraphNode[],
): Set<string> {
  const savedDeskIds = new Set(savedNodes.filter((node) => node.kind === 'desk').map((node) => node.id));
  return new Set(
    recoveredNodes
      .filter((node) => node.kind === 'desk' && !savedDeskIds.has(node.id))
      .map((node) => node.id),
  );
}

export function pruneRemovedPendingDeskNodeIds(
  pending: Set<string>,
  removedNodeIds: ReadonlySet<string>,
): Set<string> {
  if (![...removedNodeIds].some((id) => pending.has(id))) return pending;
  const next = new Set(pending);
  for (const id of removedNodeIds) next.delete(id);
  return next;
}
