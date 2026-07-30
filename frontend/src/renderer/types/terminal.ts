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
			/** Shell creation identity; prevents a reused handle inheriting old state. */
			generation: string;
			kind: "shell";
			handleId: string;
			title: string;
	  };
