package pipeline

// FindFirstCycle finds the first cycle in the directed graph described by an
// explicit edge list and returns it as [a, b, ..., a] (first and last element
// equal). It returns nil when the graph is acyclic.
//
// order lists every node in declaration order; edges maps a node to the nodes
// it points at. Edges naming a node absent from order are followed anyway, so
// the caller keeps ownership of the "unknown stage id" error.
//
// Trivial self-loops ([x, x]) are skipped: the explicit self-reference rule in
// the validator owns that error with a clearer message. Only multi-node cycles
// are reported here.
//
// Traversal is deterministic: nodes are visited in order, and each node's
// edges in the order given, so the returned path is stable and readable
// ("a -> b -> c -> a") rather than dependent on map iteration order.
func FindFirstCycle(order []string, edges map[string][]string) []string {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(order))

	type frame struct {
		node string
		iter int
	}

	for _, start := range order {
		if color[start] != white {
			continue
		}
		stack := []frame{{node: start}}
		path := []string{start}
		color[start] = gray

		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			neighbors := edges[top.node]
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
					// Trivial self-loop; owned by the self-reference rule.
					continue
				}
				cycle := make([]string, 0, len(path)-cycleStart+1)
				cycle = append(cycle, path[cycleStart:]...)
				return append(cycle, next)
			case white:
				color[next] = gray
				path = append(path, next)
				stack = append(stack, frame{node: next})
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
