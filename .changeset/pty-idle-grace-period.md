---
"@aoagents/ao-web": patch
---

Defer killing idle terminal PTYs by 30s in the mux server so that quick reconnects (tab reload, sleep/wake, network blip) reuse the existing PTY instead of allocating a fresh one. macOS never recycles ptmx slot numbers within a boot, so churning PTYs across these events used to drain `kern.tty.ptmx_max` (511) over weeks of dashboard uptime. (#1718)
