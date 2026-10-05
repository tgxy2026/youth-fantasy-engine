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
import { getTavernSettings, effectiveContextBudget } from '../lib/tavern/settings'
import { dynamicQuotaOf, fmtWindow } from '../lib/tavern/quotas'
import type { FreeCharacter, FreeSession, TavernSession } from '../lib/tavern/types'
import { useTavernQuota } from './useTavernQuota'

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
  // 🔴 注入额度按**当前模型窗口**算（2026-10-05）—— 与引擎侧同源，不再用写死的 2400。
  const quota = useTavernQuota(undefined, undefined)

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
        const r = await buildPlotSystem(s, st, quota.windowTokens)
        systemChars = r.system.length
        total = effectiveContextBudget('plot', st, s.params)
        label = s.mode === 'immersive' ? '沉浸推演' : '导演推演'
        parts.push({ key: 'setting', label: '项目资料（②层设定）', chars: r.settingChars, note: '世界观 / 人物 / 关系 / 名词表等，按视角与锚点裁剪后' })
        parts.push({ key: 'world', label: '本场背景设定', chars: r.worldChars, note: '作者提炼的那份；命中关键词才注入，未命中即 0' })
        parts.push({ key: 'memory', label: '本场记忆', chars: (s.memory ?? '').length, note: '这一场推演的记忆 —— 一段文字，随会话走（与自由对话那种按角色存的六栏记忆不是一套）' })
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
        const r = await buildFreeSystem(s, list, st, { windowTokens: quota.windowTokens, skipRecall: true })
        systemChars = r.system.length
        total = effectiveContextBudget('free', st, s.params)
        label = '自由对话'
        // 🔴 固定注入的四块分开量（老大反馈 #5）：此前只有「角色卡」与「长期记忆」两行，
        //    协议那 3.5KB 被并进「其他固定部分」，作者根本看不出格式要求本身花掉多少。
        parts.push({ key: 'setting', label: '角色卡（人设说明书）', chars: r.settingChars, note: `${list.length} 位在场角色；这一层不做预算裁剪（砍了会「设定性失忆」）` })
        parts.push({ key: 'story', label: '故事的世界设定', chars: r.storyChars, note: r.storyChars > 0 ? '这一场所属故事的世界设定（新建对话时存了快照，改故事不影响这一场）' : '这一场没挂在任何故事下，或那份故事的世界设定是空的' })
        parts.push({ key: 'script', label: '本场剧本（这一场）', chars: r.scriptChars, note: r.scriptChars > 0 ? '情境 / 你的位置 / 这一场的目标 / 不要发生 —— 六栏里的内容' : '这一场没选剧本' })
        parts.push({ key: 'protocol', label: '角色扮演协议', chars: r.protocolChars, note: '格式与禁令的收尾块，钉在 system 末尾；可在控制面板精简' })
        parts.push({ key: 'memory', label: '长期记忆', chars: r.memoryChars, note: '按角色分别记账，六栏' })
        if (r.missing.length > 0) {
          warnings.push(`这场对话引用了 ${r.missing.length} 张已被删掉的角色卡 —— 设定层少了这部分，建议在左栏换掉或重新选角。`)
        }
        // 故事设定走世界书：命中多少受**动态额度**约束，超了逐条取舍（不再是整段截断）
        if (r.storyChars > 0 && r.storyChars >= dynamicQuotaOf(quota.windowTokens, quota.dynamicPct)) {
          warnings.push(`故事的世界设定已到动态额度 ${fmt(dynamicQuotaOf(quota.windowTokens, quota.dynamicPct))} 字（窗口 ${fmtWindow(quota.windowTokens)} × ${quota.dynamicPct}%）—— 超出的词条被逐条取舍掉，建议给它们加触发词或在「故事」页精简。`)
        }
      }

      if (systemChars >= total) {
        warnings.push('system 已经吃满整份预算（历史额度为 0）—— 只能靠精简设定层或提高总预算解决。')
      } else {
        // 🔴 2026-09-22 六维审计 P2：必须把**作者在控制面板改过的**固定开销预留传进去。
        //    不传时 `summarizeUsage` 会回落到内置常量 400，而引擎实际用的是 `st.common.fixedOverheadChars`
        //    ⇒ 面板一改预留，这份「用量明细」算出来的历史额度就与实际不符（数字对不上，作者会怀疑谁在说谎）。
        const h = summarizeUsage({ total, systemChars, parts, warnings, overhead: st.common.fixedOverheadChars }).historyChars
        if (h < 800) {
          warnings.push(`留给对话历史的额度只剩 ${fmt(h)} 字 —— 再聊几轮，早前的原文就会被裁掉（记忆里已有的不受影响）。`)
        }
      }
      if (parts.some(p => p.key === 'world' && p.chars >= dynamicQuotaOf(quota.windowTokens, quota.dynamicPct))) {
        warnings.push(`背景设定已到动态额度（窗口 ${fmtWindow(quota.windowTokens)} × ${quota.dynamicPct}% = ${fmt(dynamicQuotaOf(quota.windowTokens, quota.dynamicPct))} 字）—— 超出的词条被逐条取舍掉，建议在「背景设定」页精简或给常驻条目加触发词。`)
      }

      setSummary(summarizeUsage({ total, systemChars, parts, warnings, overhead: st.common.fixedOverheadChars }))
      setTone(label)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode, session, chars, quota.windowTokens, quota.dynamicPct])

  useEffect(() => {
    if (!open) { setSummary(null); setError(''); return }
    void measure()
  }, [open, measure])

  const bar = (s: UsageSummary) => {
    // 自由模式最多 6 段（角色卡/故事/剧本/协议/记忆/其他）—— 色板备足，免得相邻两段同色看不出分界
    const shades = ['bg-ink-500', 'bg-ink-600', 'bg-ink-700', 'bg-ink-400', 'bg-ink-800', 'bg-ink-300']
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
      <p className="text-11 text-ink-400 leading-relaxed">
        按「真实组装」量一遍这一轮会送去什么，以及每一层各占多少
        （{tone ? `本页：${tone}` : '当前会话'}）。这里只读不改 —— 想省额度，优先精简下面占得最多的那几层（长条最长的那条就是）。
      </p>

      {error ? (
        <div className="mt-4 rounded-md border border-danger/30 bg-danger/5 p-4">
          <p className="text-12 text-danger">量不出来</p>
          <p className="mt-1 break-all text-11 text-ink-300 leading-relaxed">{error}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void measure()}>再量一次</Button>
            <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          </div>
        </div>
      ) : loading || !summary ? (
        <div className="mt-4"><LoadingState text="正在按真实组装量一遍…" /></div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-12">
              <span className="text-ink-400">总额度 <span className="text-ink-100">{fmt(summary.total)}</span> 字</span>
              <span className="text-ink-400">固定送入 <span className="text-ink-100">{fmt(summary.systemChars)}</span></span>
              <span className="text-ink-400">安全余量 <span className="text-ink-100">{fmt(summary.overhead)}</span></span>
              <span className="text-ink-400">
                留给对话历史 <span className="text-amber font-semibold">{fmt(summary.historyChars)}</span>
                <span className="text-ink-500">（{summary.historyPct}%）</span>
              </span>
            </div>
            {bar(summary)}
            <p className="mt-1.5 text-10 text-ink-500">
              灰色＝固定送入（下面明细的各层），琥珀＝留给对话历史，剩下的空白＝安全余量。
            </p>
          </div>

          <div className="overflow-hidden rounded-lg border border-ink-700">
            <table className="w-full text-11">
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
                      {p.note && <div className="mt-0.5 text-10 text-ink-500 leading-relaxed">{p.note}</div>}
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
            <div key={i} className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-11 text-ink-300 leading-relaxed">
              ⚠️ {w}
            </div>
          ))}

          <div className="border-t border-ink-800 pt-2 text-10 text-ink-500 leading-relaxed">
            某一层没填内容就是 0 字，不会预留 —— 省下来的额度自动归到对话历史
            （所以「背景设定」留空时，历史额度反而更宽裕）。历史超额度时从最早的轮次开始裁，
            开场与记忆里已有的内容不裁。
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => void measure()}>再量一次</Button>
            <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
