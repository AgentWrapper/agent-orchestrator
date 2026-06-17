/**
 * AgentMesh Page
 * 
 * Main page for AgentMesh coordination layer.
 * Shows the task board and QA loop status.
 */

import TaskBoard from "@/components/TaskBoard";
import QALoopStatus from "@/components/QALoopStatus";

export default function AgentMeshPage() {
  return (
    <div className="h-full flex">
      {/* Task Board - Left Side */}
      <div className="flex-1 border-r">
        <TaskBoard />
      </div>

      {/* QA Loop Status - Right Side */}
      <div className="w-96 p-4 bg-gray-50">
        <h2 className="text-lg font-semibold mb-4">QA Loop Status</h2>
        <QALoopStatus taskId="TASK-1" />
      </div>
    </div>
  );
}
