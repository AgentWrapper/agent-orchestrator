package domain

import "errors"

// ErrPRAmbiguous is returned when a PR lookup by provider number matches more
// than one repo tracked by this AO instance. PR numbers are only unique
// within a single repo, so callers must not guess which one was meant.
var ErrPRAmbiguous = errors.New("domain: pr number is ambiguous across tracked repos")
