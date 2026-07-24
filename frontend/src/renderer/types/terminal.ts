export type TerminalTarget =
	| { kind: "worker" }
	| {
			kind: "reviewer";
			handleId: string;
			harness: string;
	  }
	// A standalone shell the user opened by hand — no agent session behind it,
	// so unlike "worker" and "reviewer" it carries its own handle and never
	// reads from the selected session.
	| {
			kind: "shell";
			handleId: string;
			title: string;
	  };
