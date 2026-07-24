import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

type PaginationItem = number | "ellipsis-left" | "ellipsis-right";

function pageHref(page: number) {
	return page === 1 ? "/changelog" : `/changelog/page/${page}`;
}

function paginationItems(currentPage: number, totalPages: number): PaginationItem[] {
	if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
	if (currentPage <= 2) return [1, 2, 3, "ellipsis-right", totalPages];
	if (currentPage >= totalPages - 1) return [1, "ellipsis-left", totalPages - 2, totalPages - 1, totalPages];
	return [1, "ellipsis-left", currentPage - 1, currentPage, currentPage + 1, "ellipsis-right", totalPages];
}

function DirectionLink({
	page,
	direction,
	disabled,
}: {
	page: number;
	direction: "previous" | "next";
	disabled: boolean;
}) {
	const isPrevious = direction === "previous";
	const label = isPrevious ? "Previous" : "Next";
	const className =
		"inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium transition-colors";

	if (disabled) {
		return (
			<span aria-disabled="true" className={`${className} cursor-not-allowed text-muted-foreground opacity-40`}>
				{isPrevious && <ChevronLeft aria-hidden="true" className="size-4" />}
				{label}
				{!isPrevious && <ChevronRight aria-hidden="true" className="size-4" />}
			</span>
		);
	}

	return (
		<Link href={pageHref(page)} rel={isPrevious ? "prev" : "next"} className={`${className} text-foreground`}>
			{isPrevious && <ChevronLeft aria-hidden="true" className="size-4" />}
			{label}
			{!isPrevious && <ChevronRight aria-hidden="true" className="size-4" />}
		</Link>
	);
}

export function ChangelogPagination({ currentPage, totalPages }: { currentPage: number; totalPages: number }) {
	const items = paginationItems(currentPage, totalPages);

	return (
		<nav aria-label="Changelog pagination" className="border-t border-border/60 py-10">
			<div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
				<div className="justify-self-start">
					<DirectionLink page={currentPage - 1} direction="previous" disabled={currentPage === 1} />
				</div>
				<p className="text-sm font-medium text-muted-foreground">
					Page <span className="text-foreground">{currentPage}</span> of{" "}
					<span className="text-foreground">{totalPages}</span>
				</p>
				<div className="justify-self-end">
					<DirectionLink page={currentPage + 1} direction="next" disabled={currentPage === totalPages} />
				</div>
			</div>

			<div className="mt-5 flex items-center justify-center gap-1" role="group" aria-label="Changelog pages">
				{items.map((item) => {
					if (typeof item !== "number") {
						return (
							<span
								key={item}
								className="inline-flex size-9 items-center justify-center text-sm text-muted-foreground"
								aria-hidden="true"
							>
								…
							</span>
						);
					}

					const isCurrent = item === currentPage;
					return (
						<Link
							key={item}
							href={pageHref(item)}
							aria-label={`Go to page ${item}`}
							aria-current={isCurrent ? "page" : undefined}
							className={`inline-flex size-9 items-center justify-center rounded-lg border border-transparent text-sm font-medium transition-colors ${isCurrent ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
						>
							{item}
						</Link>
					);
				})}
			</div>
		</nav>
	);
}
