package pipeline

// FindFirstStageCycle finds the first cycle in the graph formed by every
// stage's DependsOn edges unioned with its Routes.When.ReferencedStages()
// edges, and returns it as [a, b, ..., a] (first and last element equal).
// Returns nil when the graph is acyclic.
//
// Both edge kinds contribute because the scheduler (a later task) waits for
// either kind of reference to reach a terminal state before evaluating a
// stage, so a cycle in either graph deadlocks the run identically. A
// routes-only cycle is just as fatal as a dependsOn-only cycle.
//
// Trivial self-loops ([x, x]) are skipped: the explicit self-reference
// validation in config.go owns that error with a clearer message. Only
// multi-node cycles are reported here.
//
// Traversal order is deterministic: stages are visited in declaration order,
// and each stage's edges are visited dependsOn-first then routes-refs,
// deduplicated preserving first-seen order (matching the old TypeScript
// implementation's Set-based edge union). This makes the returned cycle's
// path stable and readable ("a -> b -> c -> a") rather than dependent on map
// iteration order.
func FindFirstStageCycle(stages []Stage) []string {
	adjacency := make(map[string][]string, len(stages))
	for _, stage := range stages {
		var routesRefs []string
		if stage.Routes != nil {
			routesRefs = stage.Routes.When.ReferencedStages()
		}
		seen := make(map[string]bool, len(stage.DependsOn)+len(routesRefs))
		edges := make([]string, 0, len(stage.DependsOn)+len(routesRefs))
		for _, dep := range stage.DependsOn {
			if !seen[dep] {
				seen[dep] = true
				edges = append(edges, dep)
			}
		}
		for _, ref := range routesRefs {
			if !seen[ref] {
				seen[ref] = true
				edges = append(edges, ref)
			}
		}
		adjacency[stage.Name] = edges
	}

	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(stages))
	for _, stage := range stages {
		color[stage.Name] = white
	}

	type frame struct {
		node string
		iter int
	}

	for _, start := range stages {
		if color[start.Name] != white {
			continue
		}
		stack := []frame{{node: start.Name, iter: 0}}
		path := []string{start.Name}
		color[start.Name] = gray

		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			neighbors := adjacency[top.node]
			if top.iter >= len(neighbors) {
				color[top.node] = black
				stack = stack[:len(stack)-1]
				path = path[:len(path)-1]
				continue
			}
			next := neighbors[top.iter]
			top.iter++

			switch color[next] {
			case gray:
				cycleStart := indexOf(path, next)
				if cycleStart == len(path)-1 {
					// Trivial self-loop; owned by explicit self-ref validation.
					continue
				}
				cycle := append([]string{}, path[cycleStart:]...)
				return append(cycle, next)
			case white:
				color[next] = gray
				path = append(path, next)
				stack = append(stack, frame{node: next, iter: 0})
			}
		}
	}
	return nil
}

func indexOf(path []string, name string) int {
	for i, n := range path {
		if n == name {
			return i
		}
	}
	return -1
}
