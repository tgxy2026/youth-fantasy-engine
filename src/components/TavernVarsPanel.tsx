/**
 * 酒馆模式 · 本场数值面板（好感 / 信任 / 精神 / 心情 / 地点）
 *
 * 【为什么单独抽成一个文件】
 * 这块原先是「对话上方那条角色状态栏」里的一小段；2026-09-16 老大拍板去重：
 * 同一组数值**只留一处**，也就是自由对话的**右栏「本场状态」**（栏内即看即改），
 * 中间那条状态栏不再摆放它。
 *
 * 【数值怎么变】2026-09-16 起**每轮 AI 回复后自动刷新**（反馈 #4，见 `engine.runFreeTurn`）——
 * 所以这里显示的是「此刻」的状态，会随对话起伏；作者也能随时手改覆盖。
 *
 * 【为什么数值必须有编辑入口】
 * 它是**会话级**的独立数据（不在记忆里），由 AI 按剧情给增量。模型算错的时候，
 * 作者只能手改 —— 没有入口就只能干看着。所以这里不是「展示区」，是**唯一的调节点**。
 *
 * 【档位名是什么】三项数值都是 −100 ~ +100，跨度很大，光看「-37」不知道意味着什么。
 * 所以每个数值后面会显示它落在哪一档（极度厌恶 / 中立 / 亲近…，见 `types.VAR_BANDS`），
 * 悬停能看到这一档对应的行为说明。这跟提示词里给模型的是同一份定义。
 *
 * 【为什么不做「关系温度」的数值】
 * 自造一个 0–100 的分数，作者第一句一定问「这 73 分怎么算的」。那一步的温度就是
 * **记忆里「关系状态」那一栏本身**（模型每轮重写的一句话），它比分数准，且能直接与记忆对照。
 * 「好感 / 信任」是另一回事：那是作者点名要的变量，且有明确语义（模型按剧情给增量）。
 *
 * 🔴 只渲染，不读库不写库（数据由 TavernFree 传进来、改完由它写回）。
 */
import { useEffect, useState } from 'react'
import { Button } from './Button'
import { varDefOf, bandOf, type TavernVars, type VarKey } from '../lib/tavern/types'
import { lastChangeText } from '../lib/tavern/vars'

/** 一个数值行：标签 + 进度条（仅数值变量）+ 可编辑的值 + 最近一次差量 + 可编辑备注 */
function VarRow({ k, vars, onSet, locked, note, onNote }: {
  k: VarKey
  vars: TavernVars | undefined
  onSet: (key: VarKey, raw: string) => void
  /** 归档只读：输入框不可改（改也落不进上下文了，只会让界面与归档正文对不上） */
  locked?: boolean
  /** 这一项的备注（角色卡持久保存；模型读取 / 改写） */
  note?: string
  /** 作者改备注的回调（空串＝清掉） */
  onNote?: (text: string) => void
}) {
  const def = varDefOf(k)!
  const raw = vars?.values?.[k]
  const shown = raw === undefined ? String(def.init ?? '') : String(raw)
  const [draft, setDraft] = useState(shown)
  // 外部值变了（AI 更新 / 重置 / 换会话）就刷新草稿 —— 否则输入框会定格在旧值上
  useEffect(() => { setDraft(shown) }, [shown])

  const [noteDraft, setNoteDraft] = useState(note ?? '')
  useEffect(() => { setNoteDraft(note ?? '') }, [note])

  const num = def.kind === 'num' ? Number(shown) : NaN
  const isNum = def.kind === 'num' && Number.isFinite(num)
  // 以 0 为中点（反馈 #11）：正→向右（好，绿），负→向左（坏，红）；各占容器半宽最多 50%
  const mag = isNum ? Math.min(100, Math.abs(num)) / 100 * 50 : 0
  const good = num >= 0
  const band = def.kind === 'num' ? bandOf(k, num) : null
  const delta = lastChangeText(vars, k)

  const commit = () => {
    if (draft === shown) return
    onSet(k, draft)
  }
  const commitNote = () => {
    if (noteDraft === (note ?? '')) return
    onNote?.(noteDraft)
  }

  const isNumKind = def.kind === 'num'

  return (
    <div className="space-y-1">
      {/* 第一行（数值型）：标签 → 状态档位 → 变化量 →……→ 数值框贴最右。
          数值框定宽 + 弹簧顶右，三行的框才会**右边缘对齐**、宽度一致；
          原先四个元素全 shrink-0、加上 w-full/w-16 打架，整行会顶出容器一截（老大反馈）。
          文本类型（心情/地点）没有档位，仍是「标签＋整行输入框」（反馈 #12）。 */}
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-[11px] text-ink-400" title={isNumKind ? `${def.min}~${def.max}` : `≤${def.maxLen} 字`}>
          {def.label}
        </span>
        {isNumKind && band && (
          <span className="min-w-0 truncate text-[10px] text-ink-500" title={band.effect}>{band.name}</span>
        )}
        {isNumKind && delta && (
          <span className={`shrink-0 text-[10px] ${delta.startsWith('-') ? 'text-ink-400' : 'text-amber/80'}`}>
            {delta}
          </span>
        )}
        {isNumKind && <span className="flex-1" />}
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
          disabled={locked}
          inputMode={isNumKind ? 'numeric' : undefined}
          placeholder={def.kind === 'text' ? '（未填）' : String(def.init ?? '')}
          className={`rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11.5px] text-ink-100 outline-none focus:border-amber/50 disabled:cursor-not-allowed disabled:opacity-60 ${isNumKind ? 'w-12 shrink-0 text-center' : 'w-full min-w-0'}`}
          title={locked ? '这一场已结束（只读归档），数值不能再改' : '改完按回车或点一下别处生效'}
        />
      </div>
      {/* 第二行（仅数值型）：进度条以 0 为中点、双向填充、正负异色（反馈 #10/#11） */}
      {isNum && (
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-ink-700/60" title={`${shown} / ${def.max}（0 为中点）`}>
          {num !== 0 && (
            <span
              className={`absolute inset-y-0 ${good ? 'left-1/2 bg-emerald-500/80' : 'right-1/2 bg-rose-500/80'}`}
              style={{ width: `${mag}%` }}
            />
          )}
          <span className="absolute inset-y-0 left-1/2 w-px bg-ink-300/70" />
        </div>
      )}
      {/* 备注：模型读取 / 改写，作者也可手改（反馈 #4） */}
      <input
        value={noteDraft}
        onChange={e => setNoteDraft(e.target.value)}
        onBlur={commitNote}
        onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        disabled={locked}
        placeholder="备注（模型会读取 / 改写，如：从陌生到熟悉的朋友）"
        className="w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[10.5px] text-ink-300 outline-none focus:border-amber/40 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </div>
  )
}

export default function TavernVarsPanel({ vars, varKeys, onSetVar, onResetVars, readOnly, noteOf, onSetNote }: {
  /** 本场数值（C2 第二步）。没有 / 全关闭时整块不渲染 */
  vars?: TavernVars
  varKeys: VarKey[]
  onSetVar: (key: VarKey, raw: string) => void
  onResetVars: () => void
  /** 归档只读（自由对话「结束本轮对话」之后）：输入框与「重置」一并锁掉 */
  readOnly?: boolean
  /** 每项数值的备注（角色卡持久保存） */
  noteOf?: (key: VarKey) => string
  /** 作者改备注的回调 */
  onSetNote?: (key: VarKey, text: string) => void
}) {
  const [showLog, setShowLog] = useState(false)
  /** 变动日志倒序（新的在上），最多 12 条 —— 再多也没人翻 */
  const log = [...(vars?.log ?? [])].reverse().slice(0, 12)

  if (varKeys.length === 0) {
    return (
      <p className="text-[11.5px] text-ink-500 leading-relaxed">
        没有开启任何状态项。去「控制面板 → 八、本场数值」里勾选，这里就会显示。
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-ink-600">
          {readOnly ? '这一场已结束 · 只读' : '每轮回复后自动更新 · 也可手改'}
        </span>
        <span className="flex-1" />
        {log.length > 0 && (
          <Button variant="secondary" size="xs" onClick={() => setShowLog(v => !v)}
            title="看这一场数值的变化过程" className="shrink-0"
          >
            {showLog ? '收起变动' : `变动 ${log.length}`}
          </Button>
        )}
        {!readOnly && (
          <Button variant="secondary" size="xs" onClick={onResetVars}
            title="把启用中的数值全部恢复成初始值（数值归 0，文本清空）" className="shrink-0"
          >
            重置
          </Button>
        )}
      </div>
      {varKeys.map(k => <VarRow key={k} k={k} vars={vars} onSet={onSetVar} locked={readOnly} note={noteOf?.(k)} onNote={t => onSetNote?.(k, t)} />)}
      {showLog && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto border-t border-ink-800 pt-1.5">
          {log.map((e, i) => (
            <li key={`${e.at}-${i}`} className="text-[10.5px] leading-relaxed text-ink-500">
              <span className="text-ink-600">{new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
              {e.source === 'manual' && <span className="ml-1 text-amber/70">手改</span>}
              {e.source !== 'manual' && e.turnSeq ? <span className="ml-1">第 {e.turnSeq} 轮</span> : null}
              <span className="ml-1">
                {e.changes.map(c => `${c.label} ${String(c.from || '空')} → ${String(c.to || '空')}`).join('；')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
