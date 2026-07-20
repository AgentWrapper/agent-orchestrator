package domain

import "testing"

func TestCapabilityClassesPermitImplementationOnlyForIndependentAOWorker(t *testing.T) {
	cases := []struct {
		class CapabilityClass
		allow bool
	}{
		{CapabilityClassOrchestrator, false},
		{CapabilityClassAOWorker, true},
		{CapabilityClassNativeSubagent, false},
	}
	for _, tc := range cases {
		t.Run(string(tc.class), func(t *testing.T) {
			if got := tc.class.AllowsImplementation(); got != tc.allow {
				t.Fatalf("AllowsImplementation() = %v, want %v", got, tc.allow)
			}
		})
	}
}
