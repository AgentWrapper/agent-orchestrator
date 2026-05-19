---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
---

Wire CLI activity events into `ao start`, `ao stop`, `ao spawn`, `ao update`, `ao setup`, `ao migrate-storage`, and shared CLI helpers. `ao events list --source cli` now answers RCA questions like "did AO start cleanly?", "was AO killed or did it crash?", and "did `ao spawn`/`ao stop` fail and why?". Adds `"cli"` to the `ActivityEventSource` union and 30+ event-emit sites covering startup, graceful and forced shutdown, restore, project resolution, config recovery, and migration paths.
