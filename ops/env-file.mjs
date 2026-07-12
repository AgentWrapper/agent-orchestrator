import { readFileSync } from "node:fs";

// Load KEY=value lines without overriding values explicitly supplied by the
// process supervisor. Missing files are an empty overlay so the caller can
// decide which variables are required.
export function loadEnvFile(file, env = process.env) {
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (match && !(match[1] in env)) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
		}
	} catch {}
	return env;
}
