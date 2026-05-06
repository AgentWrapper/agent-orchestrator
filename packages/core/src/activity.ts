import type { SessionStatus } from "./types.js";

export type ActivityEvent =
  | { type: "status_change"; sessionId: string; from: SessionStatus; to: SessionStatus; ts: number }
  | { type: "message_sent"; sessionId: string; message: string; ts: number }
  | { type: "tool_call"; sessionId: string; tool: string; args?: string; ts: number }
  | { type: "ci_result"; sessionId: string; status: "pass" | "fail"; checkName: string; ts: number }
  | { type: "review_comment"; sessionId: string; body: string; author: string; ts: number };

export class ActivityLog {
  private readonly capacity: number;
  private readonly buffer: ActivityEvent[] = [];

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  push(event: ActivityEvent): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(event);
  }

  getAll(): ActivityEvent[] {
    return [...this.buffer];
  }

  getBySession(sessionId: string): ActivityEvent[] {
    return this.buffer.filter((e) => e.sessionId === sessionId);
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

export const activityLog = new ActivityLog();
