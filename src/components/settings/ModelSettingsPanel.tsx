import { useState } from 'react'
import HelpPopover from '@/components/common/HelpPopover'
import AIConfigPanel from '@/components/settings/AIConfigPanel'
import AIDisabledNotice from '@/components/ai/AIDisabledNotice'
import AIWriterBudgetPanel from '@/components/settings/AIWriterBudgetPanel'
import SearchSettingsPanel from '@/components/settings/SearchSettingsPanel'
import AIPromptSettings from '@/components/settings/AIPromptSettings'
import NetworkProxyPanel from '@/components/settings/NetworkProxyPanel'
import AIUsagePanel from '@/components/settings/AIUsagePanel'

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
      <header className="mb-6" data-guide="settings-header">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">模型设置</h1>
          <HelpPopover title="模型设置怎么用" width="24rem" size={14}>
            <p>先在「运行模式」选择调用方式。API 模式使用配置的模型。MCP 模式供外部客户端访问已授权的作品资料。Windows x64 桌面版可显示 ACP 模式，组件能否连接以 ACP 设置区的状态为准。便携版提供 API 和 MCP，网页版使用联网 API 模型。每次只生效一种模式。</p>
            <p className="mt-2">API 模式下可设置模型、用途路由、语义检索与联网检索。正文写作 AI 额度控制单次带入的项目资料量。AI 提示词可按页面列出的功能编辑或还原。</p>
            <p className="mt-2">AI 消耗统计查看本机账本。网络代理按需设置。酒馆的额度与扮演协议在「酒馆模式 → 控制面板」设置。</p>
          </HelpPopover>
        </div>
        <p className="mt-1 text-13 text-ink-300">模型配置（含用途路由 / 语义检索） · AI 消耗统计 · 网络代理 · 正文写作 AI 额度 · 联网检索 · AI 提示词</p>
      </header>

      <div className="space-y-4">
        {/* 未接入模型时先把「哪些会灰、为什么灰、灰了还剩什么」说清楚（2.4.0 · A1）——
            模型配置就在正下方，看完即可直接配。已就绪时本组件自行返回 null。 */}
        <AIDisabledNotice />

        {/* 模型配置（全局）：决定下面几块跟着谁走，所以放最上面 */}
        <div data-guide="settings-models">
          <AIConfigPanel onChange={() => setCfgVer(v => v + 1)} />
        </div>

        {/* 3.0 · W1-4：AI 消耗统计（本机账本汇总；切页签会重新挂载并重取数）——
            紧跟模型配置：它回答的正是「这个模型这段时间用了多少、被拒了几次」。 */}
        <AIUsagePanel />

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
      </div>
    </div>
  )
}
