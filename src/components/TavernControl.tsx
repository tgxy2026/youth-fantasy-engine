/**
 * 酒馆控制面板（两列：左＝通用与契约；右＝分模式的手感；C1 · 2.4.2 拆分后收口）
 *
 * 拆分为：tavernControlParts（常量）+ useTavernControlModel（状态与派生）
 *   + 左列三个子组件（TavernControlBasics / Advanced / Protocol，只收 m）。
 * 右列仍是 TavernControlModes（上一轮拆出，靠 props 通信，本轮未动）。
 *
 * 🔴 三条不能动的地方（拆错了实机立刻现形，见 docs/2.4.2-C1-TavernControl拆分记录.md）：
 *   ① 左列 div（leftColRef）与右列 div（rightColRef）必须留在本组件：协议窗高度同步量的是
 *      它们的**直接子节点**，子组件一律返回 Fragment ⇒ 这层子节点数恒为 5 与 3。
 *   ② 高度同步 effect（含 ResizeObserver/MatchMedia 清理）在 useTavernControlModel 里，未改。
 *   ③ 分段说明的显隐走 ShowBands.Provider，Provider 本身留在本组件。
 */
import HelpPopover from './HelpPopover'
import PromptModal from './PromptModal'
import TavernControlModes from './TavernControlModes'
import { LoadingState } from './LoadingState'
import { Button } from './Button'
import { ShowBands } from './TavernFieldKit'
import { useTavernControlModel } from './useTavernControlModel'
import TavernControlBasics from './TavernControlBasics'
import TavernControlAdvanced from './TavernControlAdvanced'
import TavernControlProtocol from './TavernControlProtocol'
export default function TavernControl() {
  const m = useTavernControlModel()
  // 前置数据未就绪：与拆分前一样先出 LoadingState（判断已随 hook 前移，语义不变）
  if (!m) return <LoadingState />
  const { s, showBands, setShowBands, dirty, saving, presetNaming, setPresetNaming, leftColRef, rightColRef, storePresetAs, setPlot, setFree, setVars, toggleVarKey, save, reset, pl, fr, modelOptions, rec, gSoft, gHard, gLong, gDiary } = m
  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          {/* h1 是块级元素，问号必须与它同处一个 flex 行内容器，否则会被挤到标题下一行 */}
          <div className="flex items-center gap-1.5">
            <h1 className="text-16 text-ink-100">控制面板</h1>
            <HelpPopover title="控制面板怎么用" width="24rem" size={14}>
              {'酒馆模式全部「接进 AI 的参数与提示词」都在这里，只影响酒馆对话、不碰正文写作的模型配置。改完点右上「保存」，下一轮对话开始时生效。\n\n· 左列是「全局的、一次调好就不动的」：跟谁说、我是谁、整套怎么存，以及两种模式共用的格式契约（输出后处理）；\n· 右列是「分模式的手感与输出规则」：剧情推演 / 自由对话各自的采样参数与阈值、本场数值；\n· 每个数值都标了取值范围；「显示分段说明」打开后，还能看到「调大 / 调小分别会怎样」；\n· 「三、预设方案」可以把整套设置存成快照，一键切换或导出分享；\n· 默认值就是出厂值：不动它时行为与之前完全一致。'}
            </HelpPopover>
          </div>
          <p className="mt-1 text-12 text-ink-500 leading-relaxed">
            全部参数改动只影响酒馆对话，不碰正文写作的模型配置。改完点右上「保存」，下一轮对话开始时生效。
            <br />
            默认值就是内置的出厂值 —— 不动它时行为与之前完全一致。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && <span className="text-11 text-amber">有未保存的改动</span>}
          <Button
            variant="secondary" size="sm" onClick={() => setShowBands(v => !v)}
            title="每个数值项下面的「取值范围 + 分段影响」表。全部摊开页面会很长，可以一键收起（当前值的档位仍会显示）"
          >
            {showBands ? '收起分段说明' : '显示分段说明'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void reset()}>恢复默认</Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      {/* ==================== 两列：左＝通用与契约；右＝分模式的手感 ====================
          网格默认 align-items:stretch → 两列等高；左列的协议窗高度由 JS 同步（见 PROTO 注释）。 */}
      <ShowBands.Provider value={showBands}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">

        {/* ========== 左列 ========== */}
        <div ref={leftColRef} className="space-y-4 xl:flex xl:min-h-0 xl:flex-col">

        <TavernControlBasics m={m} />
        <TavernControlAdvanced m={m} />
        <TavernControlProtocol m={m} />
        </div>

        {/* ========== 右列（它的高度是协议窗高度的基准） ==========
            下标 div 必须留在**本组件**：协议窗高度同步量的是它的**直接子节点**。
            子组件返回 Fragment，DOM 里这层的子节点仍是三个 <section>（与拆分前一致）。 */}
        <div ref={rightColRef} className="space-y-4">
          <TavernControlModes
            plot={pl}
            free={fr}
            vars={s.vars}
            setPlot={setPlot}
            setFree={setFree}
            setVars={setVars}
            toggleVarKey={toggleVarKey}
            modelOptions={modelOptions}
            advice={{ rec, gSoft, gHard, gLong, gDiary }}
          />
        </div>
      </div>
      </ShowBands.Provider>

      <PromptModal
        open={presetNaming}
        title="存为预设"
        label="预设名"
        placeholder="例：快速脑暴 / 精修成稿 / 慢节奏日常"
        onSubmit={n => {
          // ⚠️ 必须在这里关弹窗：PromptModal 自己不关，全靠调用方 ——
          //    漏掉这一步的表现是「点了确定，弹窗不走、还把后面的点击全挡住」（实机抓到）
          setPresetNaming(false)
          void storePresetAs(n)
        }}
        onCancel={() => setPresetNaming(false)}
      />
    </div>
  )
}
