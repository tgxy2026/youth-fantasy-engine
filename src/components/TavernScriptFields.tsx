/**
 * 酒馆模式 · 剧本六栏表单（「剧本编辑」页与「新建对话」弹窗**共用同一份**）
 *
 * 【为什么抽成组件】
 * 两处都要填同样六栏。各写一份的结果必然是：改了一处忘了另一处，两边的提示文案与字数上限
 * 慢慢就对不上了 —— 这个项目在别处已经栽过（背景设定两种模式共用一份数据，同理）。
 *
 * 【六栏的用意（老大 2026-09-14 定，见 docs/剧本与变量-设计方案-讨论稿.md）】
 *   ① 名称        不进上下文，只是给你自己在列表里认得出
 *   ② 情境        此刻在哪、为什么在这儿 —— **刻意只管此刻**，背景归角色卡第 1 章与「故事」层
 *   ③ 开场白      Ta 说的第一句。走**消息通道**（不占常驻额度），也是整场戏的语气锚点
 *   ④ 你的位置    你在这一场里演谁（「我的档案」是「你本人是谁」，两者不同）
 *   ⑤ 这一场的目标 给方向不锁死 —— 它就是「固定的情节窗口」的落点，变量「精神」量它
 *   ⑥ 不要发生    这一场的禁区，比正面要求更能防跑偏
 */
import { SCRIPT_FIELD_MAX, type ScriptDraftFields } from '../lib/tavern/script'
import AutoTextarea from './AutoTextarea'

/** 一个栏位的说明（写成常量，页面的「填法提示」也复用） */
export const SCRIPT_FIELD_META: { key: keyof ScriptDraftFields; label: string; hint: string; placeholder: string; rows: number }[] = [
  {
    key: 'name', label: '① 名称', rows: 1,
    hint: '列表里认得出就行，不进上下文。',
    placeholder: '例：雨夜便利店 / 分手前夜 / 天台上的告白',
  },
  {
    key: 'situation', label: '② 情境', rows: 4,
    hint: '此刻在哪、为什么在这儿、刚发生了什么。「此刻」是重点 —— 身世与历史归角色卡第 1 章与「故事」层（世界观写在故事里），重复写会互相打架（这一层每轮都进上下文）。',
    placeholder: '例：凌晨两点的便利店，外面在下雨。她是夜班店员，你是那个每天这个点来买烟的人 —— 今天她忽然把烟柜锁了。',
  },
  {
    key: 'opening', label: '③ 开场白', rows: 4,
    hint: 'Ta 说的第一句，会变成对话的第一条消息（不占每轮的常驻额度）。模型会照着它的篇幅和语气往下写 —— 想要短促的对白，这里就别写成长旁白。',
    placeholder: '例：（雨点砸在卷帘门上）\n（她把钥匙转了一圈，没抬头）今天不卖了。\n你要的东西，我没有。',
  },
  {
    key: 'playerRole', label: '④ 你的位置', rows: 3,
    hint: '你在这一场里演谁、与 Ta 什么关系、此刻想做什么。「我的档案」管的是"你本人是谁"，这一栏管的是"这一场你演谁" —— 两者可以完全不同。',
    placeholder: '例：你是那个每晚来买烟的人，和她认识半年，只说过不超过二十句话。今天你想问清楚她为什么忽然锁柜。',
  },
  {
    key: 'goal', label: '⑤ 这一场的目标', rows: 3,
    hint: '一个主要目标（给方向，不锁死）。有意图戏才往前走 —— 缺了它模型只会描述气氛。',
    placeholder: '例：让她说出那件一直不肯说的事；或：让她愿意把烟柜重新打开。',
  },
  {
    key: 'taboo', label: '⑥ 不要发生', rows: 3,
    hint: '这一场的禁区，2–4 条具体的。写"不要提分手""不要让她离开便利店"这类具体禁令，比"要符合人设"有用得多。',
    placeholder: '例：不要提分手；不要引入新角色；不要让她主动离开便利店；不要出现超自然设定。',
  },
]

/** 六栏表单。受控：value + onChange，保存交给调用方 */
export default function TavernScriptFields({ value, onChange }: {
  value: ScriptDraftFields
  onChange: (patch: Partial<ScriptDraftFields>) => void
}) {
  return (
    <div className="space-y-3">
      {SCRIPT_FIELD_META.map(f => {
        const max = f.key === 'name' ? 30 : SCRIPT_FIELD_MAX[f.key as keyof typeof SCRIPT_FIELD_MAX]
        const text = value[f.key] ?? ''
        const over = max ? text.length > max : false
        return (
          <div key={f.key} className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-200">{f.label}</span>
              <span className="flex-1" />
              {max && (
                <span className={`text-[10.5px] ${over ? 'text-amber' : 'text-ink-600'}`}>
                  {text.length} / {max}
                </span>
              )}
            </div>
            <p className="mt-0.5 mb-2 text-[10.5px] leading-relaxed text-ink-500">{f.hint}</p>
            {f.rows <= 1 ? (
              <input
                value={text}
                onChange={e => onChange({ [f.key]: e.target.value })}
                placeholder={f.placeholder}
                className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50"
              />
            ) : (
              <AutoTextarea
                value={text}
                onChange={v => onChange({ [f.key]: v })}
                minRows={f.rows}
                maxHeight={280}
                className="bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-sm"
                placeholder={f.placeholder}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
