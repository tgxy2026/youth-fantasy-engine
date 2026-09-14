/**
 * 酒馆模式 · 推演报告（tavern-report）
 *
 * 定位：剧情模式的产出。每条 finding 必须能指回具体条目
 * （targetTabId + targetRecordId + targetLabel），否则作者拿到的是一堆「感觉有点问题」的废话。
 * 指不回去的降级为「存疑」并留空 id，UI 单独分组。
 *
 * 实施阶段：P0（骨架与空态）；P1 随「结束推演」一并落地。
 */
export default function TavernReport() {
  return (
    <div className="page-enter">
      <header className="mb-5 sticky top-0 z-10 bg-ink-900/95 backdrop-blur py-3 -mt-3">
        <h1 className="text-xl font-bold text-ink-50">推演报告</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          每场推演结束后的合理性报告：矛盾 / 漏洞 / 存疑三档，每条尽量指向具体角色卡或关系条目。
        </p>
      </header>

      <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-10 text-center">
        <p className="text-[13px] text-ink-300">还没有推演报告</p>
        <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
          去「剧情推演」演完一场并点「结束推演」，报告会出现在这里。
          <br />
          （功能建设中，P1 落地）
        </p>
      </div>
    </div>
  )
}
