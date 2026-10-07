; ============================================================
; 自定义 NSIS 片段 —— electron-builder 会自动 include 本文件
;   （app-builder-lib/out/targets/nsis/NsisTarget.js:
;      `getResource(this.options.include, "installer.nsh")`，默认路径即
;      buildResources 目录下的 installer.nsh）
;
; 【要解决的问题】2026-10-07 · 2.9.0 事故（完整记录见 MEMORY.md 与
;   docs/2.9.0-NSIS三路径实测记录.md）：
;
;   注册表 HKCU\Software\{APP_GUID}\InstallLocation 一旦被写成**非法路径**，
;   安装器会连续踩三个坑：
;
;   ① 进程检测失准 —— allowOnlyOneInstallerInstance.nsh 的 FIND_PROCESS 拿
;      $INSTDIR 做**路径前缀**匹配：
;        Get-CimInstance Win32_Process
;          | ? { $_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') }
;      对照实测：坏值前缀命中 0，而**空前缀命中整机几乎所有进程**
;      （.NET 里 StartsWith("") 恒为 true）⇒ 弹出「XXX is running.」而实际没进程。
;
;   ② 覆盖安装必失败 —— installUtil.nsh 的 uninstallOldVersion 用注册表里的
;      InstallLocation 作为旧卸载器的工作目录：
;        ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA ... _?=$installationDir'
;      坏值 ⇒ 在一个不存在的目录里跑卸载器 ⇒ 失败 ⇒ SetErrorLevel 2 + Quit，
;      整个安装直接中止（实测退出码 2）。
;
;   ③ 装到不可预期的位置。
;
; 【关键洞察】installUtil.nsh 第 169-176 行留了一条自愈通道 ——
;   **只有当 InstallLocation 读出来是「空」时**，它才会改用 UninstallString 里的
;   卸载器路径 `GetFileParent` 反推出真实安装目录。
;   ⇒ 所以正确的兜底不是「替它猜一个目录」，而是**把非法值清掉**，让这条自愈通道生效。
;   （实测教训：先前版本改成退默认路径，反而让 $INSTDIR 与旧安装位置不一致，
;     卸载旧版仍失败、退出码同样是 2。）
;
; 【本片段的做法】
;   用 electron-builder 预留的 customInit 时机（templates/nsis/installer.nsi
;   第 79-81 行，跑在 initMultiUser 恢复完路径之后、任何安装动作之前）：
;   校验 InstallLocation 是否为合法绝对路径（「盘符 + 冒号 + 反斜杠」开头）；
;   不合法 ⇒ DeleteRegValue 清掉它 + 把 $INSTDIR 退回 per-user 默认根。
;   合法 ⇒ 什么都不做（正常安装路径**零影响**）。
; ============================================================

!include "LogicLib.nsh"

!macro customInit
  Push $0
  Push $1
  Push $2
  Push $3

  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    ; 取前 3 个字符，期望形如 "D:\"
    StrCpy $1 $0 3
    StrCpy $2 $1 1 1   ; 第 2 个字符，应为 ":"
    StrCpy $3 $1 1 2   ; 第 3 个字符，应为 "\"

    ${If} $2 != ":"
    ${OrIf} $3 != "\"
      DetailPrint "检测到不合法的安装目录记录（$0），已清除；安装器将自行反推真实目录。"
      ; 🔴 清掉坏值 —— 这样 uninstallOldVersion 会走「从 UninstallString 反推」那条自愈通道，
      ;    覆盖安装才能正常卸载旧版；否则会在不存在的目录里跑卸载器而中止。
      DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ; $INSTDIR 此刻已被 initMultiUser 填成那个坏值，一并退回默认根
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}

  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
