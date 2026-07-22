package conpty

import (
	"reflect"
	"testing"
)

func TestStripEnvAssignments(t *testing.T) {
	tests := []struct {
		name            string
		argv            []string
		wantAssignments []string
		wantRest        []string
	}{
		{
			name:            "no env prefix returns argv unchanged",
			argv:            []string{"opencode", "--agent", "ao-x"},
			wantAssignments: nil,
			wantRest:        []string{"opencode", "--agent", "ao-x"},
		},
		{
			name:            "env prefix is split from the real command",
			argv:            []string{"env", "OPENCODE_CONFIG=C:/cfg.json", "opencode", "--agent", "ao-x"},
			wantAssignments: []string{"OPENCODE_CONFIG=C:/cfg.json"},
			wantRest:        []string{"opencode", "--agent", "ao-x"},
		},
		{
			name:            "env with no command left is untouched",
			argv:            []string{"env", "A=1", "B=2"},
			wantAssignments: nil,
			wantRest:        []string{"env", "A=1", "B=2"},
		},
		{
			name:            "a binary merely starting with env is not treated as a prefix",
			argv:            []string{"envoy", "--config", "x"},
			wantAssignments: nil,
			wantRest:        []string{"envoy", "--config", "x"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotAssignments, gotRest := stripEnvAssignments(tt.argv)
			if !reflect.DeepEqual(gotAssignments, tt.wantAssignments) {
				t.Errorf("assignments = %#v, want %#v", gotAssignments, tt.wantAssignments)
			}
			if !reflect.DeepEqual(gotRest, tt.wantRest) {
				t.Errorf("rest = %#v, want %#v", gotRest, tt.wantRest)
			}
		})
	}
}
