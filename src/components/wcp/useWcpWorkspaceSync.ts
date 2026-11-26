/**
 * 本地 Agent 工作区 · 全局保鲜调度（3.7.4 · W3）。
 *
 * 挂在 App 里，负责三件事：
 *   ① 切换项目后探活一次；`remind-on-open` 模式下有新改动只弹一次温和提示；
 *   ② `auto-interval` 模式下按配置节拍在后台检查，有改动才静默增量写盘；
 *   ③ 窗口转入后台前补刷一次（只在定时模式、且确实过期时）。
 *
 * 🔴 不渲染任何 UI、不占宿主模式租约；提示统一走既有 `showToast`。
 * 🔴 只在「曾同步过 / 显式启用」的书上工作；从未用过 WCP-Local 的书零打扰。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { showToast } from '@/components/dialogs/dialogs'
import { loadWcpGlobalConfig } from '@/lib/wcp/wcpSettings'
import {
  maybeAutoSyncWcpWorkspace,
  probeWcpWorkspace,
  syncWcpWorkspace,
  type WcpWorkspaceStatus,
} from '@/lib/wcp/wcpWorkspaceSync'
import type { WcpGlobalConfig } from '@/lib/wcp/wcpTypes'

/** 设置页保存后广播：让 App 层立即按新策略重排定时器 */
export const WCP_WORKSPACE_CONFIG_EVENT = 'yfe:wcp-workspace-config'

export function useWcpWorkspaceSync(projectId: string | null): {
  status: WcpWorkspaceStatus | null
  busy: boolean
  refresh: () => Promise<void>
  syncNow: () => Promise<void>
} {
  const [status, setStatus] = useState<WcpWorkspaceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [cfg, setCfg] = useState<WcpGlobalConfig | null>(null)
  const notifiedRef = useRef('')
  const projectRef = useRef<string | null>(projectId)
  projectRef.current = projectId

  const refresh = useCallback(async () => {
    const pid = projectRef.current
    if (!pid) { setStatus(null); return }
    try {
      const next = await probeWcpWorkspace(pid)
      if (projectRef.current !== pid) return
      setStatus(next)
    } catch { /* 探活失败不打断创作；下次定时会重试 */ }
  }, [])

  const syncNow = useCallback(async () => {
    const pid = projectRef.current
    if (!pid || busy) return
    setBusy(true)
    try {
      const r = await syncWcpWorkspace({ pid, reason: 'manual', allowZipFallback: true })
      if (!r.ok) {
        showToast(`工作区更新失败：${r.error || '未知原因'}`, 'error', 6000)
      } else if (r.mode === 'zip') {
        showToast('已打包下载离线工作区；解压后即可交给本地 Agent。', 'success')
      } else if (r.skipped) {
        showToast('工作区已是最新，无需写盘。', 'info')
      } else {
        showToast(`工作区已更新：写入 ${r.wrote} 个文件${r.deleted ? `，清理 ${r.deleted} 个过期文件` : ''}。`, 'success')
      }
      await refresh()
    } catch (e) {
      showToast('工作区更新失败：' + (e instanceof Error ? e.message : String(e)), 'error', 6000)
    } finally {
      setBusy(false)
    }
  }, [busy, refresh])

  // 切项目：重置提示去重键并探活一次
  useEffect(() => {
    notifiedRef.current = ''
    setStatus(null)
    if (!projectId) return
    let active = true
    void (async () => {
      const [g] = await Promise.all([loadWcpGlobalConfig()])
      if (!active) return
      setCfg(g)
      void refresh()
    })()
    return () => { active = false }
  }, [projectId, refresh])

  // 设置变化：重新读取策略（定时 / 提醒 / 手动）
  useEffect(() => {
    const reload = () => {
      void loadWcpGlobalConfig().then(g => {
        setCfg(g)
        void refresh()
      }).catch(() => { /* 读不到就沿用旧策略 */ })
    }
    window.addEventListener(WCP_WORKSPACE_CONFIG_EVENT, reload)
    return () => window.removeEventListener(WCP_WORKSPACE_CONFIG_EVENT, reload)
  }, [refresh])

  // 打开提醒：同一本书 + 同一指纹只提示一次
  useEffect(() => {
    if (!cfg || !status || !projectId) return
    if (cfg.workspaceSyncMode !== 'remind-on-open') return
    if (status.freshness !== 'stale' || !status.enabled) return
    const key = `${projectId}:${status.workspaceFingerprint}`
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    showToast('本地 Agent 工作区有新改动：可在「模型设置 → WCP 模式」或「WCP 导出」里一键更新。', 'info', 7000)
  }, [cfg, status, projectId])

  // 定时静默滚刷 + 转入后台前补刷
  useEffect(() => {
    if (!cfg || !projectId || cfg.workspaceSyncMode !== 'auto-interval') return
    const tick = () => {
      const pid = projectRef.current
      if (!pid) return
      void maybeAutoSyncWcpWorkspace(pid).then(async r => {
        if (!r) return
        if (!r.ok) showToast(`工作区自动更新失败：${r.error || '未知原因'}`, 'error', 6000)
        await refresh()
      }).catch(() => { /* 单次失败不影响后续节拍 */ })
    }
    const timer = window.setInterval(tick, Math.max(1, cfg.workspaceSyncIntervalMin) * 60_000)
    return () => window.clearInterval(timer)
  }, [cfg, projectId, refresh])

  useEffect(() => {
    if (!cfg || cfg.workspaceSyncMode !== 'auto-interval') return
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return
      const pid = projectRef.current
      if (!pid) return
      void maybeAutoSyncWcpWorkspace(pid, { force: true }).catch(() => { /* 后台补刷失败下次再说 */ })
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [cfg])

  return { status, busy, refresh, syncNow }
}