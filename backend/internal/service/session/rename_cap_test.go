package session

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// #293 M2: rename is held to the SAME 20-rune display-name contract as spawn,
// at the service layer (so every caller — HTTP, CLI, internal — is bound), and
// the cap counts RUNES, not bytes: a 20-emoji name is legal, 21 is not.
func TestSessionRenameEnforcesRuneCap(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name    string
		display string
		wantErr string
	}{
		{name: "20 ascii", display: strings.Repeat("x", 20)},
		{name: "21 ascii", display: strings.Repeat("x", 21), wantErr: "DISPLAY_NAME_TOO_LONG"},
		// 20 four-byte runes = 80 bytes: legal by rune count, rejected by a byte cap.
		{name: "20 emoji", display: strings.Repeat("🙂", 20)},
		{name: "21 emoji", display: strings.Repeat("🙂", 21), wantErr: "DISPLAY_NAME_TOO_LONG"},
		{name: "blank", display: "   ", wantErr: "DISPLAY_NAME_REQUIRED"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer"}

			err := (&Service{store: st}).Rename(ctx, "mer-1", tc.display)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("rename %q: %v", tc.display, err)
				}
				if got := st.sessions["mer-1"].DisplayName; got != strings.TrimSpace(tc.display) {
					t.Fatalf("display name = %q, want %q", got, tc.display)
				}
				return
			}
			var apiErr *apierr.Error
			if !errors.As(err, &apiErr) || apiErr.Kind != apierr.KindInvalid || apiErr.Code != tc.wantErr {
				t.Fatalf("rename %q err = %v, want %s", tc.display, err, tc.wantErr)
			}
			if got := st.sessions["mer-1"].DisplayName; got != "" {
				t.Fatalf("rejected rename still persisted %q", got)
			}
		})
	}
}
