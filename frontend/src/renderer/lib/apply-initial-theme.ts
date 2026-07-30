import { applyDocumentTheme, applyDocumentThemeStyle, readStoredThemeStyle, resolveTheme } from "./theme";

// Runs as the first main.tsx import, before styles.css, so data-theme and
// data-style-theme are both set before token CSS paints (avoids a flash).
applyDocumentTheme(resolveTheme());
applyDocumentThemeStyle(readStoredThemeStyle());
