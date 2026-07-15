package pipeline

import (
	"reflect"
	"testing"
)

func dependsOnStage(name string, deps ...string) Stage {
	return Stage{Name: name, DependsOn: deps}
}

func routesStage(name string, routeTo ...string) Stage {
	return Stage{
		Name: name,
		Routes: &StageRoutes{
			When: Predicate{Kind: PredicateAllPass, Stages: routeTo},
		},
	}
}

func TestFindFirstStageCycle(t *testing.T) {
	t.Run("diamond has no cycle", func(t *testing.T) {
		stages := []Stage{
			dependsOnStage("a"),
			dependsOnStage("b", "a"),
			dependsOnStage("c", "a"),
			dependsOnStage("d", "b", "c"),
		}
		if got := FindFirstStageCycle(stages); got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("direct two-node cycle", func(t *testing.T) {
		stages := []Stage{
			dependsOnStage("a", "b"),
			dependsOnStage("b", "a"),
		}
		got := FindFirstStageCycle(stages)
		want := []string{"a", "b", "a"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("transitive three-node cycle in declaration order", func(t *testing.T) {
		stages := []Stage{
			dependsOnStage("a", "c"),
			dependsOnStage("b", "a"),
			dependsOnStage("c", "b"),
		}
		got := FindFirstStageCycle(stages)
		want := []string{"a", "c", "b", "a"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("routes-edge-only cycle is detected", func(t *testing.T) {
		stages := []Stage{
			routesStage("a", "b"),
			routesStage("b", "a"),
		}
		got := FindFirstStageCycle(stages)
		want := []string{"a", "b", "a"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("trivial self-loop is skipped", func(t *testing.T) {
		stages := []Stage{
			dependsOnStage("a", "a"),
			dependsOnStage("b"),
		}
		if got := FindFirstStageCycle(stages); got != nil {
			t.Fatalf("expected nil (self-loop owned by self-ref validation), got %v", got)
		}
	})

	t.Run("disconnected components, one with a cycle", func(t *testing.T) {
		stages := []Stage{
			dependsOnStage("x"),
			dependsOnStage("y"),
			dependsOnStage("a", "b"),
			dependsOnStage("b", "a"),
		}
		got := FindFirstStageCycle(stages)
		want := []string{"a", "b", "a"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("disconnected components, none with a cycle", func(t *testing.T) {
		stages := []Stage{
			dependsOnStage("x"),
			dependsOnStage("y", "x"),
			dependsOnStage("a"),
			dependsOnStage("b", "a"),
		}
		if got := FindFirstStageCycle(stages); got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("mixed dependsOn and routes edges form the cycle", func(t *testing.T) {
		stages := []Stage{
			dependsOnStage("a", "b"),
			routesStage("b", "a"),
		}
		got := FindFirstStageCycle(stages)
		want := []string{"a", "b", "a"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})
}
