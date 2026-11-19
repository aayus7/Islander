; Islander installer hooks (Tauri NSIS).
; Close a running copy before installing; on uninstall give Windows back its own
; popups and remove the "open at login" entry.

!macro ISLANDER_CLOSE
  ; Ask a running copy to quit, then make sure it's gone so files can be replaced.
  nsExec::Exec 'taskkill /IM "Islander.exe" /T'
  Sleep 800
  nsExec::Exec 'taskkill /F /IM "Islander.exe" /T'
  Sleep 300
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ISLANDER_CLOSE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ISLANDER_CLOSE
  ; Give Windows back its own notification banners (Islander hides them while it runs).
  IfFileExists "$INSTDIR\Islander.exe" 0 +2
    ExecWait '"$INSTDIR\Islander.exe" --restore-windows'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Islander"
!macroend
