package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"

	"github.com/spf13/cobra"
)

const defaultSlackNotifierStateFile = "/home/orchestrator/.ao/slack-notifier-state.json"

type waitingOptions struct {
	json bool
}

type waitingItem struct {
	ProjectID string `json:"projectId"`
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	URL       string `json:"url,omitempty"`
}

type waitingOutput struct {
	Data []waitingItem `json:"data"`
	Meta struct {
		Count int `json:"count"`
	} `json:"meta"`
}

type notificationListResponse struct {
	Notifications []notificationDTO `json:"notifications"`
}

type notificationDTO struct {
	SessionID string `json:"sessionId"`
	ProjectID string `json:"projectId"`
	PRURL     string `json:"prUrl"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	Sensitive bool   `json:"sensitive"`
}

type slackNotifierState struct {
	NeedsResponseMessages map[string]struct {
		Record slackNeedsResponseRecord `json:"record"`
	} `json:"needsResponseMessages"`
}

type slackNeedsResponseRecord struct {
	SessionID string `json:"sessionId"`
	ProjectID string `json:"projectId"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	URL       string `json:"url"`
}

func newWaitingCommand(ctx *commandContext) *cobra.Command {
	var opts waitingOptions
	cmd := &cobra.Command{
		Use:   "waiting",
		Short: "Show sessions currently waiting on operator response",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.waiting(cmd.Context(), cmd, opts)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func (c *commandContext) waiting(ctx context.Context, cmd *cobra.Command, opts waitingOptions) error {
	var sessions sessionListResponse
	if err := c.getJSON(ctx, "sessions?active=true", &sessions); err != nil {
		return err
	}
	var notifications notificationListResponse
	params := url.Values{}
	params.Set("status", "unread")
	params.Set("limit", "100")
	if err := c.getJSON(ctx, apiPath("notifications", params), &notifications); err != nil {
		return err
	}
	out := waitingOutput{Data: waitingItems(sessions.Sessions, notifications.Notifications, waitingItemsFromSlackState(slackNotifierStateFile()))}
	out.Meta.Count = len(out.Data)
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), out)
	}
	return writeWaitingText(cmd, out.Data)
}

func waitingItems(sessions []sessionDTO, notifications []notificationDTO, persisted []waitingItem) []waitingItem {
	out := make([]waitingItem, 0, len(sessions)+len(notifications)+len(persisted))
	seen := map[string]struct{}{}
	for _, s := range sessions {
		item, ok := waitingItemFromSession(s)
		if ok {
			seen[waitingItemKey(item)] = struct{}{}
			out = append(out, item)
		}
	}
	for _, n := range notifications {
		item, ok := waitingItemFromNotification(n)
		if !ok {
			continue
		}
		key := waitingItemKey(item)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	for _, item := range persisted {
		if item.Kind == "" {
			continue
		}
		key := waitingItemKey(item)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProjectID != out[j].ProjectID {
			return out[i].ProjectID < out[j].ProjectID
		}
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
}

func waitingItemFromSession(s sessionDTO) (waitingItem, bool) {
	if s.IsTerminated {
		return waitingItem{}, false
	}
	state := s.Activity.State
	var kind, title string
	switch {
	case state == "blocked":
		kind = "blocked"
		title = "blocked / stuck"
	case state == "waiting_input" || s.Status == "needs_input":
		kind = "needs_input"
		title = "waiting for input"
	case s.Status == "no_signal" && s.Kind == "orchestrator":
		kind = "orchestrator_dead"
		title = "orchestrator down (no live process)"
	case s.Status == "no_signal":
		kind = "no_signal"
		title = "activity signal lost"
	default:
		return waitingItem{}, false
	}
	return waitingItem{
		ProjectID: s.ProjectID,
		SessionID: s.ID,
		Kind:      kind,
		Title:     title,
		URL:       firstSessionPRURL(s.PRs),
	}, true
}

func waitingItemsFromSlackState(path string) []waitingItem {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var state slackNotifierState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil
	}
	out := make([]waitingItem, 0, len(state.NeedsResponseMessages))
	for _, msg := range state.NeedsResponseMessages {
		rec := msg.Record
		if rec.Kind == "" {
			continue
		}
		out = append(out, waitingItem{
			ProjectID: rec.ProjectID,
			SessionID: rec.SessionID,
			Kind:      rec.Kind,
			Title:     rec.Title,
			URL:       rec.URL,
		})
	}
	return out
}

func slackNotifierStateFile() string {
	if path := os.Getenv("AO_SLACK_NOTIFIER_STATE"); path != "" {
		return path
	}
	return defaultSlackNotifierStateFile
}

func waitingItemFromNotification(n notificationDTO) (waitingItem, bool) {
	kind := notificationWaitingKind(n)
	if kind == "" {
		return waitingItem{}, false
	}
	title := n.Title
	if title == "" {
		title = n.Body
	}
	return waitingItem{
		ProjectID: n.ProjectID,
		SessionID: n.SessionID,
		Kind:      kind,
		Title:     title,
		URL:       n.PRURL,
	}, true
}

func notificationWaitingKind(n notificationDTO) string {
	switch {
	case n.Type == "needs_input":
		return "needs_input"
	case n.Type == "orchestrator_replacement_capped":
		return "orchestrator_replacement_capped"
	case n.Type == "ready_to_merge" && n.Sensitive:
		return "parked_sensitive_merge"
	default:
		return ""
	}
}

func waitingItemKey(item waitingItem) string {
	return item.ProjectID + "\x00" + item.SessionID + "\x00" + item.Kind + "\x00" + item.URL
}

func firstSessionPRURL(prs []sessionPRDTO) string {
	if len(prs) == 0 {
		return ""
	}
	return prs[0].URL
}

func writeWaitingText(cmd *cobra.Command, items []waitingItem) error {
	out := cmd.OutOrStdout()
	if len(items) == 0 {
		_, err := fmt.Fprintln(out, "Nothing needs operator response.")
		return err
	}
	count := len(items)
	if _, err := fmt.Fprintf(out, "%d thing%s need%s operator response\n\n", count, pluralS(count), singularS(count)); err != nil {
		return err
	}
	byProject := map[string][]waitingItem{}
	projects := make([]string, 0)
	for _, item := range items {
		project := item.ProjectID
		if project == "" {
			project = "(no project)"
		}
		if _, ok := byProject[project]; !ok {
			projects = append(projects, project)
		}
		byProject[project] = append(byProject[project], item)
	}
	sort.Strings(projects)
	for _, project := range projects {
		if _, err := fmt.Fprintf(out, "%s:\n", project); err != nil {
			return err
		}
		for _, item := range byProject[project] {
			if item.URL != "" {
				if _, err := fmt.Fprintf(out, "  %s — %s (%s)\n  %s\n", item.SessionID, item.Kind, item.Title, item.URL); err != nil {
					return err
				}
				continue
			}
			if _, err := fmt.Fprintf(out, "  %s — %s (%s)\n", item.SessionID, item.Kind, item.Title); err != nil {
				return err
			}
		}
	}
	return nil
}

func singularS(n int) string {
	if n == 1 {
		return "s"
	}
	return ""
}
