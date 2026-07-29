// Wraps `import.meta.env.PROD` behind a small exported function so callers
// that need to gate on "packaged build" (e.g. UpdateWizard) get the real
// Vite-injected value in dev/prod builds, while tests can stub this module
// to force either branch regardless of vitest's own MODE (which defaults to
// "test", not "production").
export function isProdBuild(): boolean {
	return import.meta.env.PROD;
}
