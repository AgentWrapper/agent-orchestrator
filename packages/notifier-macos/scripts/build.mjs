#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, "..");
const distDir = resolve(packageDir, "dist");
const appName = "AO Notifier.app";
const appDir = resolve(distDir, appName);
const contentsDir = resolve(appDir, "Contents");
const macOsDir = resolve(contentsDir, "MacOS");
const resourcesDir = resolve(contentsDir, "Resources");
const executablePath = resolve(macOsDir, "ao-notifier");
const placeholderMarkerPath = resolve(resourcesDir, "ao-notifier-placeholder");
const swiftSource = resolve(packageDir, "src", "AONotifier.swift");
const sourceIconSvg = resolve(packageDir, "assets", "AppIcon.svg");

function commandExists(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4;
      const inA = x > size * 0.22 && x < size * 0.42 && y > size * 0.22 && y < size * 0.78;
      const inO =
        x > size * 0.52 &&
        x < size * 0.80 &&
        y > size * 0.22 &&
        y < size * 0.78 &&
        !(x > size * 0.60 && x < size * 0.72 && y > size * 0.34 && y < size * 0.66);
      const inABar = x > size * 0.30 && x < size * 0.50 && y > size * 0.47 && y < size * 0.57;
      const mark = inA || inO || inABar;
      raw[offset] = mark ? 255 : 20;
      raw[offset + 1] = mark ? 255 : 24;
      raw[offset + 2] = mark ? 255 : 32;
      raw[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeInfoPlist() {
  writeFileSync(
    resolve(contentsDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>ao-notifier</string>
  <key>CFBundleIdentifier</key>
  <string>com.aoagents.notifier</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>AO Notifier</string>
  <key>CFBundleDisplayName</key>
  <string>AO Notifier</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.6.0</string>
  <key>CFBundleVersion</key>
  <string>0.6.0</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSUserNotificationAlertStyle</key>
  <string>alert</string>
</dict>
</plist>
`,
  );
}

function writeIcon() {
  const iconsetDir = resolve(resourcesDir, "AppIcon.iconset");
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  const sizes = [16, 32, 64, 128, 256, 512, 1024];

  const canRenderSvgIcon = existsSync(sourceIconSvg) && commandExists("sips");
  if (canRenderSvgIcon) {
    for (const size of sizes) {
      execFileSync(
        "sips",
        [
          "-s",
          "format",
          "png",
          "--resampleHeightWidth",
          String(size),
          String(size),
          sourceIconSvg,
          "--out",
          resolve(iconsetDir, `icon_${size}x${size}.png`),
        ],
        { stdio: "ignore" },
      );
    }
  } else {
    for (const size of sizes) {
      writeFileSync(resolve(iconsetDir, `icon_${size}x${size}.png`), makePng(size));
    }
  }

  if (process.platform === "darwin" && commandExists("iconutil")) {
    try {
      execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", resolve(resourcesDir, "AppIcon.icns")], {
        stdio: "ignore",
      });
      rmSync(iconsetDir, { recursive: true, force: true });
    } catch {
      // The PNG iconset remains usable as a build artifact even if iconutil is unavailable.
    }
  }
}

function writeDistIndex() {
  writeFileSync(
    resolve(distDir, "index.js"),
    `import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const appName = "AO Notifier.app";
export const bundleId = "com.aoagents.notifier";

export function getBundledAppPath() {
  return resolve(__dirname, appName);
}
`,
  );
  writeFileSync(
    resolve(distDir, "index.d.ts"),
    `export declare const appName = "AO Notifier.app";
export declare const bundleId = "com.aoagents.notifier";
export declare function getBundledAppPath(): string;
`,
  );
}

function writePlaceholderExecutable() {
  writeFileSync(
    executablePath,
    `#!/usr/bin/env sh
echo "AO Notifier.app requires macOS with Swift tooling to build." >&2
exit 1
`,
    { mode: 0o755 },
  );
  writeFileSync(placeholderMarkerPath, "native macOS build unavailable\n");
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(macOsDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
writeInfoPlist();
writeIcon();
writeDistIndex();

if (process.platform !== "darwin" || !commandExists("swiftc")) {
  writePlaceholderExecutable();
  console.log("Built AO Notifier placeholder app (native macOS build unavailable).");
  process.exit(0);
}

execFileSync(
  "swiftc",
  [
    "-O",
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    "-framework",
    "UserNotifications",
    swiftSource,
    "-o",
    executablePath,
  ],
  { stdio: "inherit" },
);

if (commandExists("codesign")) {
  try {
    execFileSync("codesign", ["--force", "--sign", "-", appDir], { stdio: "ignore" });
  } catch {
    console.warn("Could not ad-hoc sign AO Notifier.app.");
  }
}

console.log(`Built ${appDir}`);
