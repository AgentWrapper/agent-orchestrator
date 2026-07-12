package cli

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// previewAPIRequest mirrors the daemon's body for
// POST /api/v1/sessions/{id}/preview. An empty Url asks the daemon to
// autodetect an index.html in the workspace. The CLI keeps its own copy so it
// need not import httpd.
type previewAPIRequest struct {
	Url string `json:"url"`
}

func newPreviewCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "preview [url]",
		Short: "Open a URL (or the workspace's index.html) in the desktop browser panel for the current session",
		Long: "Open a URL in the desktop browser panel for the current session.\n\n" +
			"With no argument it opens the workspace's static entry point, falling\n" +
			"back to this session's existing preview target when no entry point exists.\n" +
			"A local file can be opened by its absolute file:// URL\n" +
			"(e.g. file:///home/me/proj/index.html). Use `ao preview clear` to empty the panel.",
		Example: `  ao preview
  ao preview file://$(pwd)/index.html
  ao preview http://localhost:5173
  ao preview clear`,
		Args: atMostOneArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			var target string
			if len(args) == 1 {
				target = args[0]
			}
			return ctx.openPreview(cmd.Context(), target)
		},
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "clear",
		Short: "Clear the desktop browser panel for the current session",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.clearPreview(cmd.Context())
		},
	})
	return cmd
}

func (c *commandContext) openPreview(ctx context.Context, target string) error {
	path, err := sessionPreviewPath()
	if err != nil {
		return err
	}
	return c.postJSON(ctx, path, previewAPIRequest{Url: target}, nil)
}

// clearPreview empties the desktop browser panel for the current session
// (`ao preview clear`) by deleting the session's stored preview target.
func (c *commandContext) clearPreview(ctx context.Context) error {
	path, err := sessionPreviewPath()
	if err != nil {
		return err
	}
	return c.deleteJSON(ctx, path, nil)
}

func sessionPreviewPath() (string, error) {
	sessionID := strings.TrimSpace(os.Getenv("AO_SESSION_ID"))
	if sessionID == "" {
		return "", usageError{errors.New("ao preview must run inside an AO session (AO_SESSION_ID is not set)")}
	}
	// PathEscape: session ids are already "-"/digit safe, but keep the URL
	// well-formed regardless.
	return "sessions/" + url.PathEscape(sessionID) + "/preview", nil
}
