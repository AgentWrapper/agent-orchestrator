import { SignedIn, SignedOut, SignInButton, SignOutButton, UserButton } from "@clerk/clerk-react";
import { Cloud, LogOut } from "lucide-react";

/**
 * Cloud account controls for the sidebar footer.
 *
 * Signed out → a "Sign in to cloud" trigger that opens Clerk's modal. Signed in
 * → the account avatar (Clerk UserButton, for manage-account) plus an explicit
 * "Sign out" button so it's a clear toggle — no hunting through a menu.
 * Authentication is required only for HOSTED cloud sessions (the control plane
 * verifies the JWT); local sessions never touch it.
 */
export function CloudAuthControls() {
	return (
		<>
			<SignedOut>
				<SignInButton mode="modal">
					<button
						aria-label="Sign in to cloud"
						className="flex w-full items-center justify-center gap-2.5 rounded-settings-row bg-interactive-hover px-2.5 py-2.5 text-control font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground [&_svg]:size-icon-lg [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
						type="button"
					>
						<Cloud aria-hidden="true" />
						<span className="tracking-tight">Sign in to cloud</span>
					</button>
				</SignInButton>
			</SignedOut>
			<SignedIn>
				<div className="flex w-full items-center gap-2 rounded-settings-row bg-interactive-hover px-2.5 py-1.5 text-control font-medium text-muted-foreground">
					<UserButton />
					<SignOutButton>
						<button
							aria-label="Sign out of cloud"
							title="Sign out of cloud"
							className="flex flex-1 items-center justify-center gap-2 rounded-settings-row px-1.5 py-1.5 text-control font-medium text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-icon-base [&_svg]:shrink-0"
							type="button"
						>
							<LogOut aria-hidden="true" />
							<span className="tracking-tight">Sign out</span>
						</button>
					</SignOutButton>
				</div>
			</SignedIn>
		</>
	);
}
