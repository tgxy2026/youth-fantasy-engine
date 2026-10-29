/**
 * 创意写作（AI 自动工作流；C1 · 2.4.2 拆分后收口）
 *
 * 拆分为：creativeWritingParts（常量/类型/小件）+ useCreativeWritingModel（状态与 AI 链路）
 *   + 四个子区块（CreativeSetupSection / CreativeFlowSections / CreativeRewriteSection / CreativeDialogs，只收 m）。
 *
 * 🔴 长任务状态仍在 lib/creativeSession 的模块级 store（切页签内容不丢，见原文件头注释）。
 * 红线：无模型时 AI 入口全部 disabled。
 */
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import HelpPopover from '@/components/common/HelpPopover'
import InterviewChat from '@/components/creative/InterviewChat'
import NewProjectAdvice from '@/components/app/NewProjectAdvice'
import { showToast } from '@/components/dialogs/dialogs'
import { aiChatJson } from '@/lib/ai'
import { CREATIVE_SEED_SPEC, seedFromFilled } from '@/lib/creative/creativeSeed'
import { updateInputs } from '@/lib/creative/creativeSession'
import { useCreativeWritingModel } from '@/components/creative/useCreativeWritingModel'
import CreativeSetupSection from '@/components/creative/CreativeSetupSection'
import CreativeFlowSections from '@/components/creative/CreativeFlowSections'
import CreativeRewriteSection from '@/components/creative/CreativeRewriteSection'
import CreativeDialogs from '@/components/creative/CreativeDialogs'
export default function CreativeWritingPanel() {
  const m = useCreativeWritingModel()
  const { inp, interview, setInterview } = m
  return (
    <div data-guide="page-header" className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-15 font-medium text-ink-100">创意写作</h1>
        <HelpPopover title="创意写作怎么用" pin>
          <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
            <p>这条流水线分<b>两个阶段</b>，各自都可以<b>反复执行</b>；先选<b>篇幅</b>，再选这一次要产出什么。</p>
            <p>· <b>短篇</b> —— 一次跑完：<b>大纲 + 正文</b>（设定奠基 → 分卷大纲 → 逐章连写），或者只做大纲规划。</p>
            <p>· <b>中长篇</b> —— 两阶段分开做（几十万字不可能一次生成完）：<br/>            &nbsp;&nbsp;① <b>只做大纲规划</b>：每批排「本批几卷 × 每卷几章」。库里没有大纲时先做设定奠基、从第 1 卷第 1 章起排；已有则接着往下排（起点＝已有细纲最大章号 + 1）。<br/>            &nbsp;&nbsp;② <b>只生成正文</b>：按已排好的大纲逐章写，从「正文最后一章 + 1」接着写，本次写几章由你定。</p>
            <p>· <b>起点不用你选</b>：库里有没有大纲是客观事实，AI 自己判定 —— 状态行里会写明「本次从第几章起」。</p>
            <p>· <b>两个人工闸门</b>（库里还没有大纲时才有）：设定草稿与大纲都必须你确认后才落库、才继续 —— 人定方向，AI 跑量。</p>
            <p>落库只发生在闸门通过之后（写正文时是在每章初稿<b>被采纳</b>之后）；在任何闸门处「放弃」，都不会留下半成品。</p>
            <p className="text-ink-500">每章流程：读上下文（含上一章结尾）→ 续写初稿 → 字数校准 →（开启时）去 AI 味儿 →（开启时）你确认采纳 → 编辑自检 → 抽取设定并补登 / 更新 → 下一章。项目里有《章节细纲》时，会按章号取当章细纲钉进提示词末段，让正文跟着大纲走。</p>
            <p className="text-ink-500">每卷的章号范围（如「第21-40章」）由系统按「每卷多少章」算好写进《分卷大纲》卡 —— 正文因此能自动落进正确的卷，不会全堆在最后一卷。</p>
            <p><b>没排满的卷会优先补齐</b>：如果某一卷当初只排了一部分（比如规划每卷 10 章、只排到第 21 章），下一次「只做大纲规划」会<b>先把这一卷补满</b>（补第 22-30 章），而不是另开新卷 —— 免得你规划的卷变成残卷。该卷卷大纲若还只有骨架（多处「（待写）」），会一并补上；已经写全的就一个字不动。补满后再排下一批，就是新卷了。</p>
            <p><b>最后一章没写完也会先补齐</b>（「先补完最后一章」开关，默认开）：上一批若因模型收尾过早只写了半章（如 2200 字 / 目标 4000），开写新章前先把它补到目标字数 —— 只补<b>最后一章</b>，历史章一个字不动（改历史章会污染设定与后文）。</p>
            <p className="text-ink-500">想法还说不清时点<b>「对话引导」</b>：AI 按「题材 → 主角 → 冲突 → 世界」一路问，聊完自动把要点填回输入框。</p>
            <p className="text-ink-500">跑长任务时可以随时切去「正文编辑」看稿 —— 任务不会中断，切回来进度与断点都还在。</p>
            <AIDataSourceNote feature="creative-writing" compact />
          </div>
        </HelpPopover>
      </div>

      <NewProjectAdvice kind="creative-writing" />
      <CreativeSetupSection m={m} />
      <CreativeFlowSections m={m} />
      <CreativeRewriteSection m={m} />
      <CreativeDialogs m={m} />
      {/* 对话引导：聊完把要点拼回「一句话想法」 */}
      {interview && (
        <InterviewChat
          subject={CREATIVE_SEED_SPEC.subject}
          spec={CREATIVE_SEED_SPEC}
          existing={inp.seed.trim() || undefined}
          callChat={(msgs, opts) => aiChatJson(msgs, { signal: opts.signal })}
          onClose={() => setInterview(false)}
          onApply={filled => {
            const text = seedFromFilled(filled)
            if (text) updateInputs({ seed: text })
            setInterview(false)
            showToast('已填入想法 —— 生成的是要点提纲，改完再开始创作')
          }}
          applyLabel="填入想法"
          persistScope="creative-seed"
          persistLabel="一句话想法"
        />
      )}
    </div>
  )
}
