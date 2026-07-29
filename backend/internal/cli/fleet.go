package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// newFleetCommand lists this tenant's agent sessions ACROSS locations — the
// local daemon AND cloud sandboxes — with each one's status. It's how an
// orchestrator (running locally OR in a sandbox) discovers every worker it owns
// and what they're doing; plain `ao session ls` only sees the local daemon.
//
// Cloud discovery needs control-plane credentials, resolved from either the
// environment (AO_CONTROL_PLANE_URL + AO_BUS_TOKEN, set inside a sandbox) or the
// daemon's bus-credentials file (written after cloud sign-in, so a LOCAL
// orchestrator works too). Without them, it degrades to the local list.
func newFleetCommand(ctx *commandContext) *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "fleet",
		Short: "List agent sessions across locations (local + cloud) with status",
		RunE: func(cmd *cobra.Command, _ []string) error {
			merged, cloudReachable := gatherFleet(cmd.Context(), ctx)
			if asJSON {
				return writeJSON(cmd.OutOrStdout(), fleetResponse{Sessions: merged})
			}
			return writeFleet(cmd.OutOrStdout(), merged, cloudReachable)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Output as JSON")
	return cmd
}

type fleetResponse struct {
	Sessions []fleetSession `json:"sessions"`
}

type fleetSession struct {
	SessionID   string `json:"sessionId"`
	Kind        string `json:"kind"`
	ProjectID   string `json:"projectId"`
	Location    string `json:"location"` // "local" | "cloud"
	SandboxID   string `json:"sandboxId,omitempty"`
	Status      string `json:"status,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Harness     string `json:"harness,omitempty"`
}

// gatherFleet merges the local daemon's sessions with the tenant's cloud
// sessions (deduped by session id). cloudReachable reports whether the control
// plane was consulted (false → local-only, e.g. signed out).
func gatherFleet(reqCtx context.Context, ctx *commandContext) ([]fleetSession, bool) {
	byID := map[string]fleetSession{}
	order := []string{}
	add := func(fs fleetSession) {
		if _, seen := byID[fs.SessionID]; !seen {
			order = append(order, fs.SessionID)
		}
		byID[fs.SessionID] = fs
	}

	// Local sessions (this daemon) — richest status, added first so they win.
	var local sessionListResponse
	if err := ctx.getJSON(reqCtx, "sessions", &local); err == nil {
		for _, s := range local.Sessions {
			if s.IsTerminated {
				continue
			}
			add(fleetSession{
				SessionID: s.ID, Kind: s.Kind, ProjectID: s.ProjectID,
				Location: "local", Status: s.Status, DisplayName: s.DisplayName, Harness: s.Harness,
			})
		}
	}

	// Cloud sessions (control plane), if credentials are available.
	cpURL, token := controlPlaneCreds()
	cloudReachable := false
	if cpURL != "" {
		var res struct {
			Sessions []struct {
				SessionID   string `json:"sessionId"`
				Kind        string `json:"kind"`
				ProjectID   string `json:"projectId"`
				Type        string `json:"type"`
				SandboxID   string `json:"sandboxId"`
				Status      string `json:"status"`
				DisplayName string `json:"displayName"`
				Harness     string `json:"harness"`
			} `json:"sessions"`
		}
		if err := getFromControlPlane(reqCtx, cpURL, token, "/api/v1/cloud/bus/locations", &res); err == nil {
			cloudReachable = true
			for _, s := range res.Sessions {
				// A local session the daemon also registered upstream shows up here
				// as type "daemon"; skip it — we already have the local entry.
				if s.Type != "sandbox" {
					continue
				}
				add(fleetSession{
					SessionID: s.SessionID, Kind: s.Kind, ProjectID: s.ProjectID,
					Location: "cloud", SandboxID: s.SandboxID, Status: s.Status,
					DisplayName: s.DisplayName, Harness: s.Harness,
				})
			}
		}
	}

	out := make([]fleetSession, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	return out, cloudReachable
}

func writeFleet(w io.Writer, sessions []fleetSession, cloudReachable bool) error {
	if !cloudReachable {
		_, _ = fmt.Fprintln(w, "(cloud control plane not reachable — showing local sessions only; sign in to cloud to see cloud agents)")
	}
	if len(sessions) == 0 {
		_, err := fmt.Fprintln(w, "No active agent sessions.")
		return err
	}
	tw := tabwriter.NewWriter(w, 0, 2, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "SESSION\tKIND\tLOCATION\tSTATUS\tPROJECT\tNAME")
	for _, s := range sessions {
		loc := s.Location
		if s.Location == "cloud" && s.SandboxID != "" {
			loc = "cloud:" + s.SandboxID
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n",
			s.SessionID, dash(s.Kind), loc, dash(s.Status), dash(s.ProjectID), dash(s.DisplayName))
	}
	return tw.Flush()
}

func dash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

// controlPlaneCreds resolves the control-plane URL + bearer token from the
// environment first (sandbox), then the daemon's bus-credentials file (laptop).
func controlPlaneCreds() (url, token string) {
	if u := strings.TrimSpace(os.Getenv("AO_CONTROL_PLANE_URL")); u != "" {
		return u, strings.TrimSpace(os.Getenv("AO_BUS_TOKEN"))
	}
	dataDir := strings.TrimSpace(os.Getenv("AO_DATA_DIR"))
	if dataDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			dataDir = filepath.Join(home, ".ao", "data")
		}
	}
	if dataDir == "" {
		return "", ""
	}
	data, err := os.ReadFile(filepath.Join(dataDir, "bus-credentials.json"))
	if err != nil {
		return "", ""
	}
	var fc struct {
		ControlPlaneURL string `json:"controlPlaneUrl"`
		Token           string `json:"token"`
	}
	if json.Unmarshal(data, &fc) != nil {
		return "", ""
	}
	return strings.TrimSpace(fc.ControlPlaneURL), strings.TrimSpace(fc.Token)
}

// getFromControlPlane GETs a control-plane path with the bus-token Bearer.
func getFromControlPlane(ctx context.Context, baseURL, token, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+path, http.NoBody)
	if err != nil {
		return err
	}
	if strings.TrimSpace(token) != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("control plane %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
