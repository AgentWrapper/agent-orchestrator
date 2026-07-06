package cli

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

func isMarkdownFile(path string) bool {
	return strings.HasSuffix(strings.ToLower(path), ".md")
}

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
			"A local file can be opened by its absolute path\n" +
			"(e.g. /home/me/proj/index.html or relative/file.md).\n" +
			"Use `ao preview clear` to empty the panel.",
		Example: `  ao preview
  ao preview path/to/readme.md
  ao preview /home/me/proj/index.html
  ao preview http://localhost:5173
  ao preview clear`,
		Args: cobra.MaximumNArgs(1),
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
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.clearPreview(cmd.Context())
		},
	})
	return cmd
}

func (c *commandContext) openPreview(ctx context.Context, target string) error {
	// Resolve file paths (absolute or relative) before contacting the daemon.
	// If the path looks like a local file (no URL scheme), resolve, stat, and
	// convert to a file:// URL so the daemon never needs worktree awareness.
	if target != "" && !hasURLScheme(target) {
		resolved, err := resolvePreviewPath(target)
		if err != nil {
			return err
		}
		if isMarkdownFile(resolved) {
			// Convert .md files to file:// URL — markdown files must be served
			// as file:// so the renderer can detect and intercept them.
			target = (&url.URL{Scheme: "file", Path: filepath.ToSlash(resolved)}).String()
		} else {
			// Non-.md file paths: pass the absolute path to the daemon, which
			// will stat and convert to file:// as before.
			target = resolved
		}
	}
	path, err := sessionPreviewPath()
	if err != nil {
		return err
	}
	return c.postJSON(ctx, path, previewAPIRequest{Url: target}, nil)
}

// resolvePreviewPath resolves input to an absolute path and verifies the file
// exists. It is called for file-path arguments (no URL scheme) to fail fast
// before any daemon or Electron call.
func resolvePreviewPath(input string) (string, error) {
	target := input
	if !filepath.IsAbs(input) {
		abs, err := filepath.Abs(input)
		if err != nil {
			return "", err
		}
		target = abs
	}
	if _, err := os.Stat(target); err != nil {
		return "", fmt.Errorf("file not found: %s", input)
	}
	return target, nil
}

// hasURLScheme reports whether raw begins with an RFC-3986 "scheme:" prefix
// (http:, https:, file:, or a host:port like localhost:5173). It mirrors the
// daemon's hasURLScheme so the CLI and daemon agree on what counts as a URL.
func hasURLScheme(raw string) bool {
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == ':' {
			return i > 0
		}
		isSchemeChar := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '+' || c == '.' || c == '-'
		if !isSchemeChar {
			return false
		}
	}
	return false
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
