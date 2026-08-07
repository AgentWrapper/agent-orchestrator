package sessionmanager

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// StageAttachments writes files into a live session's worktree and returns their
// worktree-relative paths.
//
// This is the spawn attachment path applied to a conversation that is already
// running: files land in the worktree and the caller names the paths in the
// message it sends, so the agent reads them off disk. It exists as its own step
// because a chat session attaches files repeatedly over its life, while spawn
// does it once for the opening brief.
//
// Names are randomized rather than sequential. Spawn can use attachment-1 /
// attachment-2 because it writes exactly once; a chat session writing the same
// name on its tenth message would overwrite the file it sent on its first,
// silently changing what an earlier message in the visible timeline points at.
func (m *Manager) StageAttachments(
	ctx context.Context,
	id domain.SessionID,
	attachments []ports.SpawnAttachment,
) ([]string, error) {
	if len(attachments) == 0 {
		return nil, nil
	}

	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", id, err)
	}
	if !ok {
		return nil, ports.ErrSessionNotFound
	}
	if rec.Metadata.WorkspacePath == "" {
		// Nothing to write into. Refusing beats writing somewhere the agent cannot
		// reach and then telling the user their image was attached.
		return nil, fmt.Errorf("session %s has no workspace", id)
	}

	dir := filepath.Join(rec.Metadata.WorkspacePath, filepath.FromSlash(attachmentsDir))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create attachments dir: %w", err)
	}

	refs := make([]string, 0, len(attachments))
	for i, a := range attachments {
		ext := a.Ext
		if ext == "" {
			ext = ".bin"
		}
		suffix, err := randomSuffix()
		if err != nil {
			return nil, fmt.Errorf("name attachment %d: %w", i+1, err)
		}
		name := "attachment-" + suffix + ext
		if err := os.WriteFile(filepath.Join(dir, name), a.Data, 0o600); err != nil {
			return nil, fmt.Errorf("write attachment %d: %w", i+1, err)
		}
		refs = append(refs, attachmentsDir+"/"+name)
	}

	// Keep the directory out of git status. Best-effort for the same reason spawn
	// treats it that way: the images are already written and usable, and a session
	// the user cannot attach to is worse than a worktree that reads as dirty.
	if err := m.workspace.AddExclude(ctx, workspaceInfo(rec), "/"+attachmentsDir+"/"); err != nil {
		m.logger.Warn("stage attachments: exclude attachments dir", "sessionID", id, "error", err)
	}
	return refs, nil
}

// randomSuffix is a short collision-resistant name part. Short because it ends up
// in a path the user reads in their own message text.
func randomSuffix() (string, error) {
	var buf [5]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
