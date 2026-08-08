package greptile

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const greptileAuthProbeTimeout = 4 * time.Second

// greptileAuthCommand is replaceable in package tests so auth classification
// can be covered without depending on a user's installed CLI or credentials.
var greptileAuthCommand = func(ctx context.Context, binary string) ([]byte, error) {
	return aoprocess.CommandContext(ctx, binary, "whoami").CombinedOutput()
}

var _ ports.ReviewerAuthChecker = Adapter{}

// AuthStatus checks Greptile's non-interactive account status. Greptile's
// `whoami` command intentionally exits successfully for "Not signed in", so
// output is classified before the process exit code is considered. A valid
// local credential file/API key is used as advisory fallback when the command
// cannot complete because of connectivity or deployment errors.
func (Adapter) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	binary, err := (Adapter{}).ResolveBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}

	localStatus, localKnown, localErr := greptileLocalAuthStatus()
	probeCtx, cancel := context.WithTimeout(ctx, greptileAuthProbeTimeout)
	defer cancel()
	output, _ := greptileAuthCommand(probeCtx, binary)
	if probeCtx.Err() != nil {
		if localKnown {
			return localStatus, nil
		}
		return ports.AgentAuthStatusUnknown, probeCtx.Err()
	}
	if status, ok := greptileAuthStatusFromOutput(output); ok {
		return status, nil
	}
	if localKnown {
		return localStatus, nil
	}
	if localErr != nil {
		return ports.AgentAuthStatusUnknown, localErr
	}
	// A non-auth command failure (for example, a network or deployment
	// problem) is not proof that the user is signed out.
	return ports.AgentAuthStatusUnknown, nil
}

type greptileCredentials struct {
	Method       string `json:"method"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	APIKey       string `json:"apiKey"`
}

func greptileLocalAuthStatus() (ports.AgentAuthStatus, bool, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	return greptileLocalAuthStatusAt(
		filepath.Join(home, ".greptile", "auth.json"),
		os.Getenv("GREPTILE_API_KEY"),
	)
}

func greptileLocalAuthStatusAt(authPath, apiKey string) (ports.AgentAuthStatus, bool, error) {
	if strings.TrimSpace(apiKey) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	data, err := os.ReadFile(authPath)
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	var credentials greptileCredentials
	if err := json.Unmarshal(data, &credentials); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	method := strings.ToLower(strings.TrimSpace(credentials.Method))
	// Greptile's credential schema defaults a missing method to OAuth for
	// credentials written by older CLI versions.
	if method == "" {
		method = "oauth"
	}
	switch method {
	case "oauth":
		if strings.TrimSpace(credentials.AccessToken) != "" || strings.TrimSpace(credentials.RefreshToken) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	case "apikey":
		if strings.TrimSpace(credentials.APIKey) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func greptileAuthStatusFromOutput(output []byte) (ports.AgentAuthStatus, bool) {
	text := strings.ToLower(string(output))
	if strings.Contains(text, "signed in as") {
		return ports.AgentAuthStatusAuthorized, true
	}
	for _, marker := range []string{
		"not signed in",
		"saved sign-in could not be read",
		"credential file corrupt",
		"credential file missing required fields",
		"api key invalid",
		"invalid api key",
		"invalid or revoked",
		"session expired",
		"token expired",
		"authentication required",
		"authentication failed",
		"not authorized",
		"unauthorized",
		"login required",
	} {
		if strings.Contains(text, marker) {
			return ports.AgentAuthStatusUnauthorized, true
		}
	}
	return ports.AgentAuthStatusUnknown, false
}
