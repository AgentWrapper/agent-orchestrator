; Durable AO state (projects, sessions, settings, worktrees) lives under
; $PROFILE\.ao — outside the install directory. Uninstall must never remove it.
; Reinstalling the desktop app reopens the existing state on next launch.
!macro customUnInstall
  DetailPrint "Keeping user data at $PROFILE\.ao (projects, sessions, settings)."
  ; Intentionally do not RMDir $PROFILE\.ao or $PROFILE\.ao\data.
!macroend
