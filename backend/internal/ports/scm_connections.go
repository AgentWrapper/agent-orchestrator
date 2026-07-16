package ports

import "errors"

// ErrSCMConnectionReferenced prevents deleting a connection selected by a project.
var ErrSCMConnectionReferenced = errors.New("scm connection is referenced by a project")
