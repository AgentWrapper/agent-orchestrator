import { describe, it, expect } from "vitest";
import { findLCA, type NaryNode } from "../nary-lca.js";

// Helper to build a node quickly.
function node(val: number, ...children: NaryNode[]): NaryNode {
  return { val, children };
}

// Tree used in most tests:
//
//         1
//       / | \
//      2  3  4
//     / \
//    5   6
//
const tree = node(1, node(2, node(5), node(6)), node(3), node(4));

describe("findLCA", () => {
  it("returns the common ancestor of two leaf nodes", () => {
    // 5 and 6 are both children of 2
    const result = findLCA(tree, 5, 6);
    expect(result?.val).toBe(2);
  });

  it("returns the ancestor when one node is an ancestor of the other", () => {
    // 2 is a direct ancestor of 5
    const result = findLCA(tree, 2, 5);
    expect(result?.val).toBe(2);
  });

  it("returns the root when targets are in different subtrees far from root", () => {
    // 5 is under 2, 3 is a direct child of root 1
    const result = findLCA(tree, 5, 3);
    expect(result?.val).toBe(1);
  });

  it("returns the root when both nodes are direct children of root", () => {
    const result = findLCA(tree, 2, 4);
    expect(result?.val).toBe(1);
  });

  it("returns the node itself when val1 === val2", () => {
    const result = findLCA(tree, 6, 6);
    expect(result?.val).toBe(6);
  });

  it("returns null when val1 is not in the tree", () => {
    const result = findLCA(tree, 99, 3);
    expect(result).toBeNull();
  });

  it("returns null when val2 is not in the tree", () => {
    const result = findLCA(tree, 2, 99);
    expect(result).toBeNull();
  });

  it("returns null when both values are absent", () => {
    const result = findLCA(tree, 88, 99);
    expect(result).toBeNull();
  });

  it("returns null for a null root", () => {
    expect(findLCA(null, 1, 2)).toBeNull();
  });

  it("returns the single node when it matches val1 in a single-node tree", () => {
    const single = node(42);
    expect(findLCA(single, 42, 42)?.val).toBe(42);
  });

  it("returns null when single-node tree does not contain either value", () => {
    const single = node(42);
    expect(findLCA(single, 1, 2)).toBeNull();
  });
});
