/**
 * AgentMesh Page
 *
 * Main page for the AgentMesh coordination layer.
 * Shows the task board. The per-task QA loop status is surfaced from a
 * selected task inside the board itself — there is no global "current task",
 * so we do not render QALoopStatus with a hardcoded task id here.
 */

import TaskBoard from "@/components/TaskBoard";

export default function AgentMeshPage() {
  return (
    <div className="h-full p-4">
      <TaskBoard />
    </div>
  );
}
