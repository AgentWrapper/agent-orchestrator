import "i18next";

import type { en } from "./shared/i18n/en";

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation";
		resources: {
			translation: typeof en;
		};
		returnNull: false;
	}
}
