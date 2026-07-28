package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// newFleetCommand lists the tenant's sessions ACROSS locations (local daemon +
// cloud sandboxes) by querying the control plane's /bus/locations. It's the
// discovery command an orchestrator uses to see the workers it owns in other
// sandboxes — the local `ao ls` only sees this daemon's sessions. (#3.)
func newFleetCommand(_ *commandContext) *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "fleet",
		Short: "List this tenant's sessions across locations (cloud sandboxes + daemons)",
		Long: "Queries the control plane for every session the tenant owns, wherever it lives.\n" +
			"Requires AO_CONTROL_PLANE_URL + AO_BUS_TOKEN (set inside a cloud sandbox).",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cpURL := strings.TrimSpace(os.Getenv("AO_CONTROL_PLANE_URL"))
			if cpURL == "" {
				return fmt.Errorf("ao fleet needs a control plane: AO_CONTROL_PLANE_URL is not set (run inside a cloud session)")
			}
			var res fleetResponse
			if err := getFromControlPlane(cmd.Context(), cpURL, os.Getenv("AO_BUS_TOKEN"), "/api/v1/cloud/bus/locations", &res); err != nil {
				return err
			}
			if asJSON {
				return writeJSON(cmd.OutOrStdout(), res)
			}
			return writeFleet(cmd.OutOrStdout(), res.Sessions)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Output as JSON")
	return cmd
}

type fleetResponse struct {
	Sessions []fleetSession `json:"sessions"`
}

type fleetSession struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	ProjectID string `json:"projectId"`
	Type      string `json:"type"`
	SandboxID string `json:"sandboxId"`
}

func writeFleet(w io.Writer, sessions []fleetSession) error {
	if len(sessions) == 0 {
		_, err := fmt.Fprintln(w, "No sessions found for this tenant.")
		return err
	}
	tw := tabwriter.NewWriter(w, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "SESSION\tKIND\tLOCATION\tPROJECT")
	for _, s := range sessions {
		loc := s.Type
		if s.SandboxID != "" {
			loc = s.Type + ":" + s.SandboxID
		}
		kind := s.Kind
		if kind == "" {
			kind = "-"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", s.SessionID, kind, loc, s.ProjectID)
	}
	return tw.Flush()
}

// getFromControlPlane GETs a control-plane path with the bus-token Bearer.
func getFromControlPlane(ctx context.Context, baseURL, token, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+path, nil)
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
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("control plane %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
