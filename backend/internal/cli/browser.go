package cli

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type browserStatusDTO struct {
	SessionID   string    `json:"sessionId"`
	Connected   bool      `json:"connected"`
	ConnectedAt time.Time `json:"connectedAt,omitempty"`
	Transport   string    `json:"transport"`
}

type browserCommandRequestDTO struct {
	SessionID string         `json:"sessionId"`
	Action    string         `json:"action"`
	Args      map[string]any `json:"args,omitempty"`
}

type browserCommandResponseDTO struct {
	RequestID string         `json:"requestId"`
	SessionID string         `json:"sessionId"`
	Action    string         `json:"action"`
	Result    map[string]any `json:"result"`
}

func newBrowserCommand(ctx *commandContext) *cobra.Command {
	var jsonOutput bool
	cmd := &cobra.Command{
		Use:   "browser",
		Short: "Inspect and control this AO session's shared desktop browser",
		Long: "Inspect and control the target-isolated browser owned by the current AO session.\n\n" +
			"The desktop app must be open. Commands operate the same live page the user sees,\n" +
			"including while the Browser panel is hidden.",
		Args: noArgs,
	}
	cmd.PersistentFlags().BoolVar(&jsonOutput, "json", false, "print the structured response as JSON")

	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show whether the desktop browser runtime is connected",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			status, err := ctx.browserStatus(cmd.Context())
			if err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(cmd.OutOrStdout(), status)
			}
			state := "disconnected"
			if status.Connected {
				state = "connected"
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "Browser runtime: %s (%s)\n", state, status.Transport)
			return err
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "open <url>",
		Short: "Open a URL in this session's browser",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(cmd, "open", map[string]any{"url": args[0]}, jsonOutput)
		},
	})

	var interactiveOnly bool
	snapshot := &cobra.Command{
		Use:   "snapshot",
		Short: "Print a compact accessibility snapshot with actionable element refs",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.runBrowserAction(cmd, "snapshot", map[string]any{"interactive": interactiveOnly}, jsonOutput)
		},
	}
	snapshot.Flags().BoolVar(&interactiveOnly, "interactive", false, "include only actionable elements")
	cmd.AddCommand(snapshot)

	cmd.AddCommand(&cobra.Command{
		Use:   "click <ref>",
		Short: "Click an element reference from the latest snapshot",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(cmd, "click", map[string]any{"ref": args[0]}, jsonOutput)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "fill <ref> <text>",
		Short: "Replace the value of a form control",
		Args:  exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(cmd, "fill", map[string]any{"ref": args[0], "text": args[1]}, jsonOutput)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "type <ref> <text>",
		Short: "Type text at the current cursor position in a form control",
		Args:  exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(cmd, "type", map[string]any{"ref": args[0], "text": args[1]}, jsonOutput)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "press <key>",
		Short: "Press a key or modifier chord such as Enter or Control+A",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(cmd, "press", map[string]any{"key": args[0]}, jsonOutput)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "hover <ref>",
		Short: "Move the pointer over an element",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(cmd, "hover", map[string]any{"ref": args[0]}, jsonOutput)
		},
	})

	var scrollAmount int
	scroll := &cobra.Command{
		Use:   "scroll <up|down|left|right>",
		Short: "Scroll the page in one direction",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(
				cmd,
				"scroll",
				map[string]any{"direction": args[0], "amount": scrollAmount},
				jsonOutput,
			)
		},
	}
	scroll.Flags().IntVar(&scrollAmount, "amount", 600, "scroll distance in CSS pixels")
	cmd.AddCommand(scroll)

	cmd.AddCommand(&cobra.Command{
		Use:   "select <ref> <value>",
		Short: "Select an option value",
		Args:  exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBrowserAction(cmd, "select", map[string]any{"ref": args[0], "value": args[1]}, jsonOutput)
		},
	})

	for _, checked := range []bool{true, false} {
		checked := checked
		action := "check"
		short := "Check a checkbox or switch"
		if !checked {
			action = "uncheck"
			short = "Uncheck a checkbox or switch"
		}
		cmd.AddCommand(&cobra.Command{
			Use:   action + " <ref>",
			Short: short,
			Args:  exactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return ctx.runBrowserAction(cmd, action, map[string]any{"ref": args[0]}, jsonOutput)
			},
		})
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "get <property> [ref]",
		Short: "Read a page or element property",
		Long:  "Read url, title, or text from the page, or text, value, or checked from an element reference.",
		Args:  rangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			actionArgs := map[string]any{"property": args[0]}
			if len(args) == 2 {
				actionArgs["ref"] = args[1]
			}
			return ctx.runBrowserAction(cmd, "get", actionArgs, jsonOutput)
		},
	})

	var waitText, waitSelector, waitURL string
	var waitMS, timeoutMS int
	waitCmd := &cobra.Command{
		Use:   "wait",
		Short: "Wait for time, text, selector, or URL state",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			selected := 0
			for _, active := range []bool{waitText != "", waitSelector != "", waitURL != "", waitMS > 0} {
				if active {
					selected++
				}
			}
			if selected != 1 {
				return usageError{errors.New("choose exactly one of --text, --selector, --url, or --ms")}
			}
			args := map[string]any{"timeoutMs": timeoutMS}
			switch {
			case waitText != "":
				args["text"] = waitText
			case waitSelector != "":
				args["selector"] = waitSelector
			case waitURL != "":
				args["url"] = waitURL
			default:
				args["ms"] = waitMS
			}
			return ctx.runBrowserAction(cmd, "wait", args, jsonOutput)
		},
	}
	waitCmd.Flags().StringVar(&waitText, "text", "", "wait until visible page text contains this value")
	waitCmd.Flags().StringVar(&waitSelector, "selector", "", "wait until this CSS selector exists")
	waitCmd.Flags().StringVar(&waitURL, "url", "", "wait until the current URL contains this value")
	waitCmd.Flags().IntVar(&waitMS, "ms", 0, "wait for a fixed number of milliseconds")
	waitCmd.Flags().IntVar(&timeoutMS, "timeout", 10_000, "condition timeout in milliseconds")
	cmd.AddCommand(waitCmd)

	cmd.AddCommand(&cobra.Command{
		Use:   "screenshot [path]",
		Short: "Capture the current page to a PNG file",
		Args:  atMostOneArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			resp, err := ctx.browserAction(cmd.Context(), "screenshot", nil)
			if err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(cmd.OutOrStdout(), resp)
			}
			path := ""
			if len(args) == 1 {
				path = args[0]
			} else {
				path = "ao-browser-" + ctx.deps.Now().Format("20060102-150405.000") + ".png"
			}
			return writeBrowserScreenshot(cmd, resp.Result, path)
		},
	})

	for _, action := range []string{"console", "errors"} {
		action := action
		cmd.AddCommand(&cobra.Command{
			Use:   action,
			Short: "Print captured browser " + action,
			Args:  noArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return ctx.runBrowserAction(cmd, action, nil, jsonOutput)
			},
		})
	}
	return cmd
}

func exactArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := cobra.ExactArgs(n)(cmd, args); err != nil {
			return usageError{err}
		}
		return nil
	}
}

func rangeArgs(min, max int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := cobra.RangeArgs(min, max)(cmd, args); err != nil {
			return usageError{err}
		}
		return nil
	}
}

func currentBrowserSessionID() (string, error) {
	sessionID := strings.TrimSpace(os.Getenv("AO_SESSION_ID"))
	if sessionID == "" {
		return "", usageError{errors.New("ao browser must run inside an AO session (AO_SESSION_ID is not set)")}
	}
	return sessionID, nil
}

func (c *commandContext) browserStatus(ctx context.Context) (browserStatusDTO, error) {
	sessionID, err := currentBrowserSessionID()
	if err != nil {
		return browserStatusDTO{}, err
	}
	var out browserStatusDTO
	err = c.getJSON(ctx, "browser/status?sessionId="+url.QueryEscape(sessionID), &out)
	return out, err
}

func (c *commandContext) browserAction(ctx context.Context, action string, args map[string]any) (browserCommandResponseDTO, error) {
	sessionID, err := currentBrowserSessionID()
	if err != nil {
		return browserCommandResponseDTO{}, err
	}
	var out browserCommandResponseDTO
	err = c.postJSON(ctx, "browser/commands", browserCommandRequestDTO{SessionID: sessionID, Action: action, Args: args}, &out)
	return out, err
}

func (c *commandContext) runBrowserAction(cmd *cobra.Command, action string, args map[string]any, jsonOutput bool) error {
	resp, err := c.browserAction(cmd.Context(), action, args)
	if err != nil {
		return err
	}
	if jsonOutput {
		return writeJSON(cmd.OutOrStdout(), resp)
	}
	return writeBrowserResult(cmd, action, resp.Result)
}

func writeBrowserResult(cmd *cobra.Command, action string, result map[string]any) error {
	if action == "snapshot" {
		if text, ok := result["text"].(string); ok {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), text)
			return err
		}
	}
	if action == "console" || action == "errors" {
		messages, _ := result["messages"].([]any)
		if len(messages) == 0 {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), "No browser "+action+" captured.")
			return err
		}
		for _, message := range messages {
			if item, ok := message.(map[string]any); ok {
				level, _ := item["level"].(string)
				text, _ := item["message"].(string)
				if _, err := fmt.Fprintf(cmd.OutOrStdout(), "[%s] %s\n", level, text); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if action == "get" {
		if value, ok := result["value"]; ok {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), value)
			return err
		}
	}
	if currentURL, ok := result["url"].(string); ok && currentURL != "" {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), currentURL)
		return err
	}
	_, err := fmt.Fprintln(cmd.OutOrStdout(), "Browser "+action+" completed.")
	return err
}

func writeBrowserScreenshot(cmd *cobra.Command, result map[string]any, target string) error {
	encoded, _ := result["data"].(string)
	if encoded == "" {
		return errors.New("browser returned an empty screenshot")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return fmt.Errorf("decode browser screenshot: %w", err)
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("refusing to overwrite existing screenshot %s", abs)
		}
		return err
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Write(data); err != nil {
		return err
	}
	width := numberString(result["width"])
	height := numberString(result["height"])
	size := ""
	if width != "" && height != "" {
		size = " (" + width + "x" + height + ")"
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "Saved %s%s\n", abs, size)
	return err
}

func numberString(v any) string {
	switch n := v.(type) {
	case float64:
		return strconv.Itoa(int(n))
	case int:
		return strconv.Itoa(n)
	default:
		return ""
	}
}
