
import { useEffect, useState } from 'react'
import { Feather, FolderOpen, FilePlus2, HardDriveDownload, Loader2, Save } from 'lucide-react'
import {

  isFSASupported, openDataFile, createDataFile, getState, subscribe, flush, APP_VERSION,
} from '../lib/portable'
import { Button } from './Button'

/**
 * 便携版启动页：每次启动需要用户授权一次 U 盘数据文件
 * （浏览器安全策略要求文件读写必须由用户手势触发，无法静默读取）
 */
export function PortableGate() {
  const [state, setState] = useState(getState())
  const [busy, setBusy] = useState<'open' | 'create' | null>(null)
  useEffect(() => subscribe(() => setState(getState())), [])

  const fsa = isFSASupported()

  const doOpen = async () => {
    setBusy('open')
    try { await openDataFile() } finally { setBusy(null) }
  }
  const doCreate = async () => {
    setBusy('create')
    try { await createDataFile() } finally { setBusy(null) }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-ink-950 p-6 overflow-y-auto">
      <div className="w-full max-w-lg rounded-2xl border border-ink-700/60 bg-ink-900 p-8 shadow-2xl page-enter">
        {/* 品牌区 */}
        <header className="mb-7 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber/15 border border-amber/30 mb-4">
            <Feather size={26} className="text-amber" />
          </div>
          <h1 className="text-xl font-bold text-ink-50 tracking-wide">青春幻想引擎 <span className="text-amber text-sm font-normal">便携版 {APP_VERSION === '开发版' ? '开发版' : `v${APP_VERSION}`}</span></h1>
          <p className="mt-2 text-[13px] text-ink-400">数据保存在 U 盘的数据文件里 · 插上任意电脑即可继续创作</p>
        </header>

        {/* 浏览器不支持提示 */}
        {!fsa && (
          <div className="mb-5 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">
            当前浏览器不支持直接读写 U 盘文件。请使用 <b>Chrome</b> 或 <b>Edge</b> 浏览器打开本应用（双击 START.bat 会自动优先使用它们）。
          </div>
        )}

        {/* 主操作 */}
        <div className="space-y-3">
          <Button onClick={doOpen}
            disabled={!!busy || !fsa} variant="primary" size="md" className="w-full flex items-center text-left">
            {busy === 'open'
              ? <Loader2 size={22} className="text-amber animate-spin shrink-0" />
              : <FolderOpen size={22} className="text-amber shrink-0" />}
            <span>
              <span className="block text-[15px] font-semibold text-ink-50">打开数据文件（继续创作）</span>
              <span className="block mt-0.5 text-[12px] text-ink-400">选择 U 盘里已有的「我的小说库」数据文件</span>
            </span>
          </Button>

          <Button onClick={doCreate}
            disabled={!!busy || !fsa} variant="secondary" size="md" className="w-full flex items-center bg-ink-850 text-left">
            {busy === 'create'
              ? <Loader2 size={22} className="text-ink-300 animate-spin shrink-0" />
              : <FilePlus2 size={22} className="text-ink-300 shrink-0" />}
            <span>
              <span className="block text-[15px] font-semibold text-ink-100">新建数据文件（第一次使用）</span>
              <span className="block mt-0.5 text-[12px] text-ink-400">在 U 盘上创建一个新的数据文件，所有作品都存在里面</span>
            </span>
          </Button>
        </div>

        {/* 错误提示 */}
        {state.lastError && (
          <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-[12px] text-red-300">{state.lastError}</p>
        )}

        {/* 使用提示 */}
        <div className="mt-6 pt-5 border-t border-ink-700/60 text-[12px] text-ink-400 leading-relaxed">
          <p className="flex gap-2"><HardDriveDownload size={14} className="mt-0.5 shrink-0 text-amber/70" />
            从旧版网页迁移：先在旧版「项目列表 → 导出备份」得到 JSON，进入本应用后在项目列表选「导入备份」即可。</p>
          <p className="mt-2 pl-[22px]">修改会自动保存到数据文件（左下角有保存状态），拔出 U 盘前请确认显示「已保存」。</p>
        </div>
      </div>
    </div>
  )
}

/** 左下角保存状态徽标：显示数据文件的实时保存状态，点击立即写盘 */
export function PortableBadge() {
  const [state, setState] = useState(getState())
  useEffect(() => subscribe(() => setState(getState())), [])

  const time = state.lastSavedAt
    ? new Date(state.lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--'

  const text = state.lastError
    ? '保存出错，点击重试'
    : state.saving
      ? '正在写入 U 盘…'
      : state.dirty
        ? `待保存 · ${state.fileName}`
        : `已保存 ${time} · ${state.fileName}`

  const dotColor = state.lastError
    ? 'bg-red-500'
    : (state.saving || state.dirty)
      ? 'bg-yellow-400'
      : 'bg-emerald-500'

  return (
    <button
      onClick={() => void flush()}
      title="点击立即保存到 U 盘数据文件"
      className="fixed bottom-3 left-3 z-50 flex items-center gap-2 rounded-full border border-ink-600/80 bg-ink-900/90 px-3.5 py-1.5 text-[12px] text-ink-300 shadow-lg backdrop-blur transition-colors hover:border-amber/50 hover:text-ink-100"
    >
      <Save size={12} className="text-amber/80" />
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      {text}
    </button>
  )
}
