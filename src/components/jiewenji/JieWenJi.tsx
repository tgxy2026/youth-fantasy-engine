/**
 * 颉文姬 · 编辑器 AI 助手（v1.6 收官功能；C1 · 2.4.2 拆分后收口）
 *
 * 四模式：诊室（AI 深度校对 + AI 综合诊断）/ 编辑（选区改稿 → 建议段）/
 * 审读（章节编辑意见 / OOC / 续写方向 / 爽点毒点 / 黄金三章）/ 简报。
 * 1.9.1 增第五模式「补登」：抽出本章新出现的设定实体，与已有设定做确定性比对，
 * 分「已登记 / 疑似重复 / 待补登」三档，勾选后一键写入对应设定表或角色卡。
 * 红线：无模型时 AI 入口全部 disabled。2.2 起放开 AI 直接生成正文（含伴写/续写）。
 *
 * C1 拆分为：jieWenJiParts（常量/类型/小件）+ useJieWenJiModel（状态与 AI 链路）
 *   + 五个模式面板（JieWenJiClinic / Edit / Review / Brief / Ledger，只收 m）。
 */
import HelpPopover from '@/components/common/HelpPopover'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import { Z } from '@/lib/app/zLayer'
import { Stethoscope, PenLine, BookOpen, X, Wand2, Sparkles, ClipboardList, ClipboardCheck, Move, Lock, PanelLeft, PanelRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { useJieWenJiModel } from '@/components/jiewenji/useJieWenJiModel'
import { useJieWenJiPanelLayout } from '@/components/jiewenji/useJieWenJiPanelLayout'
import JieWenJiClinic from '@/components/jiewenji/JieWenJiClinic'
import JieWenJiEdit from '@/components/jiewenji/JieWenJiEdit'
import JieWenJiReview from '@/components/jiewenji/JieWenJiReview'
import JieWenJiBrief from '@/components/jiewenji/JieWenJiBrief'
import JieWenJiLedger from '@/components/jiewenji/JieWenJiLedger'
import JieWenJiPostProcess from '@/components/jiewenji/JieWenJiPostProcess'
import type { Props, Mode } from '@/components/jiewenji/jieWenJiParts'
// 🔴 建议段标记照旧对外可用（NovelEditor 依赖它）：实现已随常量层搬进 jieWenJiParts
export { ADVICE_START, ADVICE_END } from '@/components/jiewenji/jieWenJiParts'
export default function JieWenJi(props: Props) {
  const m = useJieWenJiModel(props)
  const { aiReady, acpWriting, spriteOn, toggleSprite, mode, setMode, onClose } = m
  // 3.6.1 · B 方案：默认贴边停靠（与改动前逐像素一致）；开关打开后可拖动并吸附到最近边
  const layout = useJieWenJiPanelLayout()
  const floating = layout.mode === 'floating'
  return (
    <div ref={layout.panelRef} data-jiewenji-panel
      className={`${floating ? 'fixed' : layout.dockedClass} bg-ink-850 border border-ink-700 rounded-xl shadow-2xl flex flex-col overflow-hidden`}
      style={{ zIndex: Z.pagePanel, ...(layout.floatingStyle ?? {}) }}>
      {/* 头部 */}
      <div
        {...layout.headerProps}
        className={`flex items-center gap-2 px-3 h-10 border-b border-ink-700 shrink-0 ${floating ? (layout.dragging ? 'cursor-grabbing select-none' : 'cursor-grab') : ''}`}
        style={floating ? { touchAction: 'none' } : undefined}
        title={floating ? '拖动标题栏可移动面板；松手会吸附到最近的边（四条边都算）；双击标题栏复位到右侧停靠' : undefined}>
        <Wand2 size={14} className="text-amber shrink-0" />
        <span className="text-12 font-semibold text-ink-100 flex-1 truncate">颉文姬 · AI 编辑</span>
        <HelpPopover title="颉文姬 · AI 编辑" width="24rem" size={12} className="shrink-0">
          {'· 诊室：AI 校对分两块 —— 「查错别字与语病」（只读本章正文，出结果更快）与「查逻辑与设定矛盾」（会读设定资料）；替换类结果可逐条「替换此条」，纯建议类只展示不改正文；AI 综合诊断（主编视角：优先级 / 隐藏风险 / 批量建议）。\n· 编辑：先在正文选中一段，选润色 / 扩写 / 精简 / 语气 / 视角，可在「额外要求」里写清具体倾向（如把语气从甲改成乙）、在「期望字数」里指定篇幅。改稿以「建议段」标记写入原文下方，你的原文一字不动，取舍后可用「清除全部建议段」一键清理。\n· 续写（在「编辑」页内）：接着本章末尾往下续写，可指定字数与主要情节，并勾选要带给 AI 的资料（章节摘要 / 前文章节 / 设定表 / 写作文风等）；面板会实时显示本次资料的占用与预算，装不下的会如实列出来。结果同样落「建议段」，原文一字不动。\n· 审读：章节编辑意见（六维打分）/ OOC 人设检查 / 续写方向（只给思路不生成正文）/ 爽点毒点 / 黄金三章。\n· 简报：开写前一键生成「本章写作简报」——未回收伏笔 / 钩子爽点方向 / 角色状态提醒 / 下一章衔接，只给方向不代写正文。\n· 补登：扫本章正文，抽出有专名的人物 / 势力 / 地点 / 种族 / 物品 / 术语，与已有设定比对后分「已登记 / 疑似重复 / 待补登」三档；勾选即可一键写入对应设定表或角色卡，只填名称与一句话，其余留空自己补。「是否已登记」由程序按名称与别称精确比对，AI 只负责抽取。\n· 整理：写完本章后一键整理四类变化 —— 「事实·设定」（同补登）/「伏笔」（本章埋设或回收）/「关系」（人物关系的变化）/「人物状态」（状态的变化）。AI 只抽候选，「是否已登记、是否真变了」由程序精确比对；没登记过的一律只提示、不凭空建；采纳前都要你勾选。面板顶部还会列出「未来计划待重审」——已写正文被改动后，章节细纲里这一章之后的规划可能过时，核对完点「已处理」清标记即可（只提示，绝不自动改章节细纲）。\n· 在 API 模式配置模型，或在桌面连接 ACP 后，即可使用上述 AI 功能。\n· 面板位置：默认贴在屏幕右侧。标题栏的锁形按钮打开「可拖动」后，拖标题栏即可移动，松手会吸附到四条边（左/右/上/下，离边 24px 内才贴，靠角落两边一起贴）；离边较远就停在原地，中间也能放。双击标题栏或点复位按钮回到默认位置。左右箭头按钮可直接把面板停靠到另一侧。窗口宽度不足 1180 时只能贴边停靠。\n· 底部开关可控制屏幕右侧的 Q 版精灵是否显示。'}
          <AIDataSourceNote feature="jiewenji-panel" />
        </HelpPopover>
        {layout.canFloat && (
          <Button variant="icon-muted" onClick={layout.toggleMode} className="p-1 shrink-0"
            aria-pressed={floating} aria-label={floating ? '关闭拖动（回到贴边停靠）' : '开启拖动（可自由摆放面板）'}
            title={floating
              ? '可拖动：已开启 —— 拖标题栏移动，松手吸附到最近的边（上下左右四条边，离边远则停在原地）；双击标题栏复位'
              : '可拖动：已关闭 —— 面板贴在屏幕边缘。打开后可拖到你习惯的位置（仍浮在页面内容之上）'}>
            {floating ? <Move size={14} /> : <Lock size={14} />}
          </Button>
        )}
        <Button variant="icon-muted" onClick={layout.switchSide} className="p-1 shrink-0"
          title={`${floating ? '吸附到' : '停靠到'}${layout.prefs.side === 'left' ? '右' : '左'}侧`}
          aria-label={`${floating ? '吸附到' : '停靠到'}${layout.prefs.side === 'left' ? '右' : '左'}侧`}>
          {layout.prefs.side === 'left' ? <PanelRight size={14} /> : <PanelLeft size={14} />}
        </Button>
        {floating && (
          <Button variant="icon-muted" onClick={layout.reset} className="p-1 shrink-0"
            title="复位到默认位置（右侧停靠）" aria-label="复位到默认位置">
            <RotateCcw size={13} />
          </Button>
        )}
        <Button variant="icon-muted" onClick={onClose} className="p-1 shrink-0" title="收起"><X size={16} /></Button>
      </div>

      {/* 浮动模式的拉宽把手（右下角）：只在浮动时出现，避免停靠模式下多一个可点的角 */}
      {floating && (
        <div {...layout.resizeHandleProps} data-no-drag role="separator" aria-orientation="vertical" aria-label="调整面板宽度"
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          style={{ touchAction: 'none' }} />
      )}

      {/* 模式切换 */}
      <div className="flex gap-1 px-2 pt-2 shrink-0">
        {([
          ['clinic', '诊室', Stethoscope],
          ['edit', '编辑', PenLine],
          ['review', '审读', BookOpen],
          ['brief', '简报', Sparkles],
          ['ledger', '补登', ClipboardList],
          ['post', '整理', ClipboardCheck],
        ] as [Mode, string, typeof PenLine][]).map(([m, label, Icon]) => (
          <Button variant="bare"
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-11 border transition-colors ${
              mode === m ? 'bg-amber/15 text-amber border-amber/30' : 'text-ink-400 border-transparent hover:bg-ink-800 hover:text-ink-200'
            }`}
          >
            <Icon size={12} /> {label}
          </Button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {mode === 'clinic' && <JieWenJiClinic m={m} />}
        {mode === 'edit' && <JieWenJiEdit m={m} />}
        {mode === 'review' && <JieWenJiReview m={m} />}
        {mode === 'brief' && <JieWenJiBrief m={m} />}
        {mode === 'ledger' && <JieWenJiLedger m={m} />}
        {mode === 'post' && <JieWenJiPostProcess m={m} />}
      </div>

      {/* 精灵开关 */}
      <div className="px-3 py-1.5 border-t border-ink-700 flex items-center justify-between gap-2 shrink-0">
        <span className="text-10 text-ink-500">屏幕右侧 Q 版精灵</span>
        <Button variant="bare"
          onClick={toggleSprite}
          className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${spriteOn ? 'bg-amber' : 'bg-ink-600'}`}
          title={spriteOn ? '点击隐藏右侧精灵' : '点击显示右侧精灵'}
        >
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-ink-50 shadow transition-all ${spriteOn ? 'left-[18px]' : 'left-0.5'}`} />
        </Button>
      </div>
      {/* 底部状态 */}
      <div className="px-3 py-2 border-t border-ink-700 text-10 text-ink-500 flex items-center justify-between gap-2 shrink-0">
        <span>颉文姬的诊室、编辑、审读、简报、补登和整理均支持 API 和桌面 ACP。</span>
        {acpWriting
          ? acpWriting.ready
            ? <span className="text-success/80">ACP · {acpWriting.name}</span>
            : <span className="text-amber/70">ACP 未连接</span>
          : !aiReady && <span className="text-amber/70">未配置模型</span>}
      </div>
    </div>
  )
}
