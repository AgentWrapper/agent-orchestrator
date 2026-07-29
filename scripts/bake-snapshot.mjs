// One-time (admin) build of the pre-baked cloud sandbox snapshot.
// Bakes tmux + claude-code into a Daytona snapshot so cloud sessions spin up in
// ~15-20s instead of installing the harness on every spawn (~4 min).
//
//   DAYTONA_API_KEY=... node scripts/bake-snapshot.mjs
//
// Produces the snapshot named in internal/cloud/recipes.go (Recipe.Snapshot).
// Uses @daytona/sdk (custom-image builds need the SDK's object-storage context
// upload; the raw REST /snapshots call does not work). Re-run after changing the
// baked toolchain, bumping the name (…-v2) and updating the recipe.
import { Daytona, Image } from "@daytona/sdk";

const NAME = process.env.AO_SNAPSHOT_NAME || "ao-claude-code-v1";
const BASE = process.env.AO_SNAPSHOT_BASE || "daytonaio/sandbox:0.8.0";

const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
// The build runs as the `daytona` user → apt needs sudo. git + node/nvm are in
// the base; bake the slow bits (tmux + claude) and symlink claude onto PATH.
const img = Image.base(BASE).runCommands(
  "sudo apt-get update -qq && sudo apt-get install -y -qq tmux && sudo rm -rf /var/lib/apt/lists/*",
  "curl -fsSL https://claude.ai/install.sh | bash",
  "sudo ln -sf $(ls /home/daytona/.local/bin/claude 2>/dev/null || echo /home/daytona/.local/bin/claude) /usr/local/bin/claude || true",
);
await d.snapshot.create({ name: NAME, image: img },
  { onLogs: (l) => process.stdout.write(l + "\n"), timeout: 600 });
console.log(`snapshot ${NAME} active`);
