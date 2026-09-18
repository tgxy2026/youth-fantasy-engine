/**
 * 「创意写作」页签 —— 全自动 AI 创作工作流（2.2 三大功能之三）。
 *
 * ⚠️ 当前是**占位页**：按老大的要求先把页签位置立起来
 *    （灵感工具组内、灵感启发之下、检查工具之上），功能本体后续开发。
 *
 * 开发依据：`docs/2.2.0-全自动AI小说创作工作流方案.md`
 *   · 流程：种子想法 → ①设定奠基 → ②分卷大纲 → ③逐章草稿 → ④审校闭环 → ⑤伏笔回收 → ⑥导出
 *   · 两个人工闸门（设定奠基 / 大纲）确认后才进入自动连写 —— 人定方向，AI 跑量
 *   · 复用件：`lib/flow` 状态机与 `DraftReviewPanel`（不重造），`autoContinue.runAutoContinue`
 *     作③节点，`aiContext.buildProjectContext` 作设定注入
 *
 * 排期：A（伴写）→ B1（拆书通用层，已完成）→ **C（本页）** → B2（拆书抽取本体）。
 */
import { Hammer } from 'lucide-react'
import HelpPopover from './HelpPopover'

export default function CreativeWritingPanel() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-[15px] font-medium text-ink-100">创意写作</h1>
        <HelpPopover title="创意写作怎么用" pin>
          <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-300">
            <p>给一句话想法，AI 依次完成：<b>设定奠基 → 分卷大纲 → 逐章草稿 → 审校闭环 → 导出</b>。</p>
            <p>两个人工闸门：<b>设定奠基</b>与<b>大纲</b>都必须你确认后，才进入自动连写 —— 人定方向，AI 跑量。</p>
            <p className="text-ink-500">本功能开发中；它会复用「一键拆书」同一套流程状态机与草稿审阅界面。</p>
          </div>
        </HelpPopover>
      </div>

      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-8 text-center">
        <Hammer size={22} className="mx-auto text-ink-500" />
        <div className="mt-2 text-[13px] text-ink-200">本页开发中</div>
        <div className="mt-1 text-[11.5px] leading-relaxed text-ink-500">
          页签位置已就位。功能本体按 2.2 排期（A → B1 → C → B2）在「一键拆书」之后开发。
        </div>
      </section>
    </div>
  )
}
