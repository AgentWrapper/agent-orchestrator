import { Platform } from "react-native";
import { ApiError } from "./api";
import { classifyConnectionFailure, describeConnectionFailure } from "./connectionError";

// Human copy for a failed agent-catalog fetch. Lives here rather than in
// `agentPicker.ts` (which is pure and unit-tested) because it reads Platform.OS,
// and rather than in the spawn screen because the agent sheet route needs it too.
export function agentErrorCopy(e: unknown): string {
	const status = e instanceof ApiError ? e.status : undefined;
	return describeConnectionFailure(classifyConnectionFailure(status), {
		host: "",
		port: "",
		platform: Platform.OS,
	}).title;
}
