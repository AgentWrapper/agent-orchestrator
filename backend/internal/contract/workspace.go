package contract

// WorkspaceFileStatus describes a session-workspace file relative to its compare base.
type WorkspaceFileStatus string

const (
	// WorkspaceFileUnmodified means the file matches its compare base.
	WorkspaceFileUnmodified WorkspaceFileStatus = "unmodified"
	// WorkspaceFileModified means the file changed in place.
	WorkspaceFileModified WorkspaceFileStatus = "modified"
	// WorkspaceFileAdded means the file was added.
	WorkspaceFileAdded WorkspaceFileStatus = "added"
	// WorkspaceFileDeleted means the file was deleted.
	WorkspaceFileDeleted WorkspaceFileStatus = "deleted"
	// WorkspaceFileRenamed means the file moved from a previous path.
	WorkspaceFileRenamed WorkspaceFileStatus = "renamed"
	// WorkspaceFileUntracked means Git does not track the file.
	WorkspaceFileUntracked WorkspaceFileStatus = "untracked"
	// WorkspaceFileCopied means Git detected the file as copied.
	WorkspaceFileCopied WorkspaceFileStatus = "copied"
	// WorkspaceFileChanged is a fallback for non-specific change states.
	WorkspaceFileChanged WorkspaceFileStatus = "changed"
)

// WorkspaceCompareMode describes the Git revision used for workspace diffs.
type WorkspaceCompareMode string

const (
	// WorkspaceCompareBase means diffs are relative to the intended base.
	WorkspaceCompareBase WorkspaceCompareMode = "base"
	// WorkspaceCompareHeadFallback means no durable base was available.
	WorkspaceCompareHeadFallback WorkspaceCompareMode = "head_fallback"
)

// WorkspaceFileSummary is the portable file row used by workspace browsers.
type WorkspaceFileSummary struct {
	Path         string              `json:"path"`
	PreviousPath string              `json:"previousPath,omitempty"`
	Status       WorkspaceFileStatus `json:"status"`
	Additions    int                 `json:"additions"`
	Deletions    int                 `json:"deletions"`
	Size         int64               `json:"size,omitempty"`
	Binary       bool                `json:"binary"`
}

// WorkspaceDiffFile is one file in a Cloud workspace diff response.
type WorkspaceDiffFile struct {
	Path      string              `json:"path"`
	OldPath   string              `json:"oldPath,omitempty"`
	Status    WorkspaceFileStatus `json:"status"`
	Staged    string              `json:"staged,omitempty"`
	Unstaged  string              `json:"unstaged,omitempty"`
	Additions int                 `json:"additions"`
	Deletions int                 `json:"deletions"`
	Binary    bool                `json:"binary"`
}
