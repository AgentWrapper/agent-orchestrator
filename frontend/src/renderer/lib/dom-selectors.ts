export const OPEN_DIALOG_OR_MENU_SELECTOR =
	'[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]';

export function isDialogOrMenuOpen(): boolean {
	if (typeof document === "undefined") return false;
	return document.querySelector(OPEN_DIALOG_OR_MENU_SELECTOR) !== null;
}
