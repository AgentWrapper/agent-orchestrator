package preview

import (
	"net"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// StoredWorkspaceEntry extracts a workspace-relative entry from every preview
// format persisted by released versions: isolated-origin URLs, legacy API
// URLs, and plain relative paths.
func StoredWorkspaceEntry(raw string, id domain.SessionID) (string, bool) {
	if strings.TrimSpace(raw) == "" {
		return "", false
	}
	parsed, err := url.Parse(raw)
	if err == nil {
		if originID, ok := SessionIDFromHost(parsed.Host); ok {
			if originID != id {
				return "", false
			}
			entry, err := url.PathUnescape(strings.TrimPrefix(parsed.EscapedPath(), "/"))
			if err != nil {
				return "", false
			}
			return CleanWorkspacePath(entry)
		}

		prefix := "/api/v1/sessions/" + url.PathEscape(string(id)) + "/preview/files/"
		if isLegacyPreviewHost(parsed.Hostname()) && strings.HasPrefix(parsed.EscapedPath(), prefix) {
			entry, err := url.PathUnescape(strings.TrimPrefix(parsed.EscapedPath(), prefix))
			if err != nil {
				return "", false
			}
			return CleanWorkspacePath(entry)
		}
	}

	if strings.Contains(raw, "://") || filepath.IsAbs(raw) || isWindowsAbsolute(raw) || strings.Contains(raw, ":") {
		return "", false
	}
	return CleanWorkspacePath(raw)
}

func isLegacyPreviewHost(host string) bool {
	if host == "" || strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isWindowsAbsolute(raw string) bool {
	return len(raw) >= 3 && ((raw[0] >= 'a' && raw[0] <= 'z') || (raw[0] >= 'A' && raw[0] <= 'Z')) && raw[1] == ':' && (raw[2] == '\\' || raw[2] == '/')
}
