/**
 * 酒馆模式 · 剧情推演（tavern-plot）
 *
 * 定位：**诊断台**。你扮演书中一个角色，AI 扮演另一个，试演一场戏 ——
 * 看角色在具体情境下的反应是否合理。
 *
 * 实施阶段：P0（骨架与空态）；P1 补建会话四步流程与对话界面。
 */
export default function TavernPlot() {
  return (
    <div className="page-enter">
      <header className="mb-5 sticky top-0 z-10 bg-ink-900/95 backdrop-blur py-3 -mt-3">
        <h1 className="text-xl font-bold text-ink-50">剧情推演</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          选一个叙事锚点，分配角色（你演谁 / AI 演谁），试演一场戏看角色反应是否合理。
        </p>
      </header>

      <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-10 text-center">
        <p className="text-[13px] text-ink-300">功能建设中（P1 · 剧情模式）</p>
        <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
          落地顺序：建会话四步（锚点 → 角色分配 → 信息边界档位 → 开场）
          → 扮演设定与事实边界 → 对话界面 → 结束推演并产出报告。
        </p>
      </div>
    </div>
  )
}
