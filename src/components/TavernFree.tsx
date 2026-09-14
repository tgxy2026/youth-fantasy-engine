/**
 * 酒馆模式 · 自由对话（tavern-free）
 *
 * 定位：**陪伴**。自建角色卡的长期对话，有六栏记忆、有日常状态（时间差推进）、
 * 可选多角色同场。
 *
 * 实施阶段：P0（骨架与空态）；P2 落地单角色对话 + 记忆，P3 补日常/留言/多角色。
 */
export default function TavernFree() {
  return (
    <div className="page-enter">
      <header className="mb-5 sticky top-0 z-10 bg-ink-900/95 backdrop-blur py-3 -mt-3">
        <h1 className="text-xl font-bold text-ink-50">自由对话</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          与自建角色的长期对话：记得住事、有时间流逝感、可以换场景开新会话（记忆按角色共享）。
        </p>
      </header>

      <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-10 text-center">
        <p className="text-[13px] text-ink-300">还没有角色可聊</p>
        <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
          先在「角色卡」建一张卡，或从小说角色转换一张过来。
          <br />
          （功能建设中，P2 / P3 落地）
        </p>
      </div>
    </div>
  )
}
