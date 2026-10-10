/**
 * 角色卡的「细字段」编辑器 —— 一个大栏（如 2.1 外在）拆成若干小格。
 *
 * 【编辑方向】
 * 界面上是若干小格，存储里仍是**一段标记文本**（卡字段的唯一真源），
 * 由 `cardFields.packField / unpackField` 负责往返。改动经 `onChange(文本)` 交回上游，
 * 上游完全不知道「小格」的存在 —— 所以记忆整理、设定更新、提示词渲染一概不受影响。
 *
 * 【同步的坑】
 * 本地编辑 → 打包成文本 → 上游回落成 value → 若无条件重新解包，**用户正在敲的字会被自己 overwrite**。
 * 所以只在「value 与我打包出来的不一样」时才重解 —— 那说明是外部改的（切卡 / AI 起草 / 设定更新）。
 */
import { useEffect, useRef, useState } from 'react'
import AutoTextarea from '@/components/common/AutoTextarea'
import {
  OTHER_KEY, packField, unpackField, filledCount, type StructSpec,
} from '@/lib/tavern/cardFields'

export default function TavernCardStructField({ spec, value, onChange, label }: {
  spec: StructSpec
  value: string
  onChange: (text: string) => void
  /** 大栏名（如「2.1 外在」） */
  label: string
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => unpackField(value, spec))
  const [showRaw, setShowRaw] = useState(false)
  const valsRef = useRef(vals)
  valsRef.current = vals

  useEffect(() => {
    const mine = packField(valsRef.current, spec)
    if (mine !== value) setVals(unpackField(value, spec))
  }, [value, spec])

  const patch = (key: string, v: string) => {
    const next = { ...valsRef.current, [key]: v }
    setVals(next)
    onChange(packField(next, spec))
  }

  const got = filledCount(vals, spec)
  const total = spec.items.length + (spec.other ? 1 : 0)

  return (
    <div className="rounded-md border border-ink-700 bg-ink-850/20 p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-12 text-ink-200">{label}</span>
        <span className="text-10 text-ink-500">
          {got}/{total} 项已填
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setShowRaw(v => !v)}
          className="text-10 text-ink-500 hover:text-ink-300 transition-colors"
          title="没被模板覆盖到的内容写进「其他」；想整段手改也可以在这里展开"
        >
          {showRaw ? '收起原文' : '编辑原文'}
        </button>
      </div>

      {showRaw ? (
        <div className="mt-1.5">
          <AutoTextarea
            className="bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
            textClass="text-12"
            minRows={4}
            maxHeight={360}
            value={value}
            onChange={onChange}
            placeholder={`一行一项，形如「${spec.items[0].key}：…」`}
          />
          <p className="mt-1 text-10 text-ink-600 leading-relaxed">
            这里是存进数据库的原文。改它会同步到上面的小格；认不出来的行会落进「其他」。
          </p>
        </div>
      ) : (
        <div className="mt-1.5 space-y-2">
          {spec.items.map(it => (
            <div key={it.key}>
              <div className="text-11 text-ink-400">{it.label}</div>
              <AutoTextarea
                className="mt-0.5 bg-ink-900 border border-ink-700 rounded-md px-2 py-1 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-12"
                minRows={it.rows ?? 1}
                maxHeight={200}
                value={vals[it.key] ?? ''}
                onChange={v => patch(it.key, v)}
                placeholder={it.ph}
              />
            </div>
          ))}
          {spec.other && (
            <div>
              <div className="text-11 text-ink-400">{OTHER_KEY}（上面没覆盖到的写这儿）</div>
              <AutoTextarea
                className="mt-0.5 bg-ink-900 border border-ink-700 rounded-md px-2 py-1 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-12"
                minRows={2}
                maxHeight={240}
                value={vals[OTHER_KEY] ?? ''}
                onChange={v => patch(OTHER_KEY, v)}
                placeholder="模板没覆盖到的补充都放这，AI 也会照读。"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
