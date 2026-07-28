package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// This file holds the control-plane delegation path for `ao spawn --cloud`. When
// AO_CONTROL_PLANE_URL is set the local daemon is keyless (it can't reach the
// cloud provider), so the CLI asks the control plane to provision the sandbox —
// carrying the git remote and the caller's harness credential so both propagate
// to the new sandbox (the control plane stores neither).

// gitOriginURL returns the `origin` remote of the repo at dir, or "".
func gitOriginURL(dir string) string {
	if strings.TrimSpace(dir) == "" {
		return ""
	}
	out, err := exec.Command("git", "-C", dir, "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// readLocalHarnessCredential reads the caller's current credential for a harness
// so it can be re-injected into the new sandbox. On a Linux sandbox this is the
// on-disk credentials file (no Keychain). Empty for credential-free harnesses.
func readLocalHarnessCredential(harness string) string {
	if harness != "claude-code" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// newIdempotencyKey returns a random key used to dedupe a retried delegated
// spawn so a network reset can't cause a double-provision.
func newIdempotencyKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

// postToControlPlaneRetry retries the delegation POST on connection-level errors
// (the sandbox→control-plane egress intermittently RSTs the connection). Safe to
// retry because the request carries an idempotency key: if a prior attempt did
// reach the control plane and provision, the retry returns that same session
// rather than creating a second sandbox. HTTP error responses are NOT retried.
func postToControlPlaneRetry(ctx context.Context, baseURL, token, path string, body, out any) error {
	var lastErr error
	backoff := 500 * time.Millisecond
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
			backoff *= 2
		}
		err := postToControlPlane(ctx, baseURL, token, path, body, out)
		if err == nil {
			return nil
		}
		// Only retry transport-level failures (reset/timeout/EOF), not HTTP errors.
		var httpErr httpStatusError
		if errors.As(err, &httpErr) {
			return err
		}
		lastErr = err
	}
	return fmt.Errorf("control plane %s failed after retries: %w", path, lastErr)
}

// postToControlPlane POSTs body to the control plane with a bus-token Bearer and
// decodes the JSON response into out.
func postToControlPlane(ctx context.Context, baseURL, token, path string, body, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(token) != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return httpStatusError{status: resp.StatusCode, msg: fmt.Sprintf("control plane %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(snippet)))}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// httpStatusError marks a non-2xx control-plane response (as opposed to a
// transport error), so the retry wrapper does not retry it.
type httpStatusError struct {
	status int
	msg    string
}

func (e httpStatusError) Error() string { return e.msg }
