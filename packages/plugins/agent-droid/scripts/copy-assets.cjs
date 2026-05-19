const { cpSync } = require("node:fs");

cpSync("src/assets", "dist/assets", { recursive: true });
