/**
 * PR Gate
 *
 * Controls PR opening based on QA results and policy checks.
 * Ensures PRs only open after quality gates pass.
 */

import type { PRGateConfig, PRGateResult, QAResult, PolicyCheckResult } from "./types.js";

export class PRGate {
  private config: PRGateConfig;

  constructor(config: Partial<PRGateConfig> = {}) {
    this.config = {
      requireQAPass: config.requireQAPass !== false,
      requirePolicyCheck: config.requirePolicyCheck !== false,
      autoMergeOnPass: config.autoMergeOnPass || false,
      requiredApprovals: config.requiredApprovals || 1,
      blockOnPolicyViolation: config.blockOnPolicyViolation !== false,
    };
  }

  /**
   * Check if a task can open a PR
   */
  canOpenPR(options: {
    qaResult?: QAResult;
    policyResult?: PolicyCheckResult;
    approvals?: number;
  }): PRGateResult {
    const reasons: string[] = [];
    let canOpen = true;

    // Check QA pass requirement
    if (this.config.requireQAPass) {
      if (!options.qaResult) {
        reasons.push("QA result required but not provided");
        canOpen = false;
      } else if (options.qaResult.verdict !== "PASS") {
        reasons.push(`QA did not pass: ${options.qaResult.verdict}`);
        canOpen = false;
      }
    }

    // Check policy requirement
    if (this.config.requirePolicyCheck) {
      if (!options.policyResult) {
        reasons.push("Policy check required but not provided");
        canOpen = false;
      } else if (!options.policyResult.passed) {
        if (this.config.blockOnPolicyViolation || options.policyResult.blocked) {
          reasons.push(`Policy check failed: ${options.policyResult.violations.length} violations`);
          canOpen = false;
        } else {
          reasons.push(
            `Policy check has warnings: ${options.policyResult.violations.length} issues`,
          );
        }
      }
    }

    // Check approval requirement
    if (options.approvals !== undefined) {
      if (options.approvals < this.config.requiredApprovals) {
        reasons.push(
          `Insufficient approvals: ${options.approvals}/${this.config.requiredApprovals} required`,
        );
        canOpen = false;
      }
    }

    return {
      canOpen,
      reasons,
      qaPassed: options.qaResult?.verdict === "PASS",
      policyPassed: options.policyResult?.passed,
      approvalsMet:
        options.approvals !== undefined && options.approvals >= this.config.requiredApprovals,
    };
  }

  /**
   * Update gate configuration
   */
  updateConfig(config: Partial<PRGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): PRGateConfig {
    return { ...this.config };
  }
}
