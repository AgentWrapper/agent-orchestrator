import { Link2 } from "lucide-react";
import { useUiStore } from "../stores/ui-store";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const EMPTY_URLS: string[] = [];

type DetectedUrlsMenuProps = {
	sessionId: string;
	onNavigate: (url: string) => void;
};

// Popover off the Browser toolbar listing URLs the terminal has passively
// printed (e.g. a dev-server address) so the user can jump to one without
// retyping it. Hidden entirely once nothing has been detected yet.
export function DetectedUrlsMenu({ sessionId, onNavigate }: DetectedUrlsMenuProps) {
	const urls = useUiStore((state) => state.detectedUrlsBySession[sessionId] ?? EMPTY_URLS);

	if (urls.length === 0) return null;

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					aria-label={`Detected URLs (${urls.length})`}
					size="icon-sm"
					title="URLs detected in this session's terminal"
					type="button"
					variant="ghost"
				>
					<Link2 aria-hidden="true" className="size-icon-base" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72" sideOffset={8}>
				<DropdownMenuLabel>Detected URLs</DropdownMenuLabel>
				{urls.map((url) => (
					<DropdownMenuItem
						className="cursor-pointer py-2 font-mono text-xs"
						key={url}
						onSelect={() => onNavigate(url)}
					>
						<span className="block min-w-0 truncate">{url}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
