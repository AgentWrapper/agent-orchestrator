package domain

import "fmt"

// ProjectImportConflict reason constants describe why an imported project
// cannot be written to the target storage.
const (
	ProjectImportConflictSameIDArchivedTarget      = "same id matches archived target project"
	ProjectImportConflictSameIDDifferentActivePath = "same id with different active path"
	ProjectImportConflictSamePathDifferentActiveID = "same path with different active id"
)

// ProjectImportConflict describes a target project that prevents an imported
// project row from being written.
type ProjectImportConflict struct {
	ProjectID  string
	Path       string
	Reason     string
	TargetID   string
	TargetPath string
}

// ProjectImportConflictError reports an import conflict detected at the live
// target storage mutation boundary.
type ProjectImportConflictError struct {
	Conflict ProjectImportConflict
}

func (e *ProjectImportConflictError) Error() string {
	return fmt.Sprintf("project import conflict for %s at %s: %s", e.Conflict.ProjectID, e.Conflict.Path, e.Conflict.Reason)
}
