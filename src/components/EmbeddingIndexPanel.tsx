/**
 * 语义检索 · 嵌入模型与索引状态（2.8.0 · 台账 #013）
 *
 * 挂在「模型设置 → 模型配置」正下方（与「AI 用途路由」并肩）—— 它是模型能力的延伸：
 * 走的是同一份 `providers`，只是换了个用途（向量化而非对话）。
 *
 * 两件事在一块里说清：
 *   ① **嵌入模型选哪个**（从上面已配好的模型里挑；单独填模型名，如 Ollama 的 nomic-embed-text）；
 *   ② **索引建到哪了**（已索引 N 章 / M 块 · 用的是哪个模型）+ 更新 / 重建 / 清空。
 *
 * 🔴 三条界面纪律（都是本项目踩过的坑）：
 *   · 「异步落盘 + 通知界面刷新」**先 await 写盘再刷新** —— 否则面板读到的是写盘前的旧值
 *     （`AIConfigPanel.syncTavernTuning` 就是栽在这上面，见 MEMORY 记录）。
 *   · 长任务是**跨页签存活**的活，必须走 `useTaskRunner`（切走再回来结果还在），
 *     不能把 loading/进度放在组件自己的 useState 里。
 *   · 未配置时按钮**置灰并写明原因**（`embeddingStatus` 给原因），不让作者点了才发现不能跑。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Database, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/Button'
import HelpPopover from '@/components/HelpPopover'
import AIDataSourceNote from '@/components/AIDataSourceNote'
import { confirmDialog, showToast } from '@/components/dialogs'
import { useTaskRunner } from '@/lib/aiTaskCenter'
import * as db from '@/lib/db'
import type { AIProvider } from '@/lib/ai'
import {
  loadEmbeddingSettings, saveEmbeddingSettings, resolveEmbedConfig, embeddingStatus,
  DEFAULT_EMBEDDING, type EmbeddingSettings,
} from '@/lib/semantic/settings'
import { rebuildIndex, indexStatus, type IndexProgress, type IndexStatus } from '@/lib/semantic/indexer'
import { clearProjectVectors } from '@/lib/semantic/store'

interface Props {
  /** 已配好的模型列表（与上面的「模型配置」同一份） */
  providers: AIProvider[]
}

interface IndexRunResult {
  ok: boolean
  docs: number
  chunks: number
  skipped: number
  removed: number
  error?: string
}

export default function EmbeddingIndexPanel({ providers }: Props) {
  const [settings, setSettings] = useState<EmbeddingSettings>({ ...DEFAULT_EMBEDDING })
  const [model, setModel] = useState('')
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [hint, setHint] = useState('')
  /** 自增：触发重新读数（写盘之后才动它，见文件头纪律） */
  const [ver, setVer] = useState(0)

  const projectId = db.getCurrentProjectId()
  const runner = useTaskRunner<IndexRunResult, IndexProgress>({
    ownerTab: 'model-settings',
    kind: 'semantic-index',
    title: '建立语义索引',
    writes: ['embeddings'],
  })

  const refresh = useCallback(async () => {
    const s = await loadEmbeddingSettings()
    setSettings(s)
    setModel(s.model)
    // 两件事互不依赖，并行取；都取完再一起 setState（避免中间态闪一下）
    const [cfg, st] = await Promise.all([
      resolveEmbedConfig(s, providers),
      embeddingStatus(s, providers),
    ])
    // ⚠️ 项目 id 也要现取：面板可能跨项目存活着
    const idx = await indexStatus(db.getCurrentProjectId(), cfg)
    setStatus(idx)
    setHint(st.reason)
  }, [providers])

  useEffect(() => { void refresh() }, [refresh, ver])

  // 任务一结束就重新读一次状态（索引数变了）；只认已结束的状态，running 时不动
  const taskStatus = runner.task?.status
  useEffect(() => {
    if (taskStatus === 'done' || taskStatus === 'failed') setVer(v => v + 1)
  }, [taskStatus])

  /** 🔴 先落盘、**await 完成**，再刷新 —— 顺序反了会读到写盘前的旧值 */
  const persist = async (patch: Partial<EmbeddingSettings>) => {
    await saveEmbeddingSettings(patch)
    setVer(v => v + 1)
  }

  const doRebuild = async (full: boolean) => {
    if (db.getCurrentProjectId() !== projectId) {
      showToast('项目已切换，请重新操作', 'error')
      return
    }
    const cfg = await resolveEmbedConfig(settings, providers)
    if (!cfg) {
      showToast(hint || '请先选择嵌入模型', 'error')
      return
    }
    runner.run(
      async ctx => rebuildIndex({ projectId, cfg, signal: ctx.signal, onProgress: ctx.progress, full }),
      info => {
        const r = info.result
        if (info.status === 'done' && r?.ok) {
          const parts = [`已索引 ${r.docs} 条来源 / ${r.chunks} 块`]
          if (r.skipped) parts.push(`跳过未变的 ${r.skipped} 块`)
          if (r.removed) parts.push(`清理已删来源 ${r.removed} 条`)
          return { text: `「建立语义索引」完成：${parts.join(' · ')}`, kind: 'success' as const }
        }
        if (info.status === 'done' && r && !r.ok) {
          return { text: `「建立语义索引」失败：${r.error ?? '未知原因'}`, kind: 'error' as const }
        }
        return null
      },
    )
  }

  const doClear = async () => {
    const ok = await confirmDialog({
      title: '清空语义索引',
      message: '清空后语义召回会停止工作，直到你重新建立索引。\n\n索引是可重建的派生数据（你的正文与设定不受影响），但重建需要重新消耗一次嵌入调用。',
      danger: true,
    })
    if (!ok) return
    try {
      await clearProjectVectors(db.getCurrentProjectId())
      showToast('已清空语义索引')
      setVer(v => v + 1)
    } catch (e) {
      showToast(`清空失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const stats = status?.stats ?? null
  const running = runner.running
  const prog = runner.task?.progress ?? null
  const canBuild = !running && !!settings.providerId && providers.length > 0

  return (
    <div className="mt-5 pt-4 border-t border-ink-700">
      <div className="flex items-center gap-1.5 mb-1">
        <h3 className="text-12 text-ink-200">语义检索 · 嵌入模型（可选）</h3>
        <HelpPopover title="语义检索怎么用" width="24rem" size={13}>
          <p>配好嵌入模型并建立索引后，AI 在「看某一章」时，会按「意思相近」从全书里再捞几条历史片段与设定，补进上下文 —— 长篇里「写到第 300 章却只记得开头」的问题会明显缓解。</p>
          <p className="mt-1.5">它是<b>补一层</b>，不是替换：原有的结构化选材与关键词召回照常工作；不配它，一切与从前完全一样。</p>
          <p className="mt-1.5">嵌入模型<b>从上面已配好的模型里挑</b>（地址与密钥复用那一份）；你也可以单独填一个专用于向量化的模型名，例如 Ollama 的 nomic-embed-text、或 text-embedding-3-small。</p>
          <p className="mt-1.5">🔴 建索引会把你的<b>章节正文与设定条目</b>发给这个嵌入模型：本地模型不出本机；选了云端模型就会上传到该服务商。</p>
          <p className="mt-1.5">索引存在本机独立的向量库里，<b>不参与云盘同步、也不打进备份</b>（它随时可重建）。换电脑或换了嵌入模型后，重建一次即可。</p>
          <AIDataSourceNote feature="semantic-index" />
        </HelpPopover>
      </div>
      <p className="text-11 text-ink-500 mb-2.5 leading-relaxed">
        留空即不启用语义检索。建立索引后，写作类 AI 功能的上下文里会多一段〖语义召回〗。
      </p>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-12 text-ink-300">嵌入模型</span>
          <select
            className="min-w-0 flex-1 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40"
            value={providers.some(p => p.id === settings.providerId) ? settings.providerId : ''}
            onChange={e => void persist({ providerId: e.target.value })}
            disabled={running || providers.length === 0}
            title={providers.length === 0 ? '请先在上面添加一个模型配置' : '选择一个模型提供方（地址与密钥复用它的配置）'}
          >
            <option value="">（不启用语义检索）</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.name} · {p.model || '未设模型'}</option>
            ))}
          </select>
        </div>

        {settings.providerId && (
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-12 text-ink-300">模型名</span>
            <input
              className="min-w-0 flex-1 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
              value={model}
              onChange={e => setModel(e.target.value)}
              onBlur={() => {
                if (model !== settings.model) void persist({ model: model.trim() })
              }}
              disabled={running}
              placeholder="如 nomic-embed-text / text-embedding-3-small"
              title="留空则用该提供方自己的对话模型名（多数情况下你不想要这个 —— 对话模型通常不支持 embedding 接口）"
            />
          </div>
        )}

        {/* 自动索引：默认关 —— 每存一次稿就多一次嵌入调用，得作者自己点头 */}
        <div className="flex items-start gap-2">
          <span className="w-14 shrink-0" />
          <label className="flex min-w-0 items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-amber mt-0.5 shrink-0"
              checked={settings.autoIndexOnSave}
              onChange={e => void persist({ autoIndexOnSave: e.target.checked })}
              disabled={running || !settings.providerId}
            />
            <span className="text-11 text-ink-400 leading-relaxed">
              章节保存后自动更新本章索引
              <span className="text-ink-600">
                （默认关。开启后每次保存正文都会多一次嵌入调用；只在改动本章内容时才真正重嵌，
                改状态、调排序不会白跑。它也不影响存稿 —— 索引出差错只记一行日志。）
              </span>
            </span>
          </label>
        </div>

        {/* 状态行：索引到哪了 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-11">
          <Database size={11} className="shrink-0 text-ink-500" />
          {stats && stats.chunks > 0 ? (
            <span className="text-ink-300">
              已索引 {stats.chapters} 章 / {stats.docs} 条来源 / {stats.chunks} 块
              <span className="text-ink-500"> · 模型 {stats.model || '未知'}</span>
            </span>
          ) : (
            <span className="text-ink-500">尚未建立索引</span>
          )}
          {status && !status.fresh && stats && stats.chunks > 0 && (
            <span className="flex items-center gap-1 text-amber">
              <AlertCircle size={11} /> {status.reason}
            </span>
          )}
          {!settings.providerId && <span className="text-ink-500">· {hint || '未选择嵌入模型'}</span>}
        </div>

        {running && prog && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-11 text-ink-400">
              <Loader2 size={11} className="animate-spin" />
              <span>{prog.phase === '收集' ? '正在收集资料…' : prog.phase === '嵌入' ? '正在向量化' : '正在写入索引'}</span>
              {prog.total > 0 && <span className="text-ink-500">{prog.done} / {prog.total}</span>}
            </div>
            {prog.total > 0 && (
              <div className="h-1 rounded-full bg-ink-800 overflow-hidden">
                <div
                  className="h-full bg-amber/70 transition-all"
                  style={{ width: `${Math.min(100, Math.round((prog.done / prog.total) * 100))}%` }}
                />
              </div>
            )}
          </div>
        )}

        {runner.error && (
          <div className="flex items-start gap-1.5 text-11 text-danger">
            <AlertCircle size={11} className="mt-0.5 shrink-0" /> {runner.error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canBuild}
            onClick={() => void doRebuild(false)}
            title={!settings.providerId ? '先选择嵌入模型' : '只重新嵌入内容变过的章节与条目（已建索引时很快）'}
          >
            <RefreshCw size={12} /> {stats && stats.chunks > 0 ? '更新索引' : '建立索引'}
          </Button>
          {stats && stats.chunks > 0 && (
            <Button variant="secondary" size="sm" disabled={!canBuild} onClick={() => void doRebuild(true)}
              title="忽略增量判断，整库重新嵌入（换了嵌入模型后必须用它）">
              彻底重建
            </Button>
          )}
          {running && (
            <Button variant="secondary" size="sm" onClick={() => runner.stop()}>停止</Button>
          )}
          {!running && stats && stats.chunks > 0 && (
            <Button variant="bare" size="sm" className="text-ink-400 hover:text-danger" onClick={() => void doClear()}>
              <Trash2 size={12} /> 清空索引
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
