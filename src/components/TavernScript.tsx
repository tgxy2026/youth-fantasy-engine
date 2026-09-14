/**
 * 酒馆模式 · 剧本编辑（tavern-script）
 *
 * ⚠️ 本页目前是**占位**（2026-09-14 老大要求先立页签、避免遗忘），尚无任何功能与数据。
 *
 * 立这个页签的用意：角色卡片解决的是「一个人是谁」，但一场戏还需要「谁在哪、先后做什么」——
 * 这块（多幕 / 多场的组织、场面调度）目前没有落点，先占位留出位置。
 *
 * 🔴 开发时的纪律（别让占位变成误解）：
 * · 页面上**明写「尚未开发」**，不摆任何看起来能点、实际没反应的假控件 ——
 *   假按钮比空页面更坏，用户会以为是坏的。
 * · 真正开工时，先把「剧本」的数据模型与归属（随项目 / 跨项目）定清楚再动手；
 *   它大概率会复用角色卡片与背景设定，**不要另起一套角色表达**。
 */
import { TABS } from '../lib/schema'

/** 预想的模块清单 —— 只是规划备忘，不代表已承诺的范围 */
const PLANNED: { title: string; desc: string }[] = [
  { title: '剧本与场次', desc: '一场戏分成若干场（幕），每场记地点、时间、在场人物与这一场要发生什么。' },
  { title: '选角与调度', desc: '从角色卡片里为每场挑人，指定谁先开口、谁在场不出声。' },
  { title: '与推演衔接', desc: '搭好的剧本可直接开一场剧情推演，不必每次重新配锚点与角色。' },
  { title: '与背景设定衔接', desc: '沿用「背景设定」页签里那份被精简过的资料，不重复填一遍。' },
]

export default function TavernScript() {
  const tab = TABS.find(t => t.id === 'tavern-script')

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50">剧本编辑</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          {tab?.description ?? '把一个场景拆成若干场，安排好谁在哪、先后做什么。'}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto pt-4">
        <div className="rounded-lg border border-dashed border-ink-700 bg-ink-850/20 p-6">
          <div className="flex items-center gap-2">
            <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[10.5px] text-amber">
              尚未开发
            </span>
            <span className="text-[12.5px] text-ink-300">这个页签已占好位置，功能留到后续版本做。</span>
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
            先立页签是为了不遗忘。下面只是规划备忘（不是承诺的范围），开工前会先与作者确认数据模型与归属
            （随项目还是跨项目），再动手写。
          </p>

          <ul className="mt-4 space-y-2.5">
            {PLANNED.map(p => (
              <li key={p.title} className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-600" />
                <div>
                  <div className="text-[12.5px] text-ink-200">{p.title}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-500">{p.desc}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
