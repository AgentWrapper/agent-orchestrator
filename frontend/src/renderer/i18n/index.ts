import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../i18n/locales/en.json";
import zhCN from "../i18n/locales/zh-CN.json";

type Locale = "en" | "zh-CN"
const LOCAL_STORAGE_KEY = "ao.locale";

function getStoredLocale() : Locale | null{
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") {
        return stored;
    }
    return null;
}

function detectLocale(): Locale {
    const stored = getStoredLocale();
    if(stored) return stored;
    return navigator.language.startsWith("zh") ? "zh-CN" : "en";
}

function saveLocale(locale : Locale){
    localStorage.setItem(LOCAL_STORAGE_KEY, locale);
}

i18n.on("languageChanged", (language) => {
    if (language === "en" || language === "zh-CN") {
        saveLocale(language);
    }
    document.documentElement.lang = language;
});

export function initialiseI18n(){
    if (i18n.isInitialized) {
        return Promise.resolve(i18n);
    }
    return i18n.use(initReactI18next).init({
        resources: {
            en: {translation: en},
            "zh-CN": {translation: zhCN}
        },
        fallbackLng: "en",
        lng: detectLocale(),
        interpolation: {
            escapeValue: false,
        },
    });
}

export default i18n;