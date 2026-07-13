import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { aoBridge } from "../lib/bridge";
import type { ProviderCredentials } from "../../main/provider-credentials";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export const providerCredentialsQueryKey = ["provider-credentials"] as const;

// ProviderCredentialsSection is the Global Settings card for user-scoped provider
// credentials (issue #2614). It reads/writes ~/.ao/provider-credentials.json via
// the main process, letting a user set ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and
// ANTHROPIC_AUTH_TOKEN for all spawned sessions. Project-level env overrides these
// on a key-by-key basis.
export function ProviderCredentialsSection() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: providerCredentialsQueryKey,
		queryFn: () => aoBridge.providerCredentials.get(),
	});

	const [form, setForm] = useState<ProviderCredentials>({});
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		if (query.data) setForm(query.data);
	}, [query.data]);

	const save = useMutation({
		mutationFn: async (next: ProviderCredentials) => {
			await aoBridge.providerCredentials.set(next);
		},
		onSuccess: () => {
			setSavedAt(Date.now());
			void queryClient.invalidateQueries({ queryKey: providerCredentialsQueryKey });
		},
	});

	const setField = (field: keyof ProviderCredentials) => (e: React.ChangeEvent<HTMLInputElement>) => {
		setSavedAt(null);
		setForm((f) => ({ ...f, [field]: e.target.value.trim() || undefined }));
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-control">Provider credentials</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="providerApiKey" className="text-xs text-muted-foreground">
						API Key (ANTHROPIC_API_KEY)
					</Label>
					<Input
						id="providerApiKey"
						type="password"
						value={form.apiKey ?? ""}
						onChange={setField("apiKey")}
						placeholder="sk-ant-…"
						className="h-control-form text-control"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="providerBaseURL" className="text-xs text-muted-foreground">
						Base URL (ANTHROPIC_BASE_URL)
					</Label>
					<Input
						id="providerBaseURL"
						type="text"
						value={form.baseURL ?? ""}
						onChange={setField("baseURL")}
						placeholder="https://api.anthropic.com"
						className="h-control-form text-control"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="providerAuthToken" className="text-xs text-muted-foreground">
						Auth Token (ANTHROPIC_AUTH_TOKEN)
					</Label>
					<Input
						id="providerAuthToken"
						type="password"
						value={form.authToken ?? ""}
						onChange={setField("authToken")}
						placeholder="Bearer token override"
						className="h-control-form text-control"
					/>
				</div>

				<div className="flex items-center gap-3">
					<Button type="button" variant="primary" onClick={() => save.mutate(form)} disabled={save.isPending}>
						{save.isPending ? "Saving…" : "Save changes"}
					</Button>
					{save.isError && (
						<span className="text-xs text-error">
							{save.error instanceof Error ? save.error.message : "Save failed"}
						</span>
					)}
					{savedAt && !save.isPending && !save.isError && <span className="text-xs text-success">Saved.</span>}
				</div>
			</CardContent>
		</Card>
	);
}
