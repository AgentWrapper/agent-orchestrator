export const OPEN_MODAL_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

export function isAnyModalOpen(): boolean {
	if (typeof document === "undefined") return false;
	return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}
