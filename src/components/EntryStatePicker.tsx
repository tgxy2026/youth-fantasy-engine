/**
 * 世界书「四色灯」选择器（2026-10-05）。
 *
 * 【起因】ST 酒馆的 World Info 每条有四种状态，用颜色区分「这条什么时候参与」：
 *   蓝圈 常驻 / 绿圈 关键词 / 蓝链 递归才出 / 停用。
 * 主人拍板把这套能力搬过来、换成契合本项目的名字：
 *   **常驻 / 触发 / 引荐 / 休眠**。
 *
 * 【与老数据的兼容（等价性红线）】
 *   `state` 是**可选**字段：没设过 ⇒ 走 `entryStateOf` 的老语义推断
 *   （触发词为空 → 常驻；`recursive:false` → 引荐；其余 → 触发）。
 *   所以这里的「未指定」不是一种状态，而是「让老推断说了算」——
 *   作者一旦点过任何一个灯，就写死那个值。
 *
 * 【为什么单独成文件】两个模式（背景设定 / 故事剧本）都要用同一套 UI，
 *   放任一页面里都会让另一个反向 import 页面组件（项目禁 order 里的成环）。
 */
import { ENTRY_STATE_LABEL, ENTRY_STATE_HINT, type EntryState } from '../lib/tavern/worldBook'

/** 四色灯的视觉：色点 + 选中态描边。色值走主题 token（闸 ⑨），不写裸色值。 */
const DOT: Record<EntryState, string> = {
  on: 'bg-info',
  hit: 'bg-success',
  ref: 'bg-amber',
  off: 'bg-ink-600',
}

/** 按四色灯顺序固定排列（不随数据顺序变，作者点会形成肌肉记忆） */
const ORDER: EntryState[] = ['on', 'hit', 'ref', 'off']

/** 单选态下的选中样式：不同灯给不同描边，避免「四个长得一样」看不出选了谁 */
const SELECTED: Record<EntryState, string> = {
  on: 'border-info/70 bg-info/10 text-ink-100',
  hit: 'border-success/70 bg-success/10 text-ink-100',
  ref: 'border-amber/70 bg-amber/10 text-ink-100',
  off: 'border-ink-600 bg-ink-800 text-ink-300',
}

/**
 * 四色灯按钮组。
 *
 * @param value     当前显式设置的状态（`undefined` = 没设过，由老语义推断）
 * @param inferred  老语义推断出来的状态 —— 仅当 `value` 为空时用来「点亮」对应那个灯，
 *                  让作者一眼看出「现在实际是哪种」，而不是四个灯全灭。
 * @param onChange  传 `undefined` = 清除显式设置（回到推断）。界面暂不暴露这个动作，
 *                  但签名留着 —— 将来加「恢复默认」就不用改所有调用点。
 */
export default function EntryStatePicker({
  value, inferred, onChange, size = 'md',
}: {
  value?: EntryState
  inferred: EntryState
  onChange: (next: EntryState | undefined) => void
  /** sm = 塞进紧凑的条目工具条；md = 常规 */
  size?: 'sm' | 'md'
}) {
  const active = value ?? inferred
  const explicit = value !== undefined
  const pad = size === 'sm' ? 'px-1.5 py-0.5 text-10' : 'px-2 py-1 text-11'
  return (
    <div className="flex items-center gap-1">
      {ORDER.map(s => {
        const on = s === active
        return (
          <button
            key={s}
            type="button"
            title={ENTRY_STATE_HINT[s]}
            aria-pressed={on}
            aria-label={`四色灯：${ENTRY_STATE_LABEL[s]}`}
            onClick={() => onChange(s)}
            className={
              `flex shrink-0 items-center gap-1 rounded-full border transition-colors ${pad} ` +
              (on ? SELECTED[s] : 'border-ink-700 text-ink-500 hover:border-ink-600 hover:text-ink-300')
            }
          >
            <span className={`h-1.5 w-1.5 rounded-full ${on ? DOT[s] : 'bg-ink-700'}`} />
            {ENTRY_STATE_LABEL[s]}
          </button>
        )
      })}
      {/* 「跟随默认」提示：只在没显式设过时出现 —— 让作者知道现在这个亮点是推断来的，不是他点的 */}
      {!explicit && (
        <span className="text-10 text-ink-600" title="没点过灯时按触发词推断（触发词留空 = 常驻）">
          · 按触发词推断
        </span>
      )}
    </div>
  )
}
