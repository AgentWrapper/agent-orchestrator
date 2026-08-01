package contract

// WorkspaceFileStatus describes a session-workspace file relative to its compare base.
type WorkspaceFileStatus string

const (
	WorkspaceFileUnmodified WorkspaceFileStatus = "unmodified"
	WorkspaceFileModified   WorkspaceFileStatus = "modified"
	WorkspaceFileAdded      WorkspaceFileStatus = "added"
	WorkspaceFileDeleted    WorkspaceFileStatus = "deleted"
	WorkspaceFileRenamed    WorkspaceFileStatus = "renamed"
	WorkspaceFileUntracked  WorkspaceFileStatus = "untracked"
	WorkspaceFileCopied     WorkspaceFileStatus = "copied"
	WorkspaceFileChanged    WorkspaceFileStatus = "changed"
)

// WorkspaceCompareMode describes the Git revision used for workspace diffs.
type WorkspaceCompareMode string

const (
	WorkspaceCompareBase         WorkspaceCompareMode = "base"
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
