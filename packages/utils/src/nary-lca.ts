export interface NaryNode {
  val: number;
  children: NaryNode[];
}

/**
 * Finds the Lowest Common Ancestor (LCA) of two nodes in an n-ary tree.
 *
 * Returns null if either target value is absent from the tree.
 * A node is considered its own ancestor (if one target is an ancestor of the
 * other, that ancestor node is returned).
 *
 * Uses post-order DFS: children are visited before the current node is
 * evaluated, so a deeper match surfaces before its ancestor is inspected.
 */
export function findLCA(
  root: NaryNode | null,
  val1: number,
  val2: number,
): NaryNode | null {
  let found1 = false;
  let found2 = false;

  function dfs(node: NaryNode | null): NaryNode | null {
    if (node === null) return null;

    // Post-order: recurse into all children first so that a target node's
    // subtree is fully searched before we process the target node itself.
    const hits: NaryNode[] = [];
    for (const child of node.children) {
      const result = dfs(child);
      if (result !== null) hits.push(result);
    }

    const isTarget = node.val === val1 || node.val === val2;
    if (node.val === val1) found1 = true;
    if (node.val === val2) found2 = true;

    if (isTarget) {
      // This node is one of the targets. Return it regardless of what surfaced
      // from children — if the other target was in the subtree, this node is
      // the LCA; if not, this node is just the "found" signal propagating up.
      return node;
    }

    if (hits.length >= 2) {
      // Two distinct targets surfaced from different children — this node is
      // the LCA.
      return node;
    }

    return hits[0] ?? null;
  }

  const candidate = dfs(root);

  if (!found1 || !found2) return null;

  return candidate;
}
