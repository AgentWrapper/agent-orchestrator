package pipeline

import (
	"reflect"
	"testing"
)

func TestFindFirstCycle(t *testing.T) {
	tests := []struct {
		name  string
		order []string
		edges map[string][]string
		want  []string
	}{
		{
			name:  "diamond has no cycle",
			order: []string{"a", "b", "c", "d"},
			edges: map[string][]string{"a": {"b", "c"}, "b": {"d"}, "c": {"d"}},
		},
		{
			name:  "direct two-node cycle",
			order: []string{"a", "b"},
			edges: map[string][]string{"a": {"b"}, "b": {"a"}},
			want:  []string{"a", "b", "a"},
		},
		{
			name:  "transitive three-node cycle in declaration order",
			order: []string{"a", "b", "c"},
			edges: map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"a"}},
			want:  []string{"a", "b", "c", "a"},
		},
		{
			name:  "trivial self-loop is skipped",
			order: []string{"a", "b"},
			edges: map[string][]string{"a": {"a"}},
		},
		{
			name:  "self-loop does not hide a real cycle on the same node",
			order: []string{"a", "b"},
			edges: map[string][]string{"a": {"a", "b"}, "b": {"a"}},
			want:  []string{"a", "b", "a"},
		},
		{
			name:  "disconnected components, one with a cycle",
			order: []string{"x", "y", "a", "b"},
			edges: map[string][]string{"y": {"x"}, "a": {"b"}, "b": {"a"}},
			want:  []string{"a", "b", "a"},
		},
		{
			name:  "disconnected components, none with a cycle",
			order: []string{"x", "y", "a", "b"},
			edges: map[string][]string{"y": {"x"}, "b": {"a"}},
		},
		{
			name:  "edge order decides which cycle is reported first",
			order: []string{"a", "b", "c"},
			edges: map[string][]string{"a": {"c", "b"}, "b": {"a"}, "c": {"a"}},
			want:  []string{"a", "c", "a"},
		},
		{
			name:  "empty graph",
			order: nil,
			edges: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FindFirstCycle(tt.order, tt.edges)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("FindFirstCycle() = %v, want %v", got, tt.want)
			}
		})
	}
}
