import "i18next";
import en from "./en.json";

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation";
		returnNull: false;
		keySeparator: false;
		resources: {
			translation: typeof en;
		};
	}
}
