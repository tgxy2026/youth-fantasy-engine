/**
 * 酒馆模式 · 角色卡（tavern-card）
 *
 * 定位：自由模式的角色卡管理。四章模板（世界 / 人物档案 / 行为规范 / 示例对话），
 * 分区块表单编辑；可新建、导入导出、从小说角色 AI 转换。
 *
 * 实施阶段：P0（骨架与空态）；P2 落地 CRUD 与表单，P3 补单向桥与导入导出。
 */
export default function TavernCard() {
  return (
    <div className="page-enter">
      <header className="mb-5 sticky top-0 z-10 bg-ink-900/95 backdrop-blur py-3 -mt-3">
        <h1 className="text-xl font-bold text-ink-50">角色卡</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          自由模式的角色卡：四章模板（世界 / 人物档案 / 行为规范 / 示例对话），与小说项目相互独立。
        </p>
      </header>

      <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-10 text-center">
        <p className="text-[13px] text-ink-300">还没有角色卡</p>
        <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
          落地顺序：分区块表单（含「示例对话」的填写引导）→ 导入导出 → 从小说角色 AI 转换。
          <br />
          （功能建设中，P2 / P3 落地）
        </p>
      </div>
    </div>
  )
}
