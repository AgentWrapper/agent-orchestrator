package notify

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestSessionLabelPrefersDisplayNameThenProjectID(t *testing.T) {
	cases := []struct {
		name   string
		intent Intent
		want   string
	}{
		{
			name:   "display name wins",
			intent: Intent{SessionDisplayName: "checkout-flow", SessionID: "mer-1", ProjectID: "mer"},
			want:   "checkout-flow",
		},
		{
			name:   "empty display name falls back to project id",
			intent: Intent{SessionID: "mer-1", ProjectID: "mer"},
			want:   "mer",
		},
		{
			name:   "whitespace display name falls back to project id",
			intent: Intent{SessionDisplayName: "   ", SessionID: "mer-1", ProjectID: "mer"},
			want:   "mer",
		},
		{
			name:   "missing project id falls back to session id",
			intent: Intent{SessionID: "mer-1"},
			want:   "mer-1",
		},
		{
			name:   "empty intent defaults to session",
			intent: Intent{},
			want:   "session",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sessionLabel(tc.intent); got != tc.want {
				t.Fatalf("sessionLabel = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTitleForIntentUsesProjectIDNotSessionInstance(t *testing.T) {
	intent := Intent{
		Type:      domain.NotificationNeedsInput,
		SessionID: "portfolio-10",
		ProjectID: "portfolio",
	}
	if got := titleForIntent(intent); got != "portfolio needs input" {
		t.Fatalf("title = %q, want %q", got, "portfolio needs input")
	}
}
