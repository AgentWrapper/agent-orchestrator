import { createInstance } from "i18next";

import { resources } from "../shared/i18n/resources";

export const mainI18n = createInstance();

const mainI18nOptions = {
	resources,
	lng: "en",
	fallbackLng: "en",
	supportedLngs: ["en", "zh-CN"],
	interpolation: { escapeValue: false },
	returnNull: false,
	initAsync: false,
};

void mainI18n.init(mainI18nOptions);

export const mainT = mainI18n.t.bind(mainI18n);
