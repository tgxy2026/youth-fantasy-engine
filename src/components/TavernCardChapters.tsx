/**
 * 角色卡片 · **卡面的「第 1~4 章」**（2026-09-19 D4-4，从 `TavernCard.tsx` 拆出）。
 *
 * 【为什么分区块】四章是给模型的**不同层**用的：第 1 章管「Ta 在这个世界的什么位置」、
 *   第 2 章管「Ta 是谁」、第 3 章管「怎么演」、第 4 章管「照着这个说话」。合成一坨，
 *   作者一定会漏掉最关键的第四章。
 *
 * 【第 4 章为什么单独强调】手册实测：模型会**直接吸收**示例里的应对话术与格式，
 *   所以它在页面上拿的是 amber 边框 + 四条硬规矩（前两条是踩过的坑），而不是一个普通输入框。
 *
 * 🔴 第 2、3 章走 `TavernCardStructField`（细字段模板），写回库里仍是那十二个字符串字段
 *   （`writeCardField`）—— 界面上是细项表格，存储上仍是整段文本，别被两套形态骗了。
 *
 * 🔴 `Field` / `SectionTitle` 是这一块专用的排版件，**跟着一起搬**：
 *   留在主文件里就得反过来 import 主组件（成环，`tests/importCycles` 会报）。
 *
 * ⚠️ props 名与原局部变量**同名** ⇒ 内部 JSX 逐字未改（缩进保留原样，16 空格）。
 *    别为了好看去重排缩进 —— 「逐行区间核对」靠它证明一个字没改。
 */
import { type Dispatch, type SetStateAction } from 'react'
import AutoTextarea from '@/components/AutoTextarea'
import TavernCardStructField from '@/components/TavernCardStructField'
import { PROFILE_SPECS, CONDUCT_SPECS } from '@/lib/tavern/cardFields'
import { readCardField, writeCardField, type FreeCharacter } from '@/lib/tavern/types'

/** 单个字段（标题 + 说明 + 输入区）。说明写的是「填什么」，不是「这一栏是什么」。 */
function Field({ label, hint, value, onChange, rows = 3, ph }: {
  label: string; hint: string; value: string
  onChange: (v: string) => void; rows?: number; ph?: string
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-12 text-ink-200">{label}</span>
        <span className="text-11 text-ink-500">{hint}</span>
      </div>
      <AutoTextarea
        className="mt-1 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
        textClass="text-12"
        minRows={rows}
        maxHeight={420}
        placeholder={ph}
        value={value}
        onChange={onChange}
      />
    </div>
  )
}

function SectionTitle({ children, sub }: { children: string; sub?: string }) {
  return (
    <div className="border-b border-ink-700 pb-1.5 mb-3">
      <h3 className="text-13 font-semibold text-amber/90">{children}</h3>
      {sub && <p className="mt-0.5 text-11 text-ink-500 leading-relaxed">{sub}</p>}
    </div>
  )
}

interface Props {
  /** 当前正在编辑的卡（父级已收窄为非空 —— 没选中卡时这一整块不挂载） */
  draft: FreeCharacter
  /** 第 1 章与第 4 章是整段自由文本，走这个单字段改写（自动置脏） */
  up: <K extends keyof FreeCharacter>(k: K, v: FreeCharacter[K]) => void
  /** 第 2、3 章由细字段模板整块回写 draft（自动置脏） */
  setDraft: Dispatch<SetStateAction<FreeCharacter | null>>
  setDirty: Dispatch<SetStateAction<boolean>>
}

export default function TavernCardChapters({ draft, up, setDraft, setDirty }: Props) {
  return (
    <>
                {/* 第 1 章 */}
                <section>
                  <SectionTitle sub="世界设定写在「故事剧本」页的故事里 —— 这里只写角色在世界里的位置（不重复写世界本身）。">
                    第 1 章 · 角色与设定的关系
                  </SectionTitle>
                  <Field label="角色与设定的关系" hint="Ta的身份、处境、常去的地方，以及这个世界如何影响Ta" rows={3}
                    value={draft.world} onChange={v => up('world', v)}
                    ph="例：这家便利店的夜班店员，欠着债所以不能辞；认识附近多半的老顾客。" />
                </section>

                {/* 第 2 章 */}
                <section>
                  <SectionTitle sub="Ta是谁 —— 这一章决定角色立不立得住。">
                    第 2 章 · 人物档案
                  </SectionTitle>
                  <div className="space-y-3">
                    {PROFILE_SPECS.map(spec => (
                      <TavernCardStructField
                        key={spec.path}
                        spec={spec}
                        label={spec.label}
                        value={readCardField(draft, spec.path)}
                        onChange={v => {
                          setDraft(prev => (prev ? writeCardField(prev, spec.path, v) : prev))
                          setDirty(true)
                        }}
                      />
                    ))}
                  </div>
                </section>

                {/* 第 3 章 */}
                <section>
                  <SectionTitle sub="怎么演Ta —— 这一章防 OOC（演崩）。">
                    第 3 章 · 行为规范
                  </SectionTitle>
                  <div className="space-y-3">
                    {CONDUCT_SPECS.map(spec => (
                      <TavernCardStructField
                        key={spec.path}
                        spec={spec}
                        label={spec.label}
                        value={readCardField(draft, spec.path)}
                        onChange={v => {
                          setDraft(prev => (prev ? writeCardField(prev, spec.path, v) : prev))
                          setDirty(true)
                        }}
                      />
                    ))}
                  </div>
                </section>

                {/* 第 4 章：醒目 */}
                <section className="rounded-lg border border-amber/35 bg-amber/5 p-3">
                  <SectionTitle sub="模型会直接照着你给的示例说话 —— 这一章比上面三章加起来还影响效果。">
                    第 4 章 · 示例对话（杠杆最高）
                  </SectionTitle>
                  <div className="mb-2.5 rounded-md bg-ink-900/60 border border-ink-700 px-3 py-2">
                    <p className="text-11 text-ink-300 font-medium">四条硬规矩（前两条是踩过的坑）</p>
                    <ul className="mt-1 space-y-1 text-11 text-ink-400 leading-relaxed">
                      <li>
                        <span className="text-amber/90">① 格式必须和你要的输出完全一致。</span>
                        示例里若写「名字：台词」，正式输出也会带上名字前缀 —— <span className="text-ink-200">把名字单独起一行同样算</span>，对白会被写成旁白叙述（如「小满说道」），而不是人物自己开口。
                        <span className="text-ink-200">正确做法：对方的台词用 〖对方〗 标出来（这是给模型看的输入侧标注，不在输出字母表里），你这侧的对白不加任何前缀。</span>
                      </li>
                      <li>
                        <span className="text-amber/90">② 只有两种标记。</span>
                        对白＝纯文本（正常标点）；动作、神态、心理、环境＝（ ）独立成行。
                        除对白之外的一切都用（ ），一件事一个括号。示例里怎么标，输出就得怎么标。
                      </li>
                      <li><span className="text-amber/90">③ 三段覆盖不同侧面</span>（常态 / 被戳到时 / 松动时），别都是同一种情绪。</li>
                      <li><span className="text-amber/90">④ 别写长。</span>三段短来回就够 —— 写成整段剧情既费上下文，又容易被照搬。</li>
                    </ul>
                  </div>
                  <AutoTextarea
                    className="bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                    textClass="text-12"
                    minRows={8}
                    maxHeight={520}
                    placeholder={[
                      '〖对方〗这么晚还不下班？',
                      '（把找零推过去，没抬头）',
                      '灯还亮着。',
                      '',
                      '（门外下着雨，玻璃上蒙了一层水汽）',
                      '〖对方〗你一个人看店不怕吗？',
                      '（停了一下，把手里的抹布搭在台面上）',
                      '惯了。',
                      '',
                      '〖对方〗……谢谢。',
                      '（背过身去理货架，声音很轻）',
                      '伞在门后。',
                    ].join('\n')}
                    value={draft.examples}
                    onChange={v => up('examples', v)}
                  />
                </section>
    </>
  )
}
