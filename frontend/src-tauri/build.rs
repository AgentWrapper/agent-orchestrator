// Shared source of truth for every `#[tauri::command]` registered in
// `src/lib.rs`'s `generate_handler!` — see `src/command_names.rs`. Included
// textually here (build scripts are compiled standalone, outside the crate's
// own module tree, so this can't be a normal `mod` reference) so declaring a
// command in the `AppManifest` below can never drift from the actual invoke
// handler; `src/lib.rs`'s test suite additionally asserts the two lists
// agree and that `capabilities/main.json` grants every one of them.
//
// tasks/specs/T9b-browser-panel-fixes.md fix 1 (app-breaking ACL brick):
// declaring only 3 commands here flips Tauri's `has_app_acl` to `true`,
// which makes it reject EVERY app command not explicitly granted — since the
// main window had zero app-command grants, this silently broke all IPC
// (daemon_*, keybindings_*, browser_*, …) at runtime. Every command
// registered in the invoke handler MUST be declared here.
include!("src/command_names.rs");

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(ALL_COMMAND_NAMES));
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("{error:#}");
    }
}
