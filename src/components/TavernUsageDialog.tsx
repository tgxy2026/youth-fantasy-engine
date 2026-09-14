/**
 * 酒馆模式 · 用量明细（2026-09-14）
 *
 * 起因：老大问「背景设定没填内容时，那 1800 的额度去哪了」。界面上原先只有一行
 * 「上下文占用约 X / Y 字」，而那个 X **只算了消息与记忆 —— system 一个字都没算**。
 * 实测 system（协议 + 设定层 + 背景设定 + 记忆）能到 1.3~1.5 万字，才是吃额度的大头，
 * 于是作者看到的占用永远显得"很宽裕"，也就无从判断某一层到底花了多少。
 *
 * 这里按「真实组装」量一遍（直接调引擎的 buildPlotSystem / buildFreeSystem，
 * 不自己重算判定），把每一层摊开，并算出真正留给对话历史的额度。
 */
import { useCallback, useEffect, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import { buildPlotSystem, buildFreeSystem } from '../lib/tavern/engine'
import { summarizeUsage, type UsagePart, type UsageSummary } from '../lib/tavern/budget'
import { getTavernSettings } from '../lib/tavern/settings'
import { TAVERN_DEFAULTS } from '../lib/tavern/types'
import { WORLD_MAX_CHARS } from '../lib/tavern/world'
import type { FreeCharacter, FreeSession, TavernSession } from '../lib/tavern/types'

const fmt = (n: number) => n.toLocaleString('zh-CN')

export default function TavernUsageDialog({ open, onClose, mode, session, chars }: {
  open: boolean
  onClose: () => void
  mode: 'plot' | 'free'
  session: TavernSession | FreeSession | null
  /** 自由模式必须传在场角色卡（buildFreeSystem 要用它渲染设定层） */
  chars?: FreeCharacter[]
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [tone, setTone] = useState('')

  const measure = useCallback(async () => {
    if (!session) return
    setLoading(true)
    setError('')
    try {
      const st = await getTavernSettings()
      const parts: UsagePart[] = []
      const warnings: string[] = []
      let systemChars = 0
      let total = 0
      let label = ''

      if (mode === 'plot') {
        const s = session as TavernSession
        const r = await buildPlotSystem(s, st)
        systemChars = r.system.length
        total = s.params.contextBudget ?? TAVERN_DEFAULTS.plot.contextBudget
        label = s.mode === 'immersive' ? '沉浸推演' : '导演推演'
        parts.push({ key: 'setting', label: '项目资料（②层设定）', chars: r.settingChars, note: '世界观 / 人物 / 关系 / 名词表等，按视角与锚点裁剪后' })
        parts.push({ key: 'world', label: '本场背景设定', chars: r.worldChars, note: '作者提炼的那份；命中关键词才注入，未命中即 0' })
        parts.push({ key: 'memory', label: '本场记忆', chars: (s.memory ?? '').length, note: '六栏记忆（会话级）' })
        const src = st.plot.contextSource
        if (src === 'digest' && r.worldChars === 0) {
          warnings.push('当前设定层来源是「只留骨架」，而背景设定这次没有注入 —— 模型几乎拿不到作者侧资料。要么去「背景设定」填内容，要么把这一档换成「两者」。')
        }
        if (src === 'raw') {
          warnings.push('当前设定层来源是「只用项目原始资料」—— 背景设定这一层整层不出现（即使填了也不会带上）。')
        }
      } else {
        const s = session as FreeSession
        const list = chars ?? []
        const r = await buildFreeSystem(s, list, st)
        systemChars = r.system.length
        total = s.params.contextBudget ?? TAVERN_DEFAULTS.free.contextBudget
        label = '自由对话'
        parts.push({ key: 'setting', label: '角色卡（设定层）', chars: r.settingChars, note: `${list.length} 位在场角色的人设说明书；这一层不做预算裁剪` })
        parts.push({ key: 'memory', label: '长期记忆', chars: r.memoryChars, note: '按角色分别记账，六栏' })
        if (r.missing.length > 0) {
          warnings.push(`这场对话引用了 ${r.missing.length} 张已被删掉的角色卡 —— 设定层少了这部分，建议在左栏换掉或重新选角。`)
        }
      }

      if (systemChars >= total) {
        warnings.push('system 已经吃满整份预算（历史额度为 0）—— 只能靠精简设定层或提高总预算解决。')
      } else {
        const h = summarizeUsage({ total, systemChars, parts, warnings }).historyChars
        if (h < 800) {
          warnings.push(`留给对话历史的额度只剩 ${fmt(h)} 字 —— 再聊几轮，早前的原文就会被裁掉（记忆里已有的不受影响）。`)
        }
      }
      if (parts.some(p => p.key === 'world' && p.chars >= WORLD_MAX_CHARS)) {
        warnings.push(`背景设定已到 ${fmt(WORLD_MAX_CHARS)} 字上限并被截断 —— 超出的部分不会进上下文，建议在「背景设定」页精简。`)
      }

      setSummary(summarizeUsage({ total, systemChars, parts, warnings }))
      setTone(label)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode, session, chars])

  useEffect(() => {
    if (!open) { setSummary(null); setError(''); return }
    void measure()
  }, [open, measure])

  const bar = (s: UsageSummary) => {
    const shades = ['bg-ink-500', 'bg-ink-600', 'bg-ink-700', 'bg-ink-400']
    const seg = s.parts.map((p, i) => ({ key: p.key, label: p.label, chars: p.chars, cls: shades[i % shades.length] }))
    return (
      <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full border border-ink-700">
        {seg.map(x => (
          <div
            key={x.key}
            className={x.cls}
            style={{ width: `${Math.min(100, (x.chars / Math.max(1, s.total)) * 100)}%` }}
            title={`${x.label} ${fmt(x.chars)} 字`}
          />
        ))}
        <div className="bg-amber/40" style={{ width: `${Math.min(100, (s.historyChars / Math.max(1, s.total)) * 100)}%` }} title={`对话历史额度 ${fmt(s.historyChars)} 字`} />
        <div className="flex-1 bg-ink-850" title="安全余量 + 未用" />
      </div>
    )
  }

  return (
    <Modal open={open} onClose={onClose} title="用量明细" width="lg">
      <p className="text-[11.5px] text-ink-400 leading-relaxed">
        按「真实组装」量一遍这一轮会送去什么，以及每一层各占多少
        （{tone ? `本页：${tone}` : '当前会话'}）。这里只读不改 —— 想省额度优先精简「项目资料」与「角色卡」这两层。
      </p>

      {error ? (
        <div className="mt-4 rounded-md border border-red-400/30 bg-red-400/5 p-4">
          <p className="text-[12.5px] text-red-400">量不出来</p>
          <p className="mt-1 break-all text-[11.5px] text-ink-300 leading-relaxed">{error}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void measure()}>再量一次</Button>
            <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
          </div>
        </div>
      ) : loading || !summary ? (
        <div className="mt-4"><LoadingState text="正在按真实组装量一遍…" /></div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
              <span className="text-ink-400">总额度 <span className="text-ink-100">{fmt(summary.total)}</span> 字</span>
              <span className="text-ink-400">固定送入 <span className="text-ink-100">{fmt(summary.systemChars)}</span></span>
              <span className="text-ink-400">安全余量 <span className="text-ink-100">{fmt(summary.overhead)}</span></span>
              <span className="text-ink-400">
                留给对话历史 <span className="text-amber font-semibold">{fmt(summary.historyChars)}</span>
                <span className="text-ink-500">（{summary.historyPct}%）</span>
              </span>
            </div>
            {bar(summary)}
            <p className="mt-1.5 text-[10.5px] text-ink-500">
              灰色＝固定送入（下面明细的各层），琥珀＝留给对话历史，剩下的空白＝安全余量。
            </p>
          </div>

          <div className="overflow-hidden rounded-lg border border-ink-700">
            <table className="w-full text-[11.5px]">
              <thead className="bg-ink-850/60 text-ink-400">
                <tr>
                  <th className="px-3 py-1.5 text-left font-normal">层</th>
                  <th className="w-24 px-3 py-1.5 text-right font-normal">字数</th>
                  <th className="w-16 px-3 py-1.5 text-right font-normal">占比</th>
                </tr>
              </thead>
              <tbody>
                {summary.parts.map(p => (
                  <tr key={p.key} className="border-t border-ink-800">
                    <td className="px-3 py-2 align-top">
                      <div className="text-ink-100">{p.label}</div>
                      {p.note && <div className="mt-0.5 text-[10.5px] text-ink-500 leading-relaxed">{p.note}</div>}
                    </td>
                    <td className="px-3 py-2 text-right align-top text-ink-200">{fmt(p.chars)}</td>
                    <td className="px-3 py-2 text-right align-top text-ink-500">
                      {Math.round((p.chars / Math.max(1, summary.total)) * 100)}%
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-ink-800 bg-amber/5">
                  <td className="px-3 py-2 text-amber">留给对话历史</td>
                  <td className="px-3 py-2 text-right text-amber">{fmt(summary.historyChars)}</td>
                  <td className="px-3 py-2 text-right text-ink-500">{summary.historyPct}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {summary.warnings.map((w, i) => (
            <div key={i} className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-[11.5px] text-ink-300 leading-relaxed">
              ⚠️ {w}
            </div>
          ))}

          <div className="border-t border-ink-800 pt-2 text-[10.5px] text-ink-500 leading-relaxed">
            某一层没填内容就是 0 字，不会预留 —— 省下来的额度自动归到对话历史
            （所以「背景设定」留空时，历史额度反而更宽裕）。历史超额度时从最早的轮次开始裁，
            开场与记忆里已有的内容不裁。
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => void measure()}>再量一次</Button>
            <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
