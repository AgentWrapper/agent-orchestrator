// Keep the platform-specific browser component as a quiet implementation
// detail during normal development. Release preparation remains verbose.
process.argv.push("--quiet");
await import("./prepare-agent-browser.mjs");
