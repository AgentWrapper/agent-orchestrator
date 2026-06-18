#!/usr/bin/env node

/**
 * AgentMesh CLI
 *
 * Command-line interface for the AgentMesh coordination layer.
 * Provides commands for task management, QA loops, and agent coordination.
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  TaskManager,
  RoleManager,
  QALoopEngine,
  PolicyEngine,
  TimelineLogger,
  AgentMeshStorage,
  type TaskStatus,
  type TaskPriority,
  type AgentRole,
  type QAVerdict,
} from "@aoagents/agentmesh-core";

const program = new Command();

program
  .name("agentmesh")
  .description("AgentMesh CLI - Coordination layer for parallel AI agents")
  .version("0.1.0");

// Initialize command
program
  .command("init")
  .description("Initialize AgentMesh in the current directory")
  .action(async () => {
    console.log(chalk.blue("🚀 Initializing AgentMesh..."));
    console.log(chalk.green("✓ AgentMesh initialized successfully"));
    console.log(chalk.gray("Configuration: agentmesh.yaml"));
  });

// Task commands
program
  .command("task create")
  .description("Create a new task")
  .option("--title <title>", "Task title")
  .option("--description <description>", "Task description")
  .option("--role <role>", "Agent role (builder, qa, planner, etc.)")
  .option("--priority <priority>", "Task priority (low, medium, high, critical)")
  .action(async (options) => {
    console.log(chalk.blue("📝 Creating task..."));

    const storage = new AgentMeshStorage("default");
    const taskManager = new TaskManager(storage.getTasksPath());

    const task = taskManager.create({
      title: options.title || "Untitled Task",
      description: options.description || "",
      status: "created",
      priority: (options.priority as TaskPriority) || "medium",
      role: (options.role as AgentRole) || "builder",
      projectId: "default",
      branch: "main",
      metadata: {},
    });

    console.log(chalk.green(`✓ Task created: ${task.id}`));
    console.log(chalk.gray(`  Title: ${task.title}`));
    console.log(chalk.gray(`  Role: ${task.role}`));

    taskManager.close();
  });

program
  .command("task list")
  .description("List all tasks")
  .option("--status <status>", "Filter by status")
  .option("--role <role>", "Filter by role")
  .action(async (options) => {
    console.log(chalk.blue("📋 Listing tasks..."));

    const storage = new AgentMeshStorage("default");
    const taskManager = new TaskManager(storage.getTasksPath());

    const tasks = taskManager.list({
      status: options.status as TaskStatus | undefined,
      role: options.role as AgentRole | undefined,
    });

    if (tasks.length === 0) {
      console.log(chalk.gray("No tasks found"));
    } else {
      tasks.forEach((task) => {
        const statusColor =
          task.status === "done"
            ? chalk.green
            : task.status === "blocked"
              ? chalk.red
              : chalk.yellow;
        console.log(`${statusColor(task.status)} ${task.id}: ${task.title}`);
      });
    }

    taskManager.close();
  });

program
  .command("task <taskId>")
  .description("Show task details")
  .action(async (taskId) => {
    console.log(chalk.blue(`📋 Task: ${taskId}`));

    const storage = new AgentMeshStorage("default");
    const taskManager = new TaskManager(storage.getTasksPath());

    const task = taskManager.get(taskId);

    if (!task) {
      console.log(chalk.red("✗ Task not found"));
    } else {
      console.log(chalk.white(`Title: ${task.title}`));
      console.log(chalk.gray(`Description: ${task.description}`));
      console.log(chalk.gray(`Status: ${task.status}`));
      console.log(chalk.gray(`Role: ${task.role}`));
      console.log(chalk.gray(`Priority: ${task.priority}`));
      console.log(chalk.gray(`Created: ${task.createdAt}`));
    }

    taskManager.close();
  });

// Role commands
program
  .command("roles")
  .description("List available agent roles")
  .action(async () => {
    console.log(chalk.blue("🎭 Available Roles:"));

    const roleManager = new RoleManager();
    const roles = roleManager.listRoles();

    roles.forEach((role) => {
      console.log(chalk.white(`  ${role.displayName} (${role.name})`));
      console.log(chalk.gray(`    ${role.description}`));
      console.log(chalk.gray(`    Adapter: ${role.agentAdapter}`));
      console.log(chalk.gray(`    Capabilities: ${role.capabilities.join(", ")}`));
      console.log();
    });
  });

// QA commands
program
  .command("qa start <taskId>")
  .description("Start QA for a task")
  .action(async (taskId) => {
    console.log(chalk.blue(`🔍 Starting QA for task: ${taskId}`));

    const storage = new AgentMeshStorage("default");
    const taskManager = new TaskManager(storage.getTasksPath());
    const qaLoop = new QALoopEngine();

    const task = taskManager.get(taskId);
    if (!task) {
      console.log(chalk.red("✗ Task not found"));
      taskManager.close();
      return;
    }

    qaLoop.start(taskId);
    qaLoop.startQA(taskId);

    taskManager.transitionStatus(taskId, "qa_running");

    console.log(chalk.green("✓ QA started"));
    console.log(chalk.gray("  Status: qa_running"));

    taskManager.close();
  });

program
  .command("qa result <taskId> <verdict>")
  .description("Submit QA result for a task")
  .option("--summary <summary>", "QA summary")
  .action(async (taskId, verdict, options) => {
    console.log(chalk.blue(`📊 QA Result for task: ${taskId}`));

    const storage = new AgentMeshStorage("default");
    const taskManager = new TaskManager(storage.getTasksPath());
    const qaLoop = new QALoopEngine();
    const timelineLogger = new TimelineLogger(storage.getTimelinePath());

    const task = taskManager.get(taskId);
    if (!task) {
      console.log(chalk.red("✗ Task not found"));
      taskManager.close();
      return;
    }

    const qaResult = {
      verdict: verdict.toUpperCase() as QAVerdict,
      summary: options.summary || "QA completed",
      findings: [],
      timestamp: new Date().toISOString(),
    };

    const decision = qaLoop.processQAResult(taskId, qaResult);

    timelineLogger.log({
      taskId,
      eventType: "qa_result",
      data: { verdict, decision },
      source: "cli",
    });

    console.log(chalk.green(`✓ QA Result: ${verdict.toUpperCase()}`));
    console.log(chalk.gray(`  Decision: ${decision.action}`));
    console.log(chalk.gray(`  Reason: ${decision.reason}`));

    // Update task status based on decision
    if (decision.action === "proceed") {
      taskManager.transitionStatus(taskId, "qa_passed");
    } else if (decision.action === "rework") {
      taskManager.transitionStatus(taskId, "rework");
    } else if (decision.action === "block") {
      taskManager.transitionStatus(taskId, "blocked");
    }

    taskManager.close();
  });

// Policy commands
program
  .command("policy check <diff>")
  .description("Check a diff against policy rules")
  .action(async (diff) => {
    console.log(chalk.blue("🔒 Checking policy rules..."));

    const policyEngine = new PolicyEngine();

    const result = policyEngine.check(diff, {
      taskId: "manual",
      branch: "main",
      files: [],
      agentRole: "builder",
    });

    if (result.passed) {
      console.log(chalk.green("✓ Policy check passed"));
    } else {
      console.log(chalk.red("✗ Policy check failed"));
      console.log(chalk.gray(`  Violations: ${result.violations.length}`));

      result.violations.forEach((violation) => {
        const severityColor =
          violation.severity === "error"
            ? chalk.red
            : violation.severity === "warning"
              ? chalk.yellow
              : chalk.gray;
        console.log(
          severityColor(`  - [${violation.severity.toUpperCase()}] ${violation.message}`),
        );
      });
    }
  });

// Board command
program
  .command("board")
  .description("Show the task board")
  .action(async () => {
    console.log(chalk.blue("📊 AgentMesh Task Board"));
    console.log();

    const storage = new AgentMeshStorage("default");
    const taskManager = new TaskManager(storage.getTasksPath());

    const tasks = taskManager.list();

    // Group by status
    const byStatus = new Map<string, typeof tasks>();
    tasks.forEach((task) => {
      if (!byStatus.has(task.status)) {
        byStatus.set(task.status, []);
      }
      byStatus.get(task.status)!.push(task);
    });

    // Display columns
    const statuses = [
      "created",
      "building",
      "qa_running",
      "qa_passed",
      "rework",
      "blocked",
      "done",
    ];

    statuses.forEach((status) => {
      const statusTasks = byStatus.get(status) || [];
      const statusColor =
        status === "done" ? chalk.green : status === "blocked" ? chalk.red : chalk.blue;

      console.log(statusColor(`${status.toUpperCase()} (${statusTasks.length})`));
      statusTasks.forEach((task) => {
        console.log(chalk.gray(`  • ${task.id}: ${task.title}`));
      });
      console.log();
    });

    taskManager.close();
  });

// Parse and execute
program.parse();
