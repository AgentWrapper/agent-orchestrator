import { applyDocumentTheme, resolveTheme } from "./theme";

// Runs as the first main.tsx import, before styles.css, so data-theme is set
// before token CSS paints (avoids a light/dark flash on load).
applyDocumentTheme(resolveTheme());
