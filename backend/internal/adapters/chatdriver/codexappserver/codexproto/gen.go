// Package codexproto holds the generated wire vocabulary for the Codex
// app-server protocol.
//
// Regenerating asks the installed provider for its own schema, so the checked-in
// file always describes a real build. A protocol change therefore shows up as a
// diff to review rather than as a field that quietly stopped arriving.
package codexproto

//go:generate go run ../../../../../cmd/gencodexproto -out protocol.gen.go
