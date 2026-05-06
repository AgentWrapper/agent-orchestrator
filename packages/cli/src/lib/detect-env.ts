import { git, gh, execSilent } from "./shell.js";
import { detectDefaultBranch } from "./git-utils.js";
import { extractOwnerRepo } from "./repo-utils.js";

export interface EnvironmentInfo {
  isGitRepo: boolean;
  gitRemote: string | null;
  ownerRepo: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  hasTmux: boolean;
  hasGh: boolean;
  ghAuthed: boolean;
  hasLinearKey: boolean;
  hasSlackWebhook: boolean;
}

export async function detectEnvironment(workingDir: string): Promise<EnvironmentInfo> {
  // Check if in git repo
  const isGitRepo = (await git(["rev-parse", "--git-dir"], workingDir)) !== null;

  // Get git remote
  let gitRemote: string | null = null;
  let ownerRepo: string | null = null;
  if (isGitRepo) {
    gitRemote = await git(["remote", "get-url", "origin"], workingDir);
    if (gitRemote) {
      ownerRepo = extractOwnerRepo(gitRemote);
    }
  }

  // Get current branch (for display only, NOT for defaultBranch)
  const currentBranch = isGitRepo ? await git(["branch", "--show-current"], workingDir) : null;

  // Detect the actual default branch (main/master/next)
  const defaultBranch = isGitRepo ? await detectDefaultBranch(workingDir, ownerRepo) : null;

  // Check for tmux (direct invocation more portable than 'which')
  const hasTmux = (await execSilent("tmux", ["-V"])) !== null;

  // Check for gh CLI (direct invocation more portable than 'which')
  const hasGh = (await execSilent("gh", ["--version"])) !== null;

  // Check gh auth status (rely on exit code, not output string)
  let ghAuthed = false;
  if (hasGh) {
    const authStatus = await gh(["auth", "status"]);
    ghAuthed = authStatus !== null;
  }

  // Check for API keys in environment
  const hasLinearKey = !!process.env["LINEAR_API_KEY"];
  const hasSlackWebhook = !!process.env["SLACK_WEBHOOK_URL"];

  return {
    isGitRepo,
    gitRemote,
    ownerRepo,
    currentBranch,
    defaultBranch,
    hasTmux,
    hasGh,
    ghAuthed,
    hasLinearKey,
    hasSlackWebhook,
  };
}
