# AO — Apple Watch POC

A standalone **watchOS** app that talks directly to the AO daemon's LAN listener
to view live sessions and send input (typed or dictated) from your wrist, plus
spawn a new task.

It is **independent** of the Expo/React Native phone app: its own native SwiftUI
app, its own Xcode project, committed here in git. It lives *outside* the
Expo-generated `../ios` folder, so `expo prebuild` / `expo run:ios` never touches
it.

## What it does

- **Sessions** — lists live worker sessions (`GET /api/v1/sessions`).
- **Session** — dictate or type a message → `POST /api/v1/sessions/{id}/send`.
- **New task (＋)** — pick a project, dictate a prompt → `POST /api/v1/sessions`.
- **Connect (⚙)** — host / port / password for the daemon, stored on the watch.

## Layout

```
watch/
  project.yml                 # XcodeGen spec (source of truth for the project)
  AOWatch.xcodeproj/          # generated & committed, so you can just open it
  AOWatch/
    AOWatchApp.swift          # @main entry
    AppModel.swift            # config persistence + haptics
    AOClient.swift            # the only networking; bearer auth, 12s timeout
    Models.swift              # wire types mirroring lib/api.ts
    ConnectView / SessionsView / SessionView / SpawnView
    Info.plist                # WKWatchOnly, ATS cleartext, local-network usage
    Assets.xcassets/          # AppIcon (generated) + AccentColor
  scripts/make-icon.swift     # regenerates the 1024² app icon
```

## Regenerating the Xcode project

The `.xcodeproj` is committed so you don't need any tools to open it. If you edit
`project.yml`, regenerate with [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
brew install xcodegen        # once
cd packages/mobile/watch
xcodegen generate
```

## Install on your Apple Watch

Prerequisites: watch paired to your iPhone, Xcode 16+, an Apple ID in Xcode
(Settings → Accounts). A free Apple ID works but the signing profile expires
every 7 days.

1. **Open the project:** `open packages/mobile/watch/AOWatch.xcodeproj`.
2. **Set signing:** select the **AOWatch** target → **Signing & Capabilities** →
   check *Automatically manage signing* → choose your **Team**. If the bundle id
   `com.aoagents.aowatch` is taken, change it to something unique.
3. **Enable Developer Mode on the watch:** it appears once Xcode tries to install.
   Run once (step 5); when it errors, on the watch go to **Settings → Privacy &
   Security → Developer Mode → On**, restart, and run again.
4. **Pick the destination:** at the top of Xcode choose the **AOWatch** scheme and
   your physical **Apple Watch** as the run destination.
5. **Build & Run (⌘R).** The app installs on the watch.

## Connect it to AO

1. On the desktop: **Sidebar → Settings → Connect Mobile → enable**. Note the
   **host:port** (e.g. `192.168.1.84:3011`) and **password**.
2. On the watch: open **AO → ⚙ → enter host, port `3011`, password → Test →
   Save**.
3. Sessions appear; tap one and dictate a message, or use **＋** to spawn a task.

## Known limitations (POC)

- **Reachability:** the watch reaches your LAN Mac when near the phone (proxying
  through it) or on the same Wi-Fi; not when away on cellular.
- **Password** is stored in `UserDefaults`, not the Keychain (the phone app uses
  the Keychain). Fine for a personal-device POC; harden before shipping.
- No live terminal output, PRs, or orchestrator screens — send-only.
