import { useState } from 'react'
import HelpPopover from './HelpPopover'
import AIConfigPanel from './AIConfigPanel'
import AIDisabledNotice from './AIDisabledNotice'
import AIWriterBudgetPanel from './AIWriterBudgetPanel'
import SearchSettingsPanel from './SearchSettingsPanel'
import AIPromptSettings from './AIPromptSettings'
import NetworkProxyPanel from './NetworkProxyPanel'
import AIUsagePanel from './AIUsagePanel'

/**
 * 「模型设置」页签（2026-09-19 新增，老大要求）。
 *
 * 原先「模型配置 / 正文写作 AI 额度 / 联网检索」三块挤在「灵感启发」页顶部 ——
 * 那一页的定位是**灵感与创意**（随机取名、AI 续写、AI 辅助规划），
 * 而这三块是**全局设置**（配一次就不动了），两种东西混在一起，两边都不好找。
 * 所以把设置类整块搬到工作面板组，放在「写作面板」下、「使用指南」上。
 *
 * 本页第四块「AI 提示词」是把项目内置提示词摆到前台（可改、可存、可一键还原），
 * 见 AIPromptSettings.tsx。
 */
export default function ModelSettingsPanel() {
  // 模型配置改动后要让下方额度面板/提示词板块重新取一次数（它们读的是同一份配置）
  const [cfgVer, setCfgVer] = useState(0)

  return (
    <div className="w-full page-enter">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">模型设置</h1>
          <HelpPopover title="模型设置怎么用" width="24rem" size={14}>
            {'这一页集中管「AI 怎么跑」，六块内容从上到下：\n\n【模型配置】全应用用哪个模型 —— 本地 Ollama / 云端 OpenAI 兼容服务，以及每个模型的上下文窗口等参数。换模型后下面几块会跟着推荐值调整。\n\n【网络代理】需要统一网络出口的环境（内网网关 / 自建中转）可在此填写出口地址，默认关闭、跟随系统网络设置。\n\n【正文写作 AI 额度】编辑器、颉文姬、检查工具、灵感工具这些「正文写作」类功能，一次带多少项目设定资料给模型的「总闸门」（各功能按系数取用）。\n\n【联网检索】起草 / 补全时要不要联网找素材（可用博查或自建 SearXNG）。\n\n【AI 提示词】把各 AI 功能的内置提示词全部摆到前台：可按功能板块查看、逐条修改、保存，也可以一键还原成出厂设置。改错了随时还原，不影响手动写作。\n\n【AI 消耗统计】本机账本汇总：调用次数 / 累计耗时 / 被内容政策拒绝的次数，按模型与按日查看。数据只在本机，不联网、不上报。\n\n⚠️ 酒馆模式（剧情推演 / 自由对话）的额度与扮演协议「不在这里」 —— 在「酒馆模式 → 控制面板」单独设置，两边各管各的、互不冲突。'}
          </HelpPopover>
        </div>
        <p className="mt-1 text-13 text-ink-300">模型配置（含用途路由 / 语义检索） · 网络代理 · 正文写作 AI 额度 · 联网检索 · AI 提示词 · AI 消耗统计</p>
      </header>

      <div className="space-y-4">
        {/* 未接入模型时先把「哪些会灰、为什么灰、灰了还剩什么」说清楚（2.4.0 · A1）——
            模型配置就在正下方，看完即可直接配。已就绪时本组件自行返回 null。 */}
        <AIDisabledNotice />

        {/* 模型配置（全局）：决定下面几块跟着谁走，所以放最上面 */}
        <AIConfigPanel onChange={() => setCfgVer(v => v + 1)} />

        {/* 网络代理（2026-09-28 · 社区需求）：内网网关 / 自建中转等统一出口环境按需开启；
            默认关闭跟随系统，配置仅存本机。合规口径见组件头注释 —— 文案不得写「绕过限制」。 */}
        <NetworkProxyPanel />

        {/* 正文写作链路的额度总闸门：跟着模型走，紧贴模型配置便于一起调。
            ⚠️ 与酒馆模式的额度互不冲突（酒馆那两个数在「酒馆模式 → 控制面板」）。 */}
        <AIWriterBudgetPanel refreshKey={cfgVer} />

        {/* 联网检索（全局）：起草 / 补完全走它 */}
        <SearchSettingsPanel />

        {/* AI 提示词：各功能内置提示词的前台设置 */}
        <AIPromptSettings refreshKey={cfgVer} />

        {/* 3.0 · W1-4：AI 消耗统计（本机账本汇总；切页签会重新挂载并重取数） */}
        <AIUsagePanel />
      </div>
    </div>
  )
}
