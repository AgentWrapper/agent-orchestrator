import { useState } from "react";
import { ConnectMobileModal } from "./ConnectMobileModal";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

// ConnectMobileButton is the Global Settings card for pairing the mobile app
// with this desktop over the LAN bridge. It just opens ConnectMobileModal,
// which owns the enable/disable/regenerate flow.
export function ConnectMobileButton() {
	const [open, setOpen] = useState(false);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-[13px]">Connect Mobile</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-[12px] leading-5 text-muted-foreground">
					Pair the Agent Orchestrator mobile app with this desktop so you can drive sessions from your phone while on
					the same network.
				</p>
				<div>
					<Button type="button" variant="primary" onClick={() => setOpen(true)}>
						Connect Mobile
					</Button>
				</div>
			</CardContent>
			<ConnectMobileModal open={open} onOpenChange={setOpen} />
		</Card>
	);
}
