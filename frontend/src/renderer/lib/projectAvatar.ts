// Deterministic avatar generation per project. Colors are randomly picked
// once and stored in localStorage so they survive reloads and sessions.

const STORAGE_KEY = (id: string) => `ao-project-avatar-${id}`;

// Curated oklch hues — well-separated, readable in dark + light mode.
const HUES = [4, 25, 47, 85, 142, 172, 199, 217, 250, 270, 295, 325];

function pickRandom<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

function generate(): { bg: string; fg: string } {
	const hue = pickRandom(HUES);
	// bg: mid-dark, muted chroma; fg: lighter, more vivid — same hue family.
	const bg = `oklch(0.27 0.07 ${hue})`;
	const fg = `oklch(0.80 0.13 ${hue})`;
	return { bg, fg };
}

export type ProjectAvatar = {
	bg: string;
	fg: string;
	initials: string;
};

export function getProjectAvatar(projectId: string, projectName: string): ProjectAvatar {
	const key = STORAGE_KEY(projectId);
	const initials =
		(projectName[0] ?? "?").toUpperCase() + (projectName[1] ?? "");

	let stored: { bg: string; fg: string } | null = null;
	try {
		const raw = localStorage.getItem(key);
		if (raw) stored = JSON.parse(raw) as { bg: string; fg: string };
	} catch {
		// ignore corrupt entries
	}

	if (!stored) {
		stored = generate();
		try {
			localStorage.setItem(key, JSON.stringify(stored));
		} catch {
			// storage quota — best effort
		}
	}

	return { ...stored, initials };
}
