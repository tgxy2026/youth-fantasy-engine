/**
 * 控制面板 · **右列**：分模式的手感与输出规则（六、剧情推演 / 七、自由对话 / 八、本场数值）。
 *
 * 【为什么这么切】（2026-09-19 拆分，先量化后下刀）
 *   原 `TavernControl.tsx` 1397 行、45 个组件作用域标识符。逐段量「用到多少个父作用域名字」：
 *   右列合计只依赖 13 个（左列 27 个）—— 依赖最窄的一段，抽出来 props 面最小、风险最低。
 *   左列（一~五：通用 / 我的档案 / 预设 / 后处理 / 协议）留在父组件，它与 store 的耦合更密。
 *
 * 【契约】本组件**不持有任何状态**：设置对象与写回函数全由父组件传入，
 *   所以「改完点右上保存」的草稿语义与拆分前完全一致（没有第二份真相）。
 *
 * ⚠️ 返回 **Fragment**，不套外层 div —— 父组件用 `<div ref={rightColRef}>` 的**直接子节点**
 *   量高度来同步左列协议窗（见父组件注释）。多包一层 div 会让那段测量口径失效。
 */
import { Section, Field, GRID2, NumField, SelectField, TextField, ToggleField } from './TavernFieldKit'
import { Button } from './Button'
import { PARAM_GUIDES, GUIDE_SAMPLING, type ParamGuide } from '../lib/tavern/paramGuide'
import { VAR_DEFS, type VarKey } from '../lib/tavern/types'
import SamplingUnavailable from './SamplingUnavailable'
import type { TuningAdvice } from '../lib/modelCapacity'
import type { TavernSettings } from '../lib/tavern/settings'

/**
 * 客观描写档位（自由对话）。
 * 每一档都是**真值**，所以不传 emptyLabel（否则会多出一个空选项）。
 */
const SCENE_DESC_OPTIONS = [
  { id: 'off', label: '关闭 —— 只写对白与动作' },
  { id: 'light', label: '轻 —— 出场与转场时补一句' },
  { id: 'standard', label: '标准（推荐）—— 出场 / 环境 / 情绪都落到具体细节' },
  { id: 'rich', label: '丰富 —— 每回合都带一句环境或身体细节' },
]

/** 剧情推演：设定层从哪来（A 档） */
const CONTEXT_SOURCE_OPTIONS = [
  { id: 'both', label: '项目资料 + 背景设定（默认）' },
  { id: 'digest', label: '只用背景设定 —— 省字数，长篇推荐' },
  { id: 'raw', label: '只用项目资料 —— 不注入背景设定' },
]

type Props = {
  plot: TavernSettings['plot']
  free: TavernSettings['free']
  vars: TavernSettings['vars']
  setPlot: (k: keyof TavernSettings['plot'], v: number | string) => void
  setFree: (k: keyof TavernSettings['free'], v: number | string | boolean) => void
  setVars: (patch: Partial<TavernSettings['vars']>) => void
  toggleVarKey: (k: VarKey) => void
  /** 可选模型（「整理记忆用的模型」下拉用） */
  modelOptions: { id: string; label: string }[]
  /**
   * 「跟着模型走」的推荐值 + 对应的分段说明表（父组件算好，这里只管展示）。
   * 打包成一个 prop 是因为它整批同源（都由 `adviseCapacity()` 推出来），
   * 拆成 5 个平铺 prop 只会在调用处多五行噪音。
   */
  advice: { rec: TuningAdvice; gSoft: ParamGuide; gHard: ParamGuide; gLong: ParamGuide; gDiary: ParamGuide }
  /**
   * 当前模型是否本地（Ollama / 局域网）。
   * 🔴 2026-10-09（2.9.2）：三项 Ollama 专有采样参数（候选词上限 / 重复惩罚 / 惩罚射程）按它**灰显** ——
   *    此前云端模型下照旧可编辑，改了却不生效（下发时被 `openaiSampling()` 白名单静默丢弃），
   *    与「上下文窗口长度」在两态化之前的老毛病同一类。
   *
   * ⚠️ 判据是 **`type === 'ollama'`，不是「本地」** —— 本地 OpenAI 兼容服务（LM Studio 等）
   *    也是本地，却同样认不了这三个键（2026-10-09 审计修）。
   */
  ollamaNative: boolean
}

/** 云端模型下、Ollama 专有参数的灰显占位（与「上下文窗口长度」同一范式，2.9.2） */
function CloudOnlyNA({ label }: { label: string }) {
  return (
    <Field
      label={label}
      hint="此参数只对本地 Ollama 生效 —— 当前接的是云端模型，本项不参与调用，故不提供编辑；需微调请先切到本地模型。"
    >
      <SamplingUnavailable />
    </Field>
  )
}

export default function TavernControlModes({
  plot, free, vars, setPlot, setFree, setVars, toggleVarKey, modelOptions, advice, ollamaNative,
}: Props) {
  const { rec, gSoft, gHard, gLong, gDiary } = advice
  return (
    <>
      {/* ---------- 六、剧情推演控制 ---------- */}
      <Section
        title="六、剧情推演控制"
        desc="只对「剧情推演」生效。叙事向要的是稳 —— 角色反应得站得住，所以默认温度比自由对话低。"
      >
        <div className={GRID2}>
          <NumField
            label="温度" guide={GUIDE_SAMPLING.temperature}
            hint="叙事推演要稳 —— 角色反应得站得住，所以默认比自由对话低（0.9）。"
            value={plot.temperature} onCommit={v => setPlot('temperature', v)}
          />
          <NumField
            label="核采样阈值" guide={GUIDE_SAMPLING.topP}
            hint="每一步只从「累积概率达到这个值」的候选词里挑。越低候选面越窄。"
            value={plot.topP} onCommit={v => setPlot('topP', v)}
          />
          {ollamaNative ? (
            <NumField
              label="候选词上限" guide={GUIDE_SAMPLING.topK}
              hint="每一步只在概率最高的这么多个词里挑，填 0 表示不限制。"
              value={plot.topK} onCommit={v => setPlot('topK', v)}
            />
          ) : <CloudOnlyNA label="候选词上限" />}
          {ollamaNative ? (
            <NumField
              label="重复惩罚" guide={GUIDE_SAMPLING.repeatPenalty}
              hint="高于 1 会压制重复用词；太高会让句子发硬、用词别扭。"
              value={plot.repeatPenalty} onCommit={v => setPlot('repeatPenalty', v)}
            />
          ) : <CloudOnlyNA label="重复惩罚" />}
          <NumField
            label="词频惩罚" guide={GUIDE_SAMPLING.frequencyPenalty}
            hint="同一个词出现得越多扣得越狠。推演里的动作描写也容易「每轮都写手」，管的就是这一类反复。"
            value={plot.frequencyPenalty} onCommit={v => setPlot('frequencyPenalty', v)}
          />
          {ollamaNative ? (
            <NumField
              label="惩罚射程" guide={GUIDE_SAMPLING.repeatLastN}
              hint="上面两种惩罚共用的「回看多远」窗口。Ollama 自带只有 64 词元（约半句话）—— 上一轮的复读根本不在射程内，得靠它拉进来。"
              value={plot.repeatLastN} onCommit={v => setPlot('repeatLastN', v)}
            />
          ) : <CloudOnlyNA label="惩罚射程" />}
          <NumField
            label="新话题倾向" guide={GUIDE_SAMPLING.presencePenalty}
            hint="正数鼓励引入新内容，负数让它更愿意围着当前话题说。推演要线索连贯，所以默认偏保守（0.5）。"
            value={plot.presencePenalty} onCommit={v => setPlot('presencePenalty', v)}
          />
          <NumField
            label="设定层占比" guide={PARAM_GUIDES.plotSettingRatio}
            hint="上下文预算里分给「项目设定」的比例，剩下的留给长期记忆与对话历史。"
            value={Math.round(plot.settingRatio * 100)} onCommit={v => setPlot('settingRatio', v / 100)}
          />
        </div>

        <SelectField
          label="设定来源"
          hint="决定「世界与角色设定」这一层从哪来 —— 它每轮都进 system，是预算里最大的一块。"
          footer={(
            <div className="mt-1.5 space-y-1 text-10 text-ink-600 leading-relaxed">
              <p>· 两者（默认）：项目原始资料 + 你提炼的背景设定。资料最全，但项目原始资料本身就有四千六百字以上（示范项目实测还会丢 11 段），加上协议四千四百多字 —— 24000 的预算里 system 会吃掉一半左右，留给对话历史仍有一万多字。</p>
              <p>· 只用背景设定：设定层只留「作品概览 + 章节清单」（约 2200 字），世界规则靠你提炼的那份，省下的全给对话历史。代价是没在场配角的卡、名词 / 地理 / 历史细节不再注入 —— 所以背景设定里建议把「主要人物关系」写成一节，并让关键词留空（始终注入）。</p>
              <p>· 只用项目资料：不注入背景设定那一层。</p>
            </div>
          )}
          value={plot.contextSource}
          options={CONTEXT_SOURCE_OPTIONS}
          onChange={v => setPlot('contextSource', v)}
        />

        <TextField
          label="叙事向风格追加"
          hint="默认留空 —— 不追加就走协议默认的写法（这本来就是方案的原意）。填了会追加在档位那一层。"
          minRows={2}
          placeholder="例：多用白描，少用形容词；每轮至少给出一个具体的环境细节。"
          value={plot.styleHint}
          onChange={v => setPlot('styleHint', v)}
        />
        <TextField
          label="剧情推演补充要求"
          hint="只对剧情推演生效，排在协议之前。"
          minRows={3}
          placeholder="例：作者扮演的角色一律不要代写；不确定的地方宁可留白，也不要替作者做决定。"
          value={plot.extraPrompt}
          onChange={v => setPlot('extraPrompt', v)}
        />
      </Section>

      {/* ---------- 七、自由对话控制 ---------- */}
      <Section
        title="七、自由对话控制"
        desc="只对「自由对话」生效。陪伴要松弛感，所以温度默认更高；下面还有记忆引擎与日常推进的一组阈值。"
      >
        <div className={GRID2}>
          <NumField
            label="温度" guide={GUIDE_SAMPLING.temperature}
            hint="陪伴要松弛感，默认 0.95 —— 比剧情推演（0.9）更放得开。"
            value={free.temperature} onCommit={v => setFree('temperature', v)}
          />
          <NumField
            label="核采样阈值" guide={GUIDE_SAMPLING.topP}
            hint="每一步只从「累积概率达到这个值」的候选词里挑。越低候选面越窄。"
            value={free.topP} onCommit={v => setFree('topP', v)}
          />
          {ollamaNative ? (
            <NumField
              label="候选词上限" guide={GUIDE_SAMPLING.topK}
              hint="每一步只在概率最高的这么多个词里挑，填 0 表示不限制。"
              value={free.topK} onCommit={v => setFree('topK', v)}
            />
          ) : <CloudOnlyNA label="候选词上限" />}
          {ollamaNative ? (
            <NumField
              label="重复惩罚" guide={GUIDE_SAMPLING.repeatPenalty}
              hint="角色的口头禅多，所以这一项比剧情模式更值得调。"
              value={free.repeatPenalty} onCommit={v => setFree('repeatPenalty', v)}
            />
          ) : <CloudOnlyNA label="重复惩罚" />}
          <NumField
            label="词频惩罚" guide={GUIDE_SAMPLING.frequencyPenalty}
            hint="同一个词出现得越多扣得越狠。角色的口头禅、习惯小动作最容易反复 —— 这一项比「重复惩罚」更对症。"
            value={free.frequencyPenalty} onCommit={v => setFree('frequencyPenalty', v)}
          />
          {ollamaNative ? (
            <NumField
              label="惩罚射程" guide={GUIDE_SAMPLING.repeatLastN}
              hint="上面两种惩罚共用的「回看多远」窗口。Ollama 自带只有 64 词元（约半句话）—— 上一轮的复读根本不在射程内，得靠它拉进来。"
              value={free.repeatLastN} onCommit={v => setFree('repeatLastN', v)}
            />
          ) : <CloudOnlyNA label="惩罚射程" />}
          <NumField
            label="新话题倾向" guide={GUIDE_SAMPLING.presencePenalty}
            hint="正数鼓励引入新内容 —— 日常聊天靠它才有「日子在往前走」的感觉。默认 0.55。"
            value={free.presencePenalty} onCommit={v => setFree('presencePenalty', v)}
          />
        </div>

        <SelectField
          label="整理记忆用的模型"
          hint="记忆压缩不需要创意，越快越省越好，可以单独指一个便宜的小模型。留空则跟随上面的默认模型。"
          value={free.summaryProviderId}
          options={modelOptions}
          emptyLabel="（跟随默认模型）"
          onChange={v => setFree('summaryProviderId', v)}
        />


        <SelectField
          label="客观描写"
          hint="只写对白与动作，画面是空的 —— 这一项决定要不要写「Ta 穿什么、屋里什么光、外面什么天气」。写法固定：用全角括号（ ）包住、独立成行（与协议的括号是同一套 —— 【】已废止，别再用）。标准档：出场交代穿着与姿态、转场补一句环境、情绪用外在细节表示（都只写观察得到的东西，不写任何人的心理 —— 那是代写）。描写算在协议那 60–160 字里，别指望它长篇铺陈。"
          value={free.sceneDescription}
          options={SCENE_DESC_OPTIONS}
          onChange={v => setFree('sceneDescription', v)}
        />

        <TextField
          label="聊天向风格提示"
          hint="自由对话的档位层。默认是「现代日常场景、短句为主、最多连发 2 条」。⚠️ 它每轮都注入、且离生成点最近 —— 会盖过角色卡里「3 尺度」那类表达密度设定：角色卡写「可以靠得很近、可以哭」，这里却钉着「短句聊天体」，演出来就会显得疏远。想让密度以角色卡为准，这里就别写死太窄（留空则走默认）。"
          minRows={2}
          value={free.styleHint}
          onChange={v => setFree('styleHint', v)}
        />
        <TextField
          label="自由对话补充要求"
          hint="只对自由对话生效，排在协议之前。"
          minRows={3}
          placeholder="例：不要替作者的角色做决定；Ta不确定的事就写不确定。"
          value={free.extraPrompt}
          onChange={v => setFree('extraPrompt', v)}
        />

        <div className="pt-1">
          <div className="mb-1 text-12 text-ink-200 border-t border-ink-700 pt-3">记忆引擎</div>
          {/* 🚫 2026-09-16：这里原来的「触发整理」与「自动整理最小间隔」已删 ——
              项目不再有任何自动整理（两种模式都改为作者手动触发：自由对话「结束本轮对话」、
              剧情推演「整理本场记忆」），留着这两个旋钮只会让人以为拧了有用。 */}
          <p className="mb-3 text-10 leading-relaxed text-ink-500">
            下面几项决定记忆怎么压、怎么滚。<span className="text-ink-400">整理时机不在这一栏</span>——
            现在没有自动整理：自由对话在点「结束本轮对话」时整理，剧情推演点「整理本场记忆」。
            <br />
            这四项的推荐值跟着<span className="text-ink-400">上下文预算</span>走（也就跟着当前模型走）：
            预算大，记忆可以多存一些；预算小就别让记忆抢了对话历史。
          </p>
          <div className={GRID2}>
            <NumField
              label="记忆软上限" guide={gSoft} recommend={rec.softLimit}
              hint="超过只在界面上提醒，不会硬截断。"
              value={free.softLimit} onCommit={v => setFree('softLimit', v)}
            />
            <NumField
              label="记忆硬上限" guide={gHard} recommend={rec.hardLimit}
              hint="超过就按「长期摘要 → 纪念日 → 关系状态」的顺序压缩；关键事实与未爆的雷不动。"
              value={free.hardLimit} onCommit={v => setFree('hardLimit', v)}
            />
            <NumField
              label="长期摘要上限" guide={gLong} recommend={rec.longTermLimit}
              hint="「长期摘要」这一栏单独的字数上限，也是最优先被压缩的一栏。推荐值取硬上限的约六分之一。"
              value={free.longTermLimit} onCommit={v => setFree('longTermLimit', v)}
            />
            <NumField
              label="日记保留" guide={gDiary} recommend={rec.diaryDays}
              hint="「最近日记」保留几条，新的在上、旧的自动滚动掉。它数的是生活痕迹，跟窗口大小相关性弱，所以推荐值按开方缩放（涨得比预算慢）。"
              value={free.diaryDays} onCommit={v => setFree('diaryDays', v)}
            />
            <NumField
              label="整理锁有效期" guide={PARAM_GUIDES.summaryLock}
              hint="防止两个窗口同时整理记忆。上次整理跑到一半崩了，超过这个时间就可以被接管。"
              value={free.summaryLockTtlMin} onCommit={v => setFree('summaryLockTtlMin', v)}
            />
          </div>
        </div>

        <div className="pt-1">
          <div className="mb-3 text-12 text-ink-200 border-t border-ink-700 pt-3">日常推进</div>
          <div className={GRID2}>
            <NumField
              label="推进间隔" guide={PARAM_GUIDES.dailyAdvance}
              hint="距上次活跃超过这么久，才补写一段「这几天的生活」。没有常驻进程，只能靠打开界面时推进。"
              value={free.dailyAdvanceHours} onCommit={v => setFree('dailyAdvanceHours', v)}
            />
            <NumField
              label="生活记录保留" guide={PARAM_GUIDES.dailyKeep}
              hint="「这几天的生活」保留几条（一天一条），新的在上。"
              value={free.dailyLogKeep} onCommit={v => setFree('dailyLogKeep', v)}
            />
          </div>
        </div>

        <div className="pt-1">
          <div className="mb-3 text-12 text-ink-200 border-t border-ink-700 pt-3">收尾与释放</div>
          <ToggleField
            label="结束本轮对话后卸载本地模型"
            hint="收尾（记忆 / 日记 / 数值 / 设定建议）全部跑完之后，让本机 Ollama 把这个模型退出显存。模型留在显存里时会带着上一场的上下文 —— 清空了记忆它却还隐约记得，打开这项就能从干净状态开下一场。只对本机 Ollama 生效。"
            value={free.unloadAfterRoundEnd}
            onChange={v => setFree('unloadAfterRoundEnd', v)}
          />
          <p className="mt-2 text-10 leading-relaxed text-ink-500">
            代价是「下一场的第一句要等模型重新加载」（本地 27B 上这一步是几十秒），所以默认是关的 ——
            需要「每场都从干净状态开始」时再打开。
          </p>
        </div>
      </Section>
      {/* ---------- 八、本场数值（C2 第二步） ---------- */}
      <Section
        title="八、本场数值"
        desc="只对「自由对话」生效：每轮自动算数值变化，能手改。三项均 −100~+100（0 中立）；精神为负时角色会偏离角色卡。"
      >
        <ToggleField
          label="启用本场数值"
          hint="关掉 = 提示词里一个字都不出现（0 字成本），自由对话右栏的「本场状态」也不再显示它。"
          value={vars.enabled}
          onChange={v => setVars({ enabled: v })}
        />

        <Field
          label={`启用哪几项（已启用 ${VAR_DEFS.filter(d => !(vars.off ?? []).includes(d.key)).length} / ${VAR_DEFS.length}）`}
          hint="点一下切换。关掉的项不会进提示词；「精神」为负时角色会做出偏离人设的言行，配合剧本的「这一场的目标」用最有意义。"
        >
          <div className="flex flex-wrap gap-2">
            {VAR_DEFS.map(d => {
              const on = !(vars.off ?? []).includes(d.key)
              return (
                <Button
                  key={d.key} variant="toggle" size="sm"
                  selected={on} onClick={() => toggleVarKey(d.key)}
                >
                  {on ? '✓ ' : ''}{d.label}
                  <span className="ml-1 text-10 text-ink-500">
                    {d.kind === 'num' ? `${d.min}–${d.max}` : `≤${d.maxLen} 字`}
                  </span>
                </Button>
              )
            })}
          </div>
        </Field>

        <NumField
          label="单次变化幅度" guide={PARAM_GUIDES.varMaxStep}
          hint="模型给出的增量超过这个值就按这个值取（它是刹车，不是目标值）。"
          value={vars.maxStep} onCommit={v => setVars({ maxStep: Math.max(1, Math.round(v)) })}
        />

        <p className="text-10 text-ink-600 leading-relaxed">
          自由对话里每轮回复后都会单开一次小调用，把这一轮真的变了的项算出来（点「结束本轮对话」时再兜底算一次）。
          写进提示词的有三样：当前值、一次能改多少，以及每一项的档位定义（哪一段算反感、哪一段算亲近），
          模型据此判断现在落在哪一档、该往哪走。算不出来时一个字段都不动 —— 绝不会为了记账改错你要看的内容。
        </p>
      </Section>
    </>
  )
}
