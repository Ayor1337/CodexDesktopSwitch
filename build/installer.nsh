!macro customInit
  ${IfNot} ${Silent}
    ReadRegStr $0 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ReadRegStr $1 HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $0 != ""
    ${OrIf} $1 != ""
      MessageBox MB_YESNO|MB_ICONQUESTION "检测到已安装旧版 Codex Switch。是否卸载旧版后继续安装新版？" IDYES allowUpgrade
      Abort
      allowUpgrade:
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstallSection
  Section /o "删除 Codex Switch 本机数据" UNINSTALL_USER_DATA_SECTION_ID
    ${IfNot} ${isUpdated}
      SetShellVarContext current
      RMDir /r "$APPDATA\Codex Switch"
      RMDir /r "$APPDATA\codex-switch-electron"
    ${EndIf}
  SectionEnd
!macroend
