; SoftN NSIS Installer Hooks
; Registers the shell extension for .softn file thumbnails

; Get path to shell extension DLL (same directory as main binary)
!searchreplace SHELL_EXT_PATH "${MAINBINARYSRCPATH}" "softn-loader.exe" "softn_shell_extension.dll"

!macro NSIS_HOOK_POSTINSTALL
  ; Copy and register the shell extension DLL
  SetOutPath "$INSTDIR"
  File "${SHELL_EXT_PATH}"
  ExecWait 'regsvr32 /s "$INSTDIR\softn_shell_extension.dll"'

  ; Notify shell of the change
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Unregister the shell extension DLL before removal
  ExecWait 'regsvr32 /u /s "$INSTDIR\softn_shell_extension.dll"'

  ; Notify shell of the change
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
