import {
	Daytona,
	DaytonaAuthenticationError,
	DaytonaAuthorizationError,
	DaytonaConnectionError,
	DaytonaError,
	DaytonaTimeoutError,
} from "@daytona/sdk";
import type { DaytonaKeyValidationResult } from "../../shared/cloud";

type SandboxIterator = AsyncIterableIterator<unknown>;

export type DaytonaClient = {
	list(query?: { limit?: number }): SandboxIterator;
};

type DaytonaClientFactory = (apiKey: string) => DaytonaClient;

const defaultClientFactory: DaytonaClientFactory = (apiKey) => new Daytona({ apiKey });

export class DaytonaSupervisor {
	private client: DaytonaClient | null = null;

	constructor(private readonly createClient: DaytonaClientFactory = defaultClientFactory) {}

	async validateApiKey(value: unknown): Promise<DaytonaKeyValidationResult> {
		if (typeof value !== "string" || value.trim() === "") {
			throw new Error("Enter a Daytona API key.");
		}

		this.client = null;
		try {
			const candidate = this.createClient(value.trim());
			const sandboxes = candidate.list({ limit: 1 });
			await sandboxes.next();
			await sandboxes.return?.();
			this.client = candidate;
		} catch (error) {
			throw new Error(validationMessage(error));
		}

		return { ok: true };
	}

	isConfigured(): boolean {
		return this.client !== null;
	}
}

function validationMessage(error: unknown): string {
	if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaAuthorizationError) {
		return "Daytona API key is invalid or does not have access.";
	}
	if (error instanceof DaytonaConnectionError || error instanceof DaytonaTimeoutError) {
		return "Could not reach Daytona. Check your connection and try again.";
	}
	if (error instanceof DaytonaError) {
		return "Daytona rejected the API key. Check it and try again.";
	}
	return "Could not validate the Daytona API key.";
}
