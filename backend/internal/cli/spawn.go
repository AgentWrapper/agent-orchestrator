package cli

import (
	"context"
	"fmt"
	"net/url"
	"runtime"
	"strings"
	"unicode/utf8"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
)

// maxDisplayNameLen caps the sidebar label set by `--name`. Mirrored by the
// daemon's spawn handler so a direct API call is held to the same limit.
const maxDisplayNameLen = 20

type spawnOptions struct {
	project    string
	harness    string
	branch     string
	prompt     string
	issue      string
	name       string
	claimPR    string
	noTakeover bool
}

// spawnRequest mirrors the daemon's SpawnSessionRequest body for
// POST /api/v1/sessions. The CLI keeps its own copy so it need not import httpd.
type spawnRequest struct {
	ProjectID   string `json:"projectId"`
	IssueID     string `json:"issueId,omitempty"`
	Harness     string `json:"harness,omitempty"`
	Branch      string `json:"branch,omitempty"`
	Prompt      string `json:"prompt,omitempty"`
	DisplayName string `json:"displayName"`
}

type spawnResult struct {
	Session struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"session"`
}

func newSpawnCommand(ctx *commandContext) *cobra.Command {
	var opts spawnOptions
	cmd := &cobra.Command{
		Use:   "spawn",
		Short: "Spawn a worker agent session in a registered project",
		Long: "Spawn a worker agent session in a registered project.\n\n" +
			"The session runs the chosen agent in a\n" +
			"fresh git worktree. Register the project first with `ao project add`.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.project == "" {
				return usageError{fmt.Errorf("--project is required")}
			}
			name := strings.TrimSpace(opts.name)
			if name == "" {
				return usageError{fmt.Errorf("--name is required")}
			}
			if utf8.RuneCountInString(name) > maxDisplayNameLen {
				return usageError{fmt.Errorf("--name must be %d characters or fewer", maxDisplayNameLen)}
			}
			if opts.noTakeover && opts.claimPR == "" {
				return usageError{fmt.Errorf("--no-takeover requires --claim-pr")}
			}
			claimRef := ""
			if opts.claimPR != "" {
				project, err := ctx.fetchProjectDetails(cmd.Context(), opts.project)
				if err != nil {
					return err
				}
				claimRef, err = ctx.resolvePRRef(cmd.Context(), opts.claimPR, project)
				if err != nil {
					return err
				}
			}
			req := spawnRequest{
				ProjectID:   opts.project,
				IssueID:     opts.issue,
				Harness:     opts.harness,
				Branch:      opts.branch,
				Prompt:      opts.prompt,
				DisplayName: name,
			}
			var res spawnResult
			if err := ctx.postJSON(cmd.Context(), "sessions", req, &res); err != nil {
				return err
			}
			claimed := ""
			if opts.claimPR != "" {
				var claim claimPRResponse
				if err := ctx.postJSON(cmd.Context(), "sessions/"+url.PathEscape(res.Session.ID)+"/pr/claim", claimPRRequest{PR: claimRef, AllowTakeover: !opts.noTakeover}, &claim); err != nil {
					if killErr := ctx.rollbackSpawnedSession(cmd.Context(), res.Session.ID); killErr != nil {
						return fmt.Errorf("failed to claim PR %s: %w; rollback of session %s failed: %w", opts.claimPR, err, res.Session.ID, killErr)
					}
					return fmt.Errorf("failed to claim PR %s: %w; rolled back session %s", opts.claimPR, err, res.Session.ID)
				}
				if len(claim.PRs) > 0 {
					claimed = claim.PRs[0].URL
				}
			}
			out := cmd.OutOrStdout()
			claimLabel := ""
			if claimed != "" {
				claimLabel = fmt.Sprintf(" (claimed %s)", claimed)
			}
			if _, err := fmt.Fprintf(out, "spawned session %s (%s)%s\n", res.Session.ID, res.Session.Status, claimLabel); err != nil {
				return err
			}
			// Print a copy-pasteable attach hint for the selected runtime.
			// On Darwin/Linux: tmux attach-session using the sanitised session name.
			// On Windows: ConPTY has no user-facing attach CLI; use the AO dashboard.
			var attach string
			if runtime.GOOS != "windows" {
				attach = fmt.Sprintf("tmux attach -t %s", tmux.SessionName(res.Session.ID))
			} else {
				attach = "Attach from the AO dashboard (ConPTY sessions have no CLI attach command)"
			}
			_, err := fmt.Fprintf(out, "attach with: %s\n", attach)
			return err
		},
	}
	f := cmd.Flags()
	// --agent is an alias for --harness so the more intuitive `ao spawn --agent
	// droid` works identically; both resolve to the same harness flag.
	f.SetNormalizeFunc(func(_ *pflag.FlagSet, name string) pflag.NormalizedName {
		if name == "agent" {
			name = "harness"
		}
		return pflag.NormalizedName(name)
	})
	f.StringVar(&opts.project, "project", "", "Project id to spawn the session in (required)")
	f.StringVar(&opts.harness, "harness", "", "Agent harness / --agent: claude-code, codex, aider, opencode, grok, droid, amp, agy, crush, cursor, qwen, copilot, goose, auggie, continue, devin, cline, kimi, kiro, kilocode, vibe, pi, autohand (default: project worker.agent; required if the project has none)")
	f.StringVar(&opts.branch, "branch", "", "Branch for the session worktree (default: ao/<session-id>/root)")
	f.StringVar(&opts.prompt, "prompt", "", "Initial prompt for the agent")
	f.StringVar(&opts.issue, "issue", "", "Issue id to associate with the session")
	f.StringVar(&opts.name, "name", "", "Display name shown in the sidebar (required, max 20 characters)")
	f.StringVar(&opts.claimPR, "claim-pr", "", "Immediately claim an existing PR for the spawned session")
	f.BoolVar(&opts.noTakeover, "no-takeover", false, "Refuse if another active session owns the claimed PR (requires --claim-pr)")
	return cmd
}

// rollbackSpawnedSession reverses a partial `spawn` whose out-of-band follow-up
// (PR claim) failed. It calls the daemon's `/rollback` endpoint, which deletes
// the seed-state row outright instead of marking it terminated — so the user
// does not see an orphan terminated session under `--include-terminated`. If
// spawn output has already landed (workspace + runtime), the daemon falls back
// to a Kill on the server side so teardown still happens.
func (c *commandContext) rollbackSpawnedSession(ctx context.Context, id string) error {
	var res rollbackSessionResponse
	return c.postJSON(ctx, "sessions/"+url.PathEscape(id)+"/rollback", struct{}{}, &res)
}

// rollbackSessionResponse mirrors the daemon's RollbackSessionResponse body.
type rollbackSessionResponse struct {
	OK        bool   `json:"ok"`
	SessionID string `json:"sessionId"`
	Deleted   bool   `json:"deleted,omitempty"`
	Killed    bool   `json:"killed,omitempty"`
}
