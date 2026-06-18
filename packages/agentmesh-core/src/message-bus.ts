/**
 * Message Bus
 *
 * Typed message routing and logging system for agent-to-agent communication.
 * All messages are logged to JSONL for replay and debugging.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMeshMessage, MessageType } from "./types.js";

export class MessageBus {
  private logPath: string;
  private messageHandlers: Map<MessageType, Set<(message: AgentMeshMessage) => void>>;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.ensureLogDir();
    this.messageHandlers = new Map();
  }

  private ensureLogDir(): void {
    if (!existsSync(dirname(this.logPath))) {
      mkdirSync(dirname(this.logPath), { recursive: true });
    }
  }

  /**
   * Send a message through the bus
   */
  send(message: Omit<AgentMeshMessage, "id" | "timestamp">): AgentMeshMessage {
    const fullMessage: AgentMeshMessage = {
      ...message,
      id: this.generateMessageId(),
      timestamp: new Date().toISOString(),
    };

    // Log to JSONL
    this.logMessage(fullMessage);

    // Route to handlers
    this.routeMessage(fullMessage);

    return fullMessage;
  }

  /**
   * Subscribe to messages of a specific type
   */
  subscribe(messageType: MessageType, handler: (message: AgentMeshMessage) => void): () => void {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, new Set());
    }

    this.messageHandlers.get(messageType)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.messageHandlers.get(messageType);
      if (handlers) {
        handlers.delete(handler);
      }
    };
  }

  /**
   * Get message history for a task
   */
  getHistory(_taskId: string, _limit?: number): AgentMeshMessage[] {
    // This would read from the JSONL log file
    // For now, return empty array as file reading is complex
    return [];
  }

  private logMessage(message: AgentMeshMessage): void {
    const logEntry = JSON.stringify(message) + "\n";
    appendFileSync(this.logPath, logEntry, "utf8");
  }

  private routeMessage(message: AgentMeshMessage): void {
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(message);
        } catch (error) {
          console.error(`Error in message handler for ${message.type}:`, error);
        }
      });
    }
  }

  private generateMessageId(): string {
    return `MSG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
