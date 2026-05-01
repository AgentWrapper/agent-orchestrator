import type { FileNode } from "@/app/api/sessions/[id]/files/route";

type GitStatus = "M" | "A" | "D" | "?" | "R";

export function filterTreeToChanged(
  nodes: FileNode[],
  gitStatus: Record<string, GitStatus>,
): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      if (gitStatus[node.path]) {
        result.push(node);
      }
    } else if (node.children) {
      const filteredChildren = filterTreeToChanged(node.children, gitStatus);
      if (filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren });
      }
    }
  }
  return result;
}
