package project

// Error is the manager-level error shape controllers can translate into the
// locked HTTP APIError envelope without knowing store internals.
type Error struct {
	Kind    string
	Code    string
	Message string
	Details map[string]any
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func newError(kind, code, message string, details map[string]any) *Error {
	return &Error{Kind: kind, Code: code, Message: message, Details: details}
}

func badRequest(code, message string, details map[string]any) *Error {
	return newError("bad_request", code, message, details)
}

func notFound(code, message string) *Error {
	return newError("not_found", code, message, nil)
}

func conflict(code, message string, details map[string]any) *Error {
	return newError("conflict", code, message, details)
}

func notImplemented(code, message string) *Error {
	return newError("not_implemented", code, message, nil)
}

func internal(code, message string) *Error {
	return newError("internal", code, message, nil)
}
