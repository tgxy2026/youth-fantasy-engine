/**
 * 世界引擎（3.0 · W4-1b-2 · 第 4 批）
 *
 * 「世界引擎」的界面：把**本项目的世界**抽成一个世界包存进**世界引擎**，
 * 之后**封存版本**（不可变），并可在别的作品里**显式引入**（引入在 W4-1c）。
 *
 * 🔴 世界引擎是**跨作品**的（`db/worlds` 非项目级数据）——这里列的是**全部**世界，
 *    不只是当前项目抽出来的那些；每条都标着来源项目。
 *
 * 【两个动作的区别】
 *   ·「新建世界」= 把**当前项目**的世界抽一份进来（= 草稿）；
 *   ·「封存」= 把当前草稿固化成**不可变版本**。
 *   抽完再改项目、想让它生效 ⇒ 必须**重新抽一份**（旧世界的草稿不会自动跟着项目变，
 *   这正是方案 §10.3 #8 的边界：「原作品后续修改不会自动同步」）。
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Globe, Loader2, Lock, Trash2 } from 'lucide-react'
import * as db from '../lib/db'
import { createWorldFromCurrentProject, draftDiffers, freezeWorld, renameWorld } from '../lib/worlds'
import type { WorldStoredRecord } from '../lib/worldTypes'
import { Button } from './Button'
import { confirmDialog, showToast } from './dialogs'
import HelpPopover from './HelpPopover'

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function WorldLibraryPanel() {
  const [list, setList] = useState<WorldStoredRecord[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  /** 哪些世界的版本历史展开着（UI 态，不放记录里） */
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({})
  /** 正在行内改名的世界 id ＋ 草稿（🔴 用行内输入，不用原生 prompt —— 项目禁原生弹窗） */
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setList(await db.listWorlds())
    } catch (e) {
      setList([])
      showToast('读取世界引擎失败：' + errText(e), 'error')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  /** 抽取当前项目的世界（草稿） */
  const doCreate = async () => {
    if (busy) return
    setBusy(true)
    try {
      const pid = db.getCurrentProjectId()
      const proj = pid ? await db.getProject(pid) : undefined
      const fallback = proj?.name ? `${proj.name} · 世界` : '未命名世界'
      const rec = await createWorldFromCurrentProject(name.trim() || fallback, proj?.name)
      setName('')
      await load()
      showToast(rec.tables.length
        ? `已把当前项目的世界抽进世界引擎（${rec.tables.length} 张表）`
        : '已新建，但当前项目的世界表还是空的 —— 先去「世界设定 / 力量体系 / 世界构建」填内容')
    } catch (e) {
      showToast('抽取失败：' + errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const doFreeze = async (w: WorldStoredRecord) => {
    if (busy) return
    setBusy(true)
    try {
      const next = await freezeWorld(w.id)
      await load()
      showToast(`已封存 v${next?.versions.length ?? ''} —— 这一版从此不可改写`)
    } catch (e) {
      showToast('封存失败：' + errText(e), 'error')
    } finally { setBusy(false) }
  }

  /** 行内改名的提交（回车 / 失焦保存，Esc 放弃） */
  const commitRename = async () => {
    if (!renaming) return
    const { id, text } = renaming
    setRenaming(null)
    try {
      await renameWorld(id, text)
      await load()
    } catch (e) {
      showToast('重命名失败：' + errText(e), 'error')
    }
  }

  const doDelete = async (w: WorldStoredRecord) => {
    const okDel = await confirmDialog({
      title: '删除这个世界',
      message: `删除「${w.name}」及其全部版本历史（${w.versions.length} 个版本）？此操作不可撤销。\n\n（已引入到其它作品里的世界**不受影响** —— 引入是快照复制。）`,
      danger: true,
    })
    if (!okDel) return
    try {
      await db.deleteWorld(w.id)
      await load()
      showToast('已删除')
    } catch (e) {
      showToast('删除失败：' + errText(e), 'error')
    }
  }

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 flex flex-wrap items-center gap-2 border-b border-ink-700 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">世界引擎</h1>
        <HelpPopover title="世界引擎怎么用" width="24rem" size={14}>
          这里放的是**可封存、可跨作品引用**的世界。
          {'\n\n'}· 「新建世界」把**当前项目**的世界（世界设定 / 力量体系 / 制度四页签 / 世界构建组）抽一份进来 —— 这一步不改项目里的任何数据。
          {'\n\n'}· 「封存」把当前内容固化成**不可变版本**：封存之后，再改项目里的世界也不会动到这一版。
          {'\n\n'}· 世界引擎是**跨作品**的：换一本书，这里的世界照样在；将来也能在别的作品里显式引入某一版。
          {'\n\n'}· 🔴 反向不成立：改了项目里的世界，**已经抽出来的世界不会自动更新** —— 想要新的，就再抽一份。这是「派生须显式、不自动同步」的边界。
        </HelpPopover>
        <span className="text-11 text-ink-500">把世界抽出来·封版·将来给别的作品引用</span>

        <div className="ml-auto flex items-center gap-2">
          <input
            className="h-9 w-52 bg-ink-900 border border-ink-700 rounded-lg px-3 text-13 text-ink-100 outline-none focus:border-amber/50"
            placeholder="世界名称（留空自动取）"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void doCreate() }}
          />
          <Button variant="primary" size="md" disabled={busy} onClick={() => void doCreate()}>
            ＋ 从当前项目新建世界
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto pt-3">
        {list === null ? (
          <div className="flex items-center justify-center py-10 gap-2 text-ink-400">
            <Loader2 size={16} className="animate-spin text-amber" />
            <span className="text-13">读取中…</span>
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-4 text-12 leading-relaxed text-ink-400">
            世界引擎还是空的。<b className="text-ink-200">「＋ 从当前项目新建世界」</b>会把这本书的世界
            （世界设定 / 力量体系 / 制度四页签 / 世界构建组）抽一份进来 —— 之后可以封存版本，
            将来在别的作品里引用同一份世界。
          </div>
        ) : (
          <div className="space-y-2">
            {list.map(w => {
              const differs = draftDiffers(w)
              const last = w.versions[w.versions.length - 1]
              const expanded = !!openIds[w.id]
              return (
                <div key={w.id} className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Globe size={14} className="text-amber shrink-0" />
                    {renaming?.id === w.id ? (
                      <input
                        autoFocus
                        className="w-48 bg-ink-900 border border-amber/40 rounded-md px-2 py-0.5 text-12 text-ink-100 outline-none"
                        value={renaming.text}
                        onChange={e => setRenaming({ id: w.id, text: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void commitRename()
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => void commitRename()}
                      />
                    ) : (
                      <span className="min-w-0 truncate text-13 font-semibold text-ink-100">{w.name}</span>
                    )}
                    <span className="text-10 text-ink-500">
                      {w.tables.length} 张表 · {w.versions.length} 个版本 · 最近改动 {fmt(w.updatedAt)}
                    </span>
                    {differs && (
                      <span className="rounded border border-amber/30 bg-amber/10 px-1.5 py-0.5 text-10 text-amber">
                        有未封存的改动
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void doFreeze(w)}>
                        <Lock size={11} /> 封存版本
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setRenaming({ id: w.id, text: w.name })}>重命名</Button>
                      <Button variant="secondary" size="sm" onClick={() => void doDelete(w)}>
                        <Trash2 size={11} />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-1.5 text-10 leading-relaxed text-ink-500">
                    来源：{w.origin.projectName || '（项目已删）'} · {fmt(w.origin.at)} ·
                    指纹 <span className="font-mono text-ink-400">{w.fingerprint}</span>
                    {last && <> · 最新版本 v{last.v}（{fmt(last.at)}）</>}
                  </div>

                  {w.versions.length > 0 && (
                    <div className="mt-1.5">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-10 text-ink-400 hover:text-ink-100"
                        onClick={() => setOpenIds(p => ({ ...p, [w.id]: !p[w.id] }))}
                      >
                        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        版本历史（{w.versions.length}）
                      </button>
                      {expanded && (
                        <div className="mt-1 space-y-1 border-l-2 border-ink-700 pl-2">
                          {w.versions.slice().reverse().map(v => (
                            <div key={v.v} className="text-10 leading-relaxed text-ink-400">
                              <span className="text-ink-200">v{v.v}</span> · {fmt(v.at)} ·
                              <span className="font-mono ml-1">{v.fingerprint}</span>
                              {v.note && <span className="ml-1 text-ink-500">「{v.note}」</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
