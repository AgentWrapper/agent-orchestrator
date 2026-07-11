package controllers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHardParam locks the contract that ?hard accepts the standard boolean
// encodings the OpenAPI/TS types imply (not only the literal string "true"):
// a client sending ?hard=1 must get a hard pause, and the absent/false cases
// must stay soft. Regression for the Copilot review finding on the pause route.
func TestHardParam(t *testing.T) {
	cases := []struct {
		query string
		want  bool
	}{
		{"", false},
		{"hard=true", true},
		{"hard=True", true},
		{"hard=TRUE", true},
		{"hard=1", true},
		{"hard=t", true},
		{"hard=false", false},
		{"hard=0", false},
		{"hard=", false},
		{"hard=yes", false}, // not a Go bool literal — stays soft, not a panic
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pause?"+tc.query, nil)
		if got := hardParam(r); got != tc.want {
			t.Errorf("hardParam(?%s) = %v, want %v", tc.query, got, tc.want)
		}
	}
}
