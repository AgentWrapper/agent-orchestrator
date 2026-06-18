/**
 * Policy Engine
 *
 * Validates code changes against configurable policy rules.
 * Blocks dangerous changes before PR creation.
 */

import type { PolicyRule, PolicyContext, PolicyViolation, PolicyCheckResult } from "./types.js";

export class PolicyEngine {
  private rules: Map<string, PolicyRule>;

  constructor() {
    this.rules = new Map();
    this.initializeDefaultRules();
  }

  private initializeDefaultRules(): void {
    // Rule: No hardcoded secrets
    this.addRule({
      id: "no-hardcoded-secrets",
      name: "No Hardcoded Secrets",
      description: "Prevent hardcoded API keys, passwords, or tokens",
      severity: "error",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        // Common secret patterns
        const secretPatterns = [
          /api[_-]?key\s*[:=]\s*['"][\w-]{20,}['"]/gi,
          /password\s*[:=]\s*['"][\w-]{8,}['"]/gi,
          /token\s*[:=]\s*['"][\w-]{20,}['"]/gi,
          /secret\s*[:=]\s*['"][\w-]{20,}['"]/gi,
        ];

        // Check each pattern against the diff
        for (const pattern of secretPatterns) {
          const matches = diff.match(pattern);
          if (matches) {
            matches.forEach((match) => {
              violations.push({
                ruleId: "no-hardcoded-secrets",
                message: `Potential hardcoded secret detected: ${match.substring(0, 20)}...`,
                severity: "error",
              });
            });
          }
        }

        return violations;
      },
    });

    // Rule: No console.log in production code
    this.addRule({
      id: "no-console-log",
      name: "No Console Logs",
      description: "Prevent console.log statements in production code",
      severity: "warning",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];
        const consoleLogPattern = /console\.(log|debug|info|warn|error)\(/g;

        const matches = diff.match(consoleLogPattern);
        if (matches) {
          violations.push({
            ruleId: "no-console-log",
            message: `Found ${matches.length} console statement(s) that should be removed`,
            severity: "warning",
          });
        }

        return violations;
      },
    });

    // Rule: Require tests for new features
    this.addRule({
      id: "require-tests",
      name: "Require Tests",
      description: "Ensure new features include test coverage",
      severity: "warning",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        // Check if source files were modified
        const hasSourceChanges = /\.(ts|js|tsx|jsx)$/.test(diff);

        // Check if test files were added/modified
        const hasTestChanges = /\.(test\.|spec\.)/.test(diff);

        if (hasSourceChanges && !hasTestChanges) {
          violations.push({
            ruleId: "require-tests",
            message: "Source code changes detected but no test changes found",
            severity: "warning",
          });
        }

        return violations;
      },
    });

    // Rule: Block destructive operations
    this.addRule({
      id: "no-destructive-ops",
      name: "No Destructive Operations",
      description: "Block dangerous file operations like rm -rf",
      severity: "error",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        const dangerousPatterns = [
          /rm\s+-rf/g,
          /rm\s+-fr/g,
          /del\s+\/[sS]/g,
          /drop\s+table/gi,
          /truncate\s+table/gi,
        ];

        for (const pattern of dangerousPatterns) {
          const matches = diff.match(pattern);
          if (matches) {
            matches.forEach((match) => {
              violations.push({
                ruleId: "no-destructive-ops",
                message: `Dangerous operation detected: ${match}`,
                severity: "error",
              });
            });
          }
        }

        return violations;
      },
    });

    // Rule: SQL Injection Prevention
    this.addRule({
      id: "no-sql-injection",
      name: "No SQL Injection",
      description: "Prevent SQL injection vulnerabilities in database queries",
      severity: "error",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        const sqlInjectionPatterns = [
          /query\s*\(\s*['"`]\s*\$\{/g, // Template literals in queries
          /execute\s*\(\s*['"`]\s*\+/g, // String concatenation in queries
          /SELECT.*FROM.*WHERE.*=.*['"`]\s*\$/gi, // Direct variable interpolation
        ];

        for (const pattern of sqlInjectionPatterns) {
          const matches = diff.match(pattern);
          if (matches) {
            matches.forEach((match) => {
              violations.push({
                ruleId: "no-sql-injection",
                message: `Potential SQL injection vulnerability: ${match.substring(0, 30)}...`,
                severity: "error",
              });
            });
          }
        }

        return violations;
      },
    });

    // Rule: XSS Prevention
    this.addRule({
      id: "no-xss-vulnerability",
      name: "No XSS Vulnerabilities",
      description: "Prevent cross-site scripting vulnerabilities",
      severity: "error",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        const xssPatterns = [
          /innerHTML\s*=\s*\$\{/g, // Template literal in innerHTML
          /innerHTML\s*=\s*\+/g, // String concatenation in innerHTML
          /document\.write\s*\(\s*\$\{/g, // Template literal in document.write
          /eval\s*\(\s*\$\{/g, // Template literal in eval
        ];

        for (const pattern of xssPatterns) {
          const matches = diff.match(pattern);
          if (matches) {
            matches.forEach((match) => {
              violations.push({
                ruleId: "no-xss-vulnerability",
                message: `Potential XSS vulnerability: ${match.substring(0, 30)}...`,
                severity: "error",
              });
            });
          }
        }

        return violations;
      },
    });

    // Rule: No Synchronous Operations
    this.addRule({
      id: "no-sync-operations",
      name: "No Synchronous Operations",
      description: "Prevent synchronous file/network operations that block the event loop",
      severity: "warning",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        const syncPatterns = [
          /readFileSync/g,
          /writeFileSync/g,
          /existsSync/g,
          /execSync/g,
          /spawnSync/g,
        ];

        for (const pattern of syncPatterns) {
          const matches = diff.match(pattern);
          if (matches) {
            violations.push({
              ruleId: "no-sync-operations",
              message: `Synchronous operation detected: ${matches[0]}. Use async version instead.`,
              severity: "warning",
            });
          }
        }

        return violations;
      },
    });

    // Rule: Accessibility - Alt Text
    this.addRule({
      id: "require-alt-text",
      name: "Require Alt Text",
      description: "Ensure all images have alt text for accessibility",
      severity: "warning",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        // Check for img tags without alt attribute
        const imgPattern = /<img(?![^>]*\balt\s*=)/gi;
        const matches = diff.match(imgPattern);

        if (matches) {
          violations.push({
            ruleId: "require-alt-text",
            message: `Found ${matches.length} image(s) without alt text`,
            severity: "warning",
          });
        }

        return violations;
      },
    });

    // Rule: Accessibility - ARIA Labels
    this.addRule({
      id: "require-aria-labels",
      name: "Require ARIA Labels",
      description: "Ensure interactive elements have ARIA labels for accessibility",
      severity: "info",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        // Check for buttons without aria-label or text content
        const buttonPattern =
          /<button(?![^>]*(aria-label|aria-labelledby|>[\s\S]{0,50}<\/button>))/gi;
        const matches = diff.match(buttonPattern);

        if (matches) {
          violations.push({
            ruleId: "require-aria-labels",
            message: `Found ${matches.length} button(s) that may need ARIA labels`,
            severity: "info",
          });
        }

        return violations;
      },
    });

    // Rule: No TODO Comments
    this.addRule({
      id: "no-todo-comments",
      name: "No TODO Comments",
      description: "Prevent TODO comments in committed code",
      severity: "warning",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        const todoPattern = /TODO|FIXME|HACK|XXX/gi;
        const matches = diff.match(todoPattern);

        if (matches) {
          violations.push({
            ruleId: "no-todo-comments",
            message: `Found ${matches.length} TODO/FIXME comment(s) that should be addressed`,
            severity: "warning",
          });
        }

        return violations;
      },
    });

    // Rule: No Magic Numbers
    this.addRule({
      id: "no-magic-numbers",
      name: "No Magic Numbers",
      description: "Prevent magic numbers, use named constants instead",
      severity: "info",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        // Match numbers that aren't 0, 1, or common small values
        const magicNumberPattern = /[^a-zA-Z0-9_](?!0|1|2|10|100|1000)\d{2,}(?![a-zA-Z])/g;
        const matches = diff.match(magicNumberPattern);

        if (matches && matches.length > 5) {
          // Only flag if many occurrences
          violations.push({
            ruleId: "no-magic-numbers",
            message: `Found ${matches.length} potential magic number(s). Consider using named constants.`,
            severity: "info",
          });
        }

        return violations;
      },
    });

    // Rule: Require Error Handling
    this.addRule({
      id: "require-error-handling",
      name: "Require Error Handling",
      description: "Ensure async operations have proper error handling",
      severity: "warning",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        // Check for await without try-catch
        const awaitPattern = /await\s+[a-zA-Z_$][a-zA-Z0-9_$]*/g;
        const matches = diff.match(awaitPattern);

        if (matches && matches.length > 3) {
          // Check if there's a try-catch nearby
          const hasTryCatch = /try\s*\{[\s\S]{0,500}catch/g.test(diff);

          if (!hasTryCatch) {
            violations.push({
              ruleId: "require-error-handling",
              message: `Found ${matches.length} await operations without error handling`,
              severity: "warning",
            });
          }
        }

        return violations;
      },
    });

    // Rule: No Hardcoded URLs
    this.addRule({
      id: "no-hardcoded-urls",
      name: "No Hardcoded URLs",
      description: "Prevent hardcoded URLs, use environment variables",
      severity: "warning",
      check: (diff, _context) => {
        const violations: PolicyViolation[] = [];

        const urlPattern = /https?:\/\/[^\s"'`<>]+/g;
        const matches = diff.match(urlPattern);

        if (matches) {
          // Filter out localhost and common documentation URLs
          const problematicUrls = matches.filter(
            (url) =>
              !url.includes("localhost") &&
              !url.includes("127.0.0.1") &&
              !url.includes("example.com"),
          );

          if (problematicUrls.length > 0) {
            violations.push({
              ruleId: "no-hardcoded-urls",
              message: `Found ${problematicUrls.length} hardcoded URL(s). Use environment variables.`,
              severity: "warning",
            });
          }
        }

        return violations;
      },
    });
  }

  addRule(rule: PolicyRule): void {
    this.rules.set(rule.id, rule);
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  getRule(ruleId: string): PolicyRule | null {
    return this.rules.get(ruleId) || null;
  }

  listRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Check a diff against all policy rules
   */
  check(diff: string, context: PolicyContext): PolicyCheckResult {
    const allViolations: PolicyViolation[] = [];
    let blocked = false;

    for (const rule of this.rules.values()) {
      try {
        const violations = rule.check(diff, context);
        allViolations.push(...violations);

        // Check if any error-level violations should block
        if (violations.some((v) => v.severity === "error")) {
          blocked = true;
        }
      } catch (error) {
        console.error(`Error running policy rule ${rule.id}:`, error);
      }
    }

    return {
      passed: allViolations.length === 0,
      violations: allViolations,
      blocked,
    };
  }

  /**
   * Check if a specific rule would block
   */
  wouldBlock(ruleId: string, diff: string, context: PolicyContext): boolean {
    const rule = this.getRule(ruleId);
    if (!rule) return false;

    if (rule.severity !== "error") return false;

    const violations = rule.check(diff, context);
    return violations.length > 0;
  }
}
