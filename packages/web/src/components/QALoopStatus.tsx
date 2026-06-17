/**
 * QALoopStatus Component
 * 
 * Visual representation of the QA loop state for a task.
 * Shows the current state, retry count, and recent QA results.
 */

"use client";

import { useState, useEffect } from "react";

interface QALoopState {
  taskId: string;
  state: "idle" | "building" | "qa_running" | "qa_passed" | "qa_failed" | "rework" | "blocked" | "done";
  retryCount: number;
  maxRetries: number;
  lastQAResult?: QAResult;
  lastTransition?: string;
}

interface QAResult {
  verdict: "PASS" | "FAIL" | "BLOCKED";
  summary: string;
  findings: QAFinding[];
  score?: number;
  timestamp: string;
}

interface QAFinding {
  severity: "critical" | "major" | "minor" | "info";
  category: string;
  message: string;
  file?: string;
  line?: number;
  code?: string;
}

const STATE_CONFIG = {
  idle: { label: "Idle", color: "bg-gray-100", textColor: "text-gray-700", icon: "○" },
  building: { label: "Building", color: "bg-blue-100", textColor: "text-blue-700", icon: "🔨" },
  qa_running: { label: "QA Running", color: "bg-yellow-100", textColor: "text-yellow-700", icon: "🔍" },
  qa_passed: { label: "QA Passed", color: "bg-green-100", textColor: "text-green-700", icon: "✓" },
  qa_failed: { label: "QA Failed", color: "bg-red-100", textColor: "text-red-700", icon: "✗" },
  rework: { label: "Rework", color: "bg-orange-100", textColor: "text-orange-700", icon: "🔄" },
  blocked: { label: "Blocked", color: "bg-red-200", textColor: "text-red-800", icon: "🚫" },
  done: { label: "Done", color: "bg-purple-100", textColor: "text-purple-700", icon: "✓" },
};

const SEVERITY_COLORS = {
  critical: "bg-red-500 text-white",
  major: "bg-orange-500 text-white",
  minor: "bg-yellow-500 text-white",
  info: "bg-blue-500 text-white",
};

interface QALoopStatusProps {
  taskId: string;
}

export default function QALoopStatus({ taskId }: QALoopStatusProps) {
  const [qaState, setQaState] = useState<QALoopState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadQALoopState();
    const interval = setInterval(loadQALoopState, 3000);
    return () => clearInterval(interval);
  }, [taskId]);

  const loadQALoopState = async () => {
    try {
      // This would call the AgentMesh API
      // For now, use mock data
      const mockState: QALoopState = {
        taskId,
        state: "qa_running",
        retryCount: 1,
        maxRetries: 3,
        lastQAResult: {
          verdict: "FAIL",
          summary: "Found 2 critical issues and 1 major issue",
          findings: [
            {
              severity: "critical",
              category: "Security",
              message: "SQL injection vulnerability in user query",
              file: "src/api/users.ts",
              line: 45,
              code: "db.query(`SELECT * FROM users WHERE id = ${userId}`)", // eslint-disable-line no-template-curly-in-string
            },
            {
              severity: "critical",
              category: "Security",
              message: "Hardcoded API key in environment configuration",
              file: "src/config/api.ts",
              line: 12,
              code: "const API_KEY = 'sk-1234567890abcdef'",
            },
            {
              severity: "major",
              category: "Logic",
              message: "Missing null check in user validation",
              file: "src/utils/validation.ts",
              line: 23,
            },
          ],
          score: 45,
          timestamp: new Date(Date.now() - 300000).toISOString(),
        },
        lastTransition: new Date(Date.now() - 300000).toISOString(),
      };
      setQaState(mockState);
      setLoading(false);
    } catch (error) {
      console.error("Failed to load QA loop state:", error);
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-gray-500 text-sm">Loading QA status...</div>
      </div>
    );
  }

  if (!qaState) {
    return (
      <div className="text-gray-500 text-sm">No QA loop data available</div>
    );
  }

  const config = STATE_CONFIG[qaState.state];

  return (
    <div className="space-y-4">
      {/* Current State */}
      <div className={`${config.color} rounded-lg p-4`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{config.icon}</span>
            <div>
              <h3 className={`font-semibold ${config.textColor}`}>{config.label}</h3>
              <p className="text-xs text-gray-600">Task: {qaState.taskId}</p>
            </div>
          </div>
          {qaState.state === "rework" && (
            <div className="text-sm text-gray-600">
              Retry {qaState.retryCount}/{qaState.maxRetries}
            </div>
          )}
        </div>
      </div>

      {/* QA Result */}
      {qaState.lastQAResult && (
        <div className="bg-white border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold text-sm">Last QA Result</h4>
            <span
              className={`text-xs px-2 py-1 rounded ${
                qaState.lastQAResult.verdict === "PASS"
                  ? "bg-green-100 text-green-700"
                  : qaState.lastQAResult.verdict === "FAIL"
                  ? "bg-red-100 text-red-700"
                  : "bg-yellow-100 text-yellow-700"
              }`}
            >
              {qaState.lastQAResult.verdict}
            </span>
          </div>

          <p className="text-sm text-gray-700 mb-3">
            {qaState.lastQAResult.summary}
          </p>

          {qaState.lastQAResult.score && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-gray-600">Quality Score</span>
                <span className="font-semibold">{qaState.lastQAResult.score}/100</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className={`h-2 rounded-full ${
                    qaState.lastQAResult.score >= 80
                      ? "bg-green-500"
                      : qaState.lastQAResult.score >= 60
                      ? "bg-yellow-500"
                      : "bg-red-500"
                  }`}
                  style={{ width: `${qaState.lastQAResult.score}%` }}
                />
              </div>
            </div>
          )}

          {qaState.lastQAResult.findings.length > 0 && (
            <div>
              <h5 className="text-sm font-medium text-gray-700 mb-2">
                Findings ({qaState.lastQAResult.findings.length})
              </h5>
              <div className="space-y-2">
                {qaState.lastQAResult.findings.map((finding, index) => (
                  <div
                    key={index}
                    className="border rounded p-3 bg-gray-50"
                  >
                    <div className="flex items-start justify-between mb-1">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${SEVERITY_COLORS[finding.severity]}`}
                      >
                        {finding.severity.toUpperCase()}
                      </span>
                      <span className="text-xs text-gray-500">{finding.category}</span>
                    </div>
                    <p className="text-sm text-gray-700 mb-1">{finding.message}</p>
                    {finding.file && (
                      <div className="text-xs text-gray-500">
                        {finding.file}:{finding.line}
                      </div>
                    )}
                    {finding.code && (
                      <div className="mt-2 bg-gray-800 text-gray-100 p-2 rounded text-xs font-mono">
                        {finding.code}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 text-xs text-gray-500">
            {new Date(qaState.lastQAResult.timestamp).toLocaleString()}
          </div>
        </div>
      )}

      {/* Retry Progress */}
      {qaState.state === "rework" && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
          <h4 className="font-semibold text-sm text-orange-800 mb-2">
            Rework in Progress
          </h4>
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-orange-200 rounded-full h-2">
              <div
                className="bg-orange-500 h-2 rounded-full"
                style={{ width: `${(qaState.retryCount / qaState.maxRetries) * 100}%` }}
              />
            </div>
            <span className="text-sm text-orange-700">
              {qaState.retryCount}/{qaState.maxRetries}
            </span>
          </div>
          <p className="text-xs text-orange-600 mt-2">
            Agent is addressing QA findings. Will escalate if max retries exceeded.
          </p>
        </div>
      )}

      {/* Last Transition */}
      {qaState.lastTransition && (
        <div className="text-xs text-gray-500">
          Last transition: {new Date(qaState.lastTransition).toLocaleString()}
        </div>
      )}
    </div>
  );
}
