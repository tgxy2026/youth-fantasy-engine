/**
 * 酒馆模式 · 自由对话（tavern-free）
 *
 * 定位：**陪伴**。自建角色卡的长期对话 —— 记得住事、有时间流逝感、换场景可开新会话
 * （记忆按角色共享，不随会话走）。
 *
 * 【2026-09-14 第三轮改版：页面版式对齐「剧情推演」】
 *   · 页面上的**角色列表撤掉了** —— 选角色改由「＋ 新建对话」弹窗承担（位置槽位 + 搜索选角），
 *     左栏腾给**会话列表**，一屏能看到所有对话、点一下就切，不再挂在某个角色下面；
 *   · 因此会话列表是**全局的**（跨角色）：每条副行标出在场角色，否则分不清这是和谁聊的；
 *   · 「记忆 / 日常」依然是**角色级**的，所以打开会话时取**该会话第一个角色**作为主角色
 *     （`primary`）来读记忆、跑总结、推进日常 —— 多角色会话下这是唯一自洽的口径。
 *
 * 【无服务端带来的三个 UI 义务（方案 §11 明确要求，不能吞掉）】
 *   1. 总结「不即时」—— 只能回复后判阈值、或下次打开补算。界面必须显示
 *      「记忆更新于 X」，让作者知道记忆的时效边界。
 *   2. 会话超长后早期原文会从上下文消失 —— 原文仍在记录里可翻回，
 *      但预算条要显示占用，别让作者以为模型还记得。
 *   3. 记忆是**角色级**的：换会话不会重来，所以新建对话时要写清这一点。
 *
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），
 * 提示用 showToast。
 */

import HelpPopover from '@/components/common/HelpPopover'
import { Z } from '@/lib/app/zLayer'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import TavernEchoHints from '@/components/tavern/TavernEchoHints'
import { ChevronDown, Clapperboard, Pencil } from 'lucide-react'
import { showToast, } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { LoadingState } from '@/components/common/LoadingState'
import TavernFreeSetup, { } from '@/components/tavern/TavernFreeSetup'
import PromptModal from '@/components/dialogs/PromptModal'
import TavernCastDirector from '@/components/tavern/TavernCastDirector'
import TavernRevisionDialog from '@/components/tavern/TavernRevisionDialog'
import TavernExportDialog from '@/components/tavern/TavernExportDialog'
import TavernStatusBar from '@/components/tavern/TavernStatusBar'
import TavernVarsPanel from '@/components/tavern/TavernVarsPanel'
// 🔴 3.0 · W2-5b（§13 F3）：「未整理轮数」判据 —— 与收尾用的是**同一个**纯函数，不另立口径
import { pendingMessages } from '@/lib/tavern/roundEnd'
import TavernUsageDialog from '@/components/tavern/TavernUsageDialog'
import Avatar from '@/components/common/Avatar'
import TavernMessageBody from '@/components/tavern/TavernMessageBody'
import TavernQuickBar, { } from '@/components/tavern/TavernQuickBar'
import TavernDirectorNoteBar from '@/components/tavern/TavernDirectorNoteBar'
import { renderTavernMessage } from '@/components/tavern/TavernMessage'
import AutoTextarea from '@/components/common/AutoTextarea'
import * as store from '@/lib/tavern/store'





import {
  
  
  type VarKey, type CharVars, type TavernVars,
} from '@/lib/tavern/types'
import { VAR_SCALE, } from '@/lib/tavern/vars'
import { scriptSceneLine, isOpeningMessage } from '@/lib/tavern/script'


import { freeDocModel, } from '@/lib/tavern/exportDoc'
import { agoText } from '@/lib/tavern/status'
import { type RoundEndStage } from '@/lib/tavern/roundEnd'

/** 收尾各阶段在界面上的措辞（多角色时还会附上「第几个/共几个」） */
const STAGE_TEXT: Record<RoundEndStage, string> = {
  memory: '整理记忆与日记…',
  vars: '结算本场数值…',
  revise: '审查设定…',
  done: '已收尾',
}

/** 把角色卡上的持久状态（CharVars）转成面板要的 TavernVars 形状（面板只用 values，log/turnSeq 是会话级流水，这里给空壳） */
function charVarsToTavern(cv?: CharVars): TavernVars | undefined {
  if (!cv) return undefined
  return { values: cv.values, turnSeq: 0, log: [], scale: VAR_SCALE }
}

import { useTavernFreeModel, primaryAiCharId } from '@/components/tavern/useTavernFreeModel'
import TavernFreeSessionList from '@/components/tavern/TavernFreeSessionList'

export default function TavernFree() {
  // 状态与生命周期全在 model 里；下面同名解构是刻意的 —— JSX 保持原样、零改动。
  const model = useTavernFreeModel()

  const {
    // 会话 / 故事 / 角色数据
    session, chars, charCard, aiCards, myProfile, castCards, nameOf, exportSpeakerOf,
    // 左栏检索与新建
    input, setSetupOpen, setupOpen,
    // 消息与输入
    inputRef, setInput, fillInput, send, stop, streaming, phase, streamText, assistBusy, quickActions, applyDirectorNote, directorRows,
    // 消息操作（编辑 / 重生成 / 隐藏 / 删除）
    saveEdited, toggleHidden, removeMsg, reroll, lastAiId, selectVariant, saveTitle, editingTitle, setEditingTitle, titleDraft, setTitleDraft, removeSession, updateAtBottom,
    // 检查点 / 回滚（F1 自由模式分支）
    cpNaming, setCpNaming, saveCheckpoint, commitCheckpoint, rollbackToCp, undoRollbackCp, dropCp,
    // 滚动
    scrollRef, scrollToBottom, atBottom, usedChars,
    // 数值与状态
    varKeys, varsCharId, setVarsCharId, statusCharId, setStatusCharId, statusModel, statusTab, setStatusTab, setVar, setPrimaryNote, setOtherVar, setOtherNote, resetOtherVars, resetVars,
    // 收尾 / 待发留言 / 日常
    ending, endStage, endResult, setEndResult, endRound, stopEndRound, daily, showDaily, setShowDaily, greeting, setGreeting, postNotice, applyDirection,
    // AI 设定更新（建议 / 采纳）
    reviseOpen, setReviseOpen, openRevise, revising, applyingRev, reviseError, proposals, picked, setPicked, applyPicked,
    // 多角色接话
    speakNext, setSpeakNext,
    // 🔴 AI 就绪（2026-09-22 六维审计 F1）
    aiReady, aiReadyLabel,
    // 弹窗与抽屉
    usageOpen, setUsageOpen, directorOpen, setDirectorOpen, exportOpen, setExportOpen,
    // 其他
    loading, createFromDraft,
  } = model

  // ---------- 渲染 ----------
  if (loading) return <div className="page-enter"><LoadingState /></div>

  return (
    <div data-adaptive-conversation className="page-enter flex h-full flex-col overflow-hidden">
      {/* 顶部：只放「本场」的操作，导航（选/新建）都在左栏 */}
      <header data-guide="page-header" className="shrink-0 flex flex-wrap items-center gap-2 border-b border-ink-700 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">自由对话</h1>

        <HelpPopover title="自由对话怎么用" width="24rem" size={14}>
  这里的对话不绑小说项目：换一本书，角色卡与记忆照样在。

  · 顶部几件：Ta最近几天（每日小结）、结束本轮对话（整理记忆、写日记、结算本场数值、检查要不要改设定，
    然后这一场归档为只读）、导出。
  · 右侧常驻「本场状态」：好感 / 信任 / 精神 / 心情 / 地点 这些即时数值（可直接改，改完回车生效），以及在场由 AI 扮演的角色。
  · 多角色同场时点头像可指定下一位接话；「在场调度」里能静音某个人、调健谈度。
  · 记忆按角色存、跨会话共享 —— 换一场对话不会失忆。但它只在点「结束本轮对话」时才整理，
    所以聊天过程中不会被整理任务卡住；整理好的记忆与日记在「角色卡片」页里看。
  · 想给这一场一个具体处境，就在新建对话时选一份剧本（「故事剧本」里写，要先有故事）。
  · 「聊天向风格提示」在「控制面板 → 自由对话参数」—— 它每轮都在、且离生成点最近，会盖过角色卡里写的「3 尺度」；两者打架时以它为准，想让密度回到角色卡就把它放宽。
  <AIDataSourceNote feature="tavern-free" />
</HelpPopover>
        {session && <span className="max-w-[28rem] truncate text-12 text-ink-400" title={session.title}>{session.title}</span>}
        <div className="flex-1" />
        {session && (
          <>
            {!!daily?.log?.length && (
              <Button variant="secondary" size="md" onClick={() => setShowDaily(v => !v)}>
                {showDaily ? '收起这几天' : 'Ta最近几天'}
              </Button>
            )}
            {/* 🔴 3.0 · W2-5b（§13 F3）：「本场还有 N 轮未整理」。
                判据与收尾**同源**（`pendingMessages` = 水位线之后的消息），
                🔴 **纯派生**：每次渲染现算，不进任何 state（方案原话：该提示若常驻，
                其状态不能放组件 state）。只提示、不新增入口 —— 整理仍走「结束本轮对话」。
                🔴 规格：**刻意保留 `<span>` 而非 Button** —— 它不是可点入口，套 Button 会让作者
                   本能去点（与「整理只走结束本轮对话」相悖）。但盒子规格逐项对齐 size="md"
                   （h-9 / px-4 / text-13 / rounded-lg，与 SIZE.md 基线同源），否则并排时明显"塌一截"。
                   配色取 `toggle` 选中态令牌（amber/15 + amber/30），比右侧实心红 CTA 弱一档，不抢视线。 */}
            {!session.endedAt && (() => {
              const n = pendingMessages(session).length
              if (!n) return null
              return (
                <span
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg h-9 px-4 border border-amber/30 bg-amber/15 text-13 text-amber"
                  title={`本场还有 ${n} 轮对话没进长期记忆 —— 点「结束本轮对话」才会整理（各角色记忆 / 日记 / 数值 / 设定建议）`}
                >
                  未整理 {n} 轮
                </span>
              )
            })()}
            {/* 已归档：先说明状态再给唯一的补救入口 —— 顺序不能反，
                否则作者第一眼看到的是「新开一场」，会以为自己的对话没了。
                规格同上（对齐 size="md" 的盒高与字号），否则这一条会比旁边的按钮矮一截。 */}
            {session.endedAt ? (
              <span className="inline-flex shrink-0 items-center rounded-lg h-9 px-4 text-13 text-amber/80">
                本轮已于 {agoText(session.endedAt)}结束（只读）
              </span>
            ) : null}
            <Button
              variant={session.endedAt ? 'secondary' : 'danger'} size="md"
              disabled={ending || !!session.endedAt}
              title={session.endedAt
                ? '这一场已经整理归档了'
                : '整理这一场：更新各角色记忆、写本场日记、结算数值，并把对话归档为只读'}
              onClick={() => void endRound()}
            >
              {ending ? '收尾中…' : (session.endedAt ? '已结束' : '结束本轮对话')}
            </Button>
            {/* 🔴 收尾要好几分钟（逐角色总结 + 数值 + 设定审查），必须留一条退路。
                中止后不落任何数据，这一场仍是未结束状态，可以重来。 */}
            {ending && (
              <Button
                variant="secondary" size="md"
                onClick={stopEndRound}
                title="停止收尾：已产出的内容一律不落库，这一场仍是未结束状态"
              >
                中止
              </Button>
            )}
            <Button
              variant="secondary" size="md" disabled={streaming || session.messages.length === 0}
              onClick={() => setExportOpen(true)}
              title="把这场对话导出成 Markdown 或带样式的单文件 HTML。只含对话正文与场景信息，不含角色记忆与日记"
            >
              导出
            </Button>
            <Button variant="danger" size="md" onClick={() => void removeSession()}>删除对话</Button>
          </>
        )}
      </header>

      {/* 元指令速查：**必须留在 header 外面** —— 放进输入区的话，没有会话时那块不渲染，
          新用户就永远看不到「可以用「」指挥 Ta」这条。这里常驻可见。 */}
      <TavernEchoHints className="mt-3 shrink-0" />

      <div data-conversation-layout className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左栏：会话列表（全局，跨角色 —— 页面不再有角色列表） */}
        <TavernFreeSessionList model={model} />

        {chars.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-ink-700 bg-ink-850/60">
            <div className="text-center">
              <p className="text-13 text-ink-300">还没有角色可聊</p>
              <p className="mt-2 text-12 text-ink-500 leading-relaxed">
                先到「故事剧本」建一个<b className="text-ink-400">故事</b>（这个世界什么样），
                再到「角色卡片」建一张卡（它属于哪个故事）。
                <br />
                填好第 4 章「示例对话」，Ta 会立刻像那个人。建好后回到这里点「＋ 新建对话」。
              </p>
            </div>
          </div>
        ) : !session ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-ink-700">
            <div className="text-center">
              <p className="text-13 text-ink-300">还没有选择对话</p>
              <p className="mt-2 text-12 text-ink-500 leading-relaxed">
                从左栏点一场继续，或「＋ 新建对话」开一场 —— 新建时要先选一个故事，
                再从这个故事的角色里挑人（可以单角色聊，也能让两三个角色同场）。
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* 对话区 */}
            <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-ink-700 overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-700 bg-ink-850/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    {editingTitle ? (
                      <input
                        autoFocus
                        value={titleDraft}
                        placeholder="给这场对话起个名字"
                        onChange={e => setTitleDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void saveTitle() }
                          if (e.key === 'Escape') { e.preventDefault(); setEditingTitle(false) }
                        }}
                        onBlur={() => void saveTitle()}
                        className="w-56 bg-ink-900 border border-amber/50 rounded px-2 py-0.5 text-12 text-ink-100 outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        title="点击改名"
                        onClick={() => { setTitleDraft(session.title); setEditingTitle(true) }}
                        className="group flex items-center gap-1.5 max-w-full text-left"
                      >
                        <span className="truncate text-12 text-ink-100">{session.title}</span>
                        <Pencil className="w-3 h-3 shrink-0 text-ink-600 group-hover:text-amber" />
                      </button>
                    )}
                    <div className="text-10 text-ink-500 flex flex-wrap items-center gap-2">
                      {/* 场景与记忆新鲜度已收进下方「状态」一览（同一信息不写两处）；
                          这里只留它不显示的：心情（这是**当前页签角色**的心情）与整理进度。
                          心情来自**日常推进**（Ta 这几天过得怎么样），与右栏「本场数值」里的 mood 是两回事。
                          ⚠️ 注释必须写在 JSX 注释括号里：写在 JSX 子节点区的 `//` 不是注释，会被当字面文本直接渲染出来。 */}
                      {daily?.mood && <span className="text-amber/80">这几天的心情：{daily.mood}</span>}
                      {ending && (
                        <span className="text-amber">
                          {endStage ? STAGE_TEXT[endStage.stage] : '收尾中…'}
                          {endStage && endStage.total > 1 ? `（${endStage.cur}/${endStage.total}）` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* 多角色：在场者一览，点头像 = 指定下一位接话（§7.3）。
                    只列 **AI 演的**角色 —— 用户扮演的那个不是 AI 的位子，指定他接话没有意义。
                    归档只读时整块收掉：指定下一位 / 改静音与健谈度都是"为了接着聊"的准备动作。 */}
                {aiCards.length > 1 && !session.endedAt && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-10 text-ink-500 shrink-0">在场（点头像指定下一位）</span>
                    {aiCards.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSpeakNext(speakNext === c.id ? '' : c.id)
                          showToast(speakNext === c.id ? '已取消指定' : `下一位由 ${c.name} 接话`, 'info')
                        }}
                        className={`flex items-center gap-1 rounded-full pl-0.5 pr-2 py-0.5 border ${speakNext === c.id ? 'border-amber/50 bg-amber/15' : 'border-ink-700 hover:bg-ink-800/60'}`}
                      >
                        <Avatar src={c.avatar} name={c.name} size={20} />
                        <span className="text-11 text-ink-200">{c.name}</span>
                      </button>
                    ))}
                    <Button variant="secondary" size="xs"
                      onClick={() => setDirectorOpen(true)}
                      title="静音（在场但不发言）与健谈度" className="shrink-0"
                    >
                      在场调度
                    </Button>
                  </div>
                )}

                {/* Ta这几天的生活（时间差推进出来的） */}
                {showDaily && !!daily?.log?.length && (
                  <div className="mt-2 rounded-md border border-ink-700 bg-ink-900/50 px-3 py-2">
                    <p className="text-10 text-ink-500 mb-1">
                      这几天的生活（你没来时Ta自己过的 —— 界面不打开就不会推进）
                    </p>
                    <ul className="space-y-0.5">
                      {daily.log.map((l, i) => (
                        <li key={i} className="text-11 text-ink-300 leading-relaxed">
                          <span className="text-ink-500">{l.date}</span> {l.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* 🚫 2026-09-16：原「对话上方那条角色状态一览」已挪进右栏 ——
                  它横在对话上方会白吃掉一截高度，而右栏本来就有地方摆（与「本场状态」两页切换）。
                  老大原话：「放到一起，能够进行页面切换」。见右栏 `<aside>` 的 statusTab。 */}

              <div className="relative flex-1 min-h-0">
              <div ref={scrollRef} onScroll={updateAtBottom} className="absolute inset-0 overflow-y-auto p-4 space-y-4">
                {/* 很久没来时Ta留着的一句话（§7.5）：不弹通知，就放在对话里等Ta看见 */}
                {greeting && (
                  <div className="rounded-lg border border-amber/30 bg-amber/8 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-10 text-amber/80 mb-1">你很久没来了，Ta留下句话：</p>
                        {renderTavernMessage(greeting)}
                      </div>
                      <Button variant="secondary" size="xs" onClick={() => setGreeting('')} className="shrink-0">
                        收起
                      </Button>
                    </div>
                  </div>
                )}
                {session.messages.length === 0 && (
                  <div className="text-center text-12 text-ink-500 py-10">
                    还没有对话。在下面说第一句话，Ta就会应你。
                  </div>
                )}
                {session.messages.map((m, i) => {
                  const who = m.speakerId ? aiCards.find(c => c.id === m.speakerId) : undefined
                  // 头像规则：多角色同场必须挂（否则分不清谁在说）；单角色只有**设过头像**才挂
                  // （没设时挂一个名字首字的圆点，在单人对话里纯属视觉噪音）
                  const showWho = aiCards.length > 1 || !!who?.avatar
                  /**
                   * 开场白：独立的「场景引入」形态 —— 它不是任何人说的一句话，所以不占某一侧、
                   * 不挂头像、不画气泡，整块居中（与左右两种对话形成第三种视觉语言）。
                   *
                   * 🔴 它仍是 `role: 'user'`（模型靠它接戏，理由见 script.ts 的 openingToMessage），
                   *    只是**界面不再那么显示**。
                   * 🔴 工具条**只给「编辑」**：不传 onToggleHidden / onDelete —— 
                   *    「隐藏」会让它不进上下文（模型读不到开场白就不知道戏从哪儿接），
                   *    「删除」会拆掉这场戏的起点。两者对开场白都不合适。
                   */
                  if (isOpeningMessage(m, i, session.script)) {
                    return (
                      <div key={m.id} className="mx-auto w-full max-w-[92%]">
                        <div className="rounded-lg border border-ink-700 bg-ink-900/50 px-3.5 py-2.5">
                          <div className="mb-1 flex items-center gap-1.5">
                            <Clapperboard size={11} className="text-amber/70" />
                            <span className="text-10 text-amber/80">开场</span>
                          </div>
                          <TavernMessageBody
                            content={m.content} hidden={m.hidden} edited={m.edited}
                            ops={{
                              canReroll: false,
                              busy: streaming,
                              locked: !!session.endedAt,
                              onSaveEdit: t => saveEdited(m.id, t),
                            }}
                          />
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div key={m.id} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
                      {m.role !== 'user' && showWho && (
                        <Avatar src={who?.avatar} name={who?.name ?? '?'} size={24} className="mt-0.5" />
                      )}
                      {/* 两侧都不带外框（老大 2026-09-15 定）：用户那侧靠右对齐 + 头像区分，
                          加气泡框反而把同一段对话切成了两种视觉语言。 */}
                      <div className={m.role === 'user'
                        ? 'max-w-[80%] space-y-1'
                        : 'max-w-[85%] space-y-1'}>
                        {m.role !== 'user' && showWho && who && (
                          <div className="text-10 text-amber/80">{who.name}</div>
                        )}
                        <TavernMessageBody
                          content={m.content} hidden={m.hidden} edited={m.edited}
                          ops={{
                            canReroll: m.id === lastAiId && !streaming,
                            busy: streaming,
                            // 归档只读：工具条整条不渲染（reroll / 编辑 / 隐藏 / 删除都不该有）
                            locked: !!session.endedAt,
                            onReroll: () => void reroll(),
                            onSaveEdit: t => saveEdited(m.id, t),
                            onToggleHidden: () => toggleHidden(m.id),
                            onDelete: () => void removeMsg(m.id),
                            // T3 多候选：关掉开关时 variants 恒为 undefined ⇒ count=1 ⇒ 不渲染翻页
                            variantIdx: m.variantIdx,
                            variantCount: m.variants?.length,
                            onSelectVariant: idx => selectVariant(m.id, idx),
                          }}
                        />
                      </div>
                      {/* 你自己那侧：只有「我的档案」设过头像才挂 —— 没设就别占地方 */}
                      {m.role === 'user' && !!myProfile.avatar && (
                        <Avatar src={myProfile.avatar} name={myProfile.name || '我'} size={24} className="mt-0.5" />
                      )}
                    </div>
                  )
                })}
                {streaming && (
                  <div className="max-w-[85%] space-y-1">
                    {streamText ? renderTavernMessage(streamText) : (
                      <div className="text-12 text-ink-500">{phase || '正在想…'}</div>
                    )}
                  </div>
                )}
              </div>
              {!atBottom && (
                <button
                  type="button"
                  onClick={() => scrollToBottom()}
                  title="回到底部（看历史时一键回到最新消息）"
                  className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full border border-ink-600 bg-ink-800/90 px-3 py-1.5 text-11 text-ink-100 shadow-lg backdrop-blur hover:bg-ink-700" style={{ zIndex: Z.pageHandle }}
                >
                  <ChevronDown className="h-3.5 w-3.5" /> 回到底部
                </button>
              )}
              </div>

              <div className="border-t border-ink-700 p-3">
                {session.endedAt ? (
                  /* 归档后收掉整个输入区 —— 留着可打字的框，作者一定会去敲，
                     敲完发现发不出去（send 里有守卫），只会以为软件坏了。 */
                  <div className="rounded-lg border border-amber/30 bg-amber/8 px-3 py-3">
                    <p className="text-12 text-ink-200">
                      本轮已于 {agoText(session.endedAt)}结束 —— 这一场是只读归档了，记忆、日记与本场数值都已整理好。
                    </p>
                    <p className="mt-1 text-11 text-ink-500 leading-relaxed">
                      想接着往下演就新开一场：记忆与日记是跨会话共享的，Ta 不会失忆。
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="primary" size="sm" onClick={() => setSetupOpen(true)}>新开一场</Button>
                    </div>
                  </div>
                ) : (
                <>
                <TavernDirectorNoteBar
                  note={session.directorNote}
                  postApplied={postNotice.applied}
                  postErrors={postNotice.errors}
                  disabled={streaming}
                  onSave={n => void applyDirectorNote(n)}
                  onClear={() => void applyDirectorNote(null)}
                />
                <TavernQuickBar actions={quickActions} disabled={streaming || assistBusy} onFill={fillInput} className="mb-2" />
                {/* 自动延展：默认 3 行，写长了自己长高，超过 200px 才内部滚动 */}
                {/* 按键：Enter 发送、Shift+Enter 换行（与「对话引导」一致）。
                    🔴 必须挡 isComposing —— 中文输入法里 Enter 是**选字确认键**，
                    不挡的话字打到一半就被当成发送，换成 Enter 发送后这是必踩的坑。 */}
                {/* 🔴 **不再 `disabled={streaming}`**（反馈 #13 的根因）：
                    旧写法在生成期间把整个 textarea 禁掉，浏览器会**主动把焦点移走**，
                    生成结束后也没人还回来 —— 表现就是「每轮都要再点一次输入框」。
                    现在生成期照常可打字（先把下一句备好），发送按钮那侧仍会变成「停止」。 */}
                <AutoTextarea
                  className="bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
                  textClass="text-13"
                  minRows={3}
                  maxHeight={200}
                  placeholder={streaming || assistBusy
                    ? (streaming ? 'Ta 还在说 —— 你可以先把下一句打在这儿' : '正在为你生成 —— 结果会填到这儿')
                    : '说点什么…（Enter 发送，Shift+Enter 换行）'}
                  value={input}
                  inputRef={inputRef}
                  onChange={setInput}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    void send()
                  }}
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-11 text-ink-500">
                    本会话 {usedChars} 字
                    <button
                      type="button"
                      onClick={() => setUsageOpen(true)}
                      className="ml-2 text-amber/80 hover:text-amber underline decoration-dotted"
                      title="按真实组装量一遍：角色卡 / 背景设定 / 记忆各占多少，留给对话历史多少"
                    >
                      用量明细
                    </button>
                  </span>
                  <div className="flex gap-2">
                    {streaming || assistBusy
                      ? <Button variant="secondary" size="md" onClick={stop}>停止</Button>
                      /* 🔴 2026-09-22 六维审计 F1：未配模型时**直接禁用并说明原因**，
                         而不是让作者点下去才看到 toast（send 里也有一道兜底提示）。 */
                      : <Button variant="primary" size="md"
                          disabled={!input.trim() || !aiReady}
                          title={!aiReady
                            ? '还没配置可用的模型 —— 请先到「模型设置」里配好'
                            : (aiReadyLabel ? `发送（当前模型：${aiReadyLabel}）` : '发送')}
                          onClick={() => void send()}>发送</Button>}
                  </div>
                </div>
                </>
                )}
              </div>
            </div>

            {/* 右栏：角色状态 / 本场状态 两页切换（老大 2026-09-16 定 ——
                原先「对话上方那条一览」并到这里，不再单独占一条横向空间）。
                · 角色状态 = 场景 + 在场角色的关系状态与记忆计数（只读）
                · 本场状态 = 这一场的好感 / 信任 / 精神 / 心情 / 地点（改完回车生效）
                🚫 记忆不摆在这儿：它是给 AI 用的六栏档案，摆出来既不直观、又容易被改成半成品，
                   阅读与手改入口在「角色卡片」页。
                ⚠️ 整块**不再用 `castCards.length > 0` 门控** —— 卡被删或还没加载完时，
                   右栏会连「本场数值」一起消失（这正是反馈里「勾了启用却不显示」的一部分）。 */}
            <aside className="w-72 shrink-0 flex flex-col rounded-lg border border-ink-700 bg-ink-850/40 min-h-0">
              {/* 分段切换。红线：分段用 toggle + selected，不要静止无框的 ghost */}
              <div className="flex gap-1 border-b border-ink-700 p-2">
                <Button
                  variant="toggle" size="sm" className="flex-1 justify-center"
                  selected={statusTab === 'status'} onClick={() => setStatusTab('status')}
                  title="这一场的场景、在场角色的关系状态与记忆计数（只读）"
                >
                  角色状态
                </Button>
                <Button
                  variant="toggle" size="sm" className="flex-1 justify-center"
                  selected={statusTab === 'vars'} onClick={() => setStatusTab('vars')}
                  title="这一场的好感 / 信任 / 精神 / 心情 / 地点（改完回车生效）"
                >
                  本场状态
                </Button>
                <Button
                  variant="toggle" size="sm" className="flex-1 justify-center"
                  selected={statusTab === 'cp'} onClick={() => setStatusTab('cp')}
                  title="在这一场存一个检查点，之后一键回到那一刻（消息 + 角色记忆 + 本场数值一起还原）"
                >
                  检查点
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {statusTab === 'cp' ? (
                  <>
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-11 text-ink-500">检查点（{(session.checkpoints ?? []).length}）</span>
                        <Button variant="secondary" size="xs" onClick={() => saveCheckpoint()}>＋ 存一个</Button>
                      </div>
                      {(session.checkpoints ?? []).length === 0 ? (
                        <p className="mt-1 text-10 leading-relaxed text-ink-600">
                          还没有检查点。存一个之后，后面无论聊成什么样都能回到那一刻 ——
                          消息、「在场角色的记忆」与本场数值一起还原，而且可以撤销。
                        </p>
                      ) : (
                        <ul className="mt-1 space-y-1">
                          {[...(session.checkpoints ?? [])].sort((a, b) => b.at - a.at).map(cp => (
                            <li key={cp.id} className="flex items-center gap-1.5">
                              <span
                                className="min-w-0 flex-1 truncate text-11 text-ink-300"
                                title={`第 ${cp.messageCount} 条 · ${cp.memories.length} 位角色的记忆 · ${new Date(cp.at).toLocaleString()}`}
                              >
                                {cp.label || `第 ${cp.messageCount} 条`}
                              </span>
                              <Button variant="secondary" size="xs" className="shrink-0"
                                onClick={() => void rollbackToCp(cp.id)}>
                                回到这里
                              </Button>
                              <Button variant="danger" size="xs" className="shrink-0"
                                title="删掉这个检查点（不影响对话）"
                                onClick={() => dropCp(cp.id)}>
                                ×
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {session.undoSnapshot && (
                        <Button variant="secondary" size="xs" className="mt-1.5 w-full"
                          onClick={() => void undoRollbackCp()}>
                          ↩ 撤销上次回滚（{new Date(session.undoSnapshot.at).toLocaleTimeString()}）
                        </Button>
                      )}
                    </div>
                    {/* 🔴 自由模式的记忆是**角色级、跨会话共享**的 —— 回滚会动到别处，必须写在看得见的地方 */}
                    <p className="border-t border-ink-700 pt-2 text-10 leading-relaxed text-ink-600">
                      与剧情推演不同：这里的记忆按角色存、跨会话共享 ——
                      所以回滚会把这位角色在别的对话里记得的事一起退回去。
                      只想丢消息、不动记忆的话，用「重说」或删单条。
                    </p>
                  </>
                ) : statusTab === 'status' ? (
                  <>
                    <TavernStatusBar
                      model={statusModel}
                      sceneText={
                        [session.scene?.place, session.scene?.time].filter(Boolean).join(' · ')
                        // 没手填场景时用剧本的名字与情境顶上（这一场本来就有处境，不该显示"未设定"）
                        || scriptSceneLine(session.script)
                      }
                    />

                    {/* 在场的人：只列 AI 扮演的（用户演的那位不是观察对象）。
                        点一个 = 把「Ta这几天的生活 / 心情」切到这位名下。
                        只在多角色时出现 —— 单角色只有一个人可看，列出来纯属占地方。 */}
                    {aiCards.length > 1 && (
                      <div className="border-t border-ink-700 pt-2">
                        <div className="text-10 text-ink-500 mb-1">
                          AI 扮演<span className="text-ink-600">（点名字看他这几天的生活）</span>
                        </div>
                        <ul className="space-y-1">
                          {aiCards.map(c => {
                            const on = c.id === statusCharId
                            return (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onClick={() => setStatusCharId(c.id)}
                                  title={`看 ${c.name || 'Ta'} 这几天的生活`}
                                  className={`w-full flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors ${
                                    on ? 'border-amber/40 bg-amber/15' : 'border-transparent hover:bg-ink-800/60'
                                  }`}
                                >
                                  <Avatar src={c.avatar} name={c.name} size={18} />
                                  <span className={`truncate text-11 ${on ? 'text-amber' : 'text-ink-200'}`}>
                                    {c.name || '（未命名）'}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  /* 本场数值：**全项目唯一的显示与修改入口**（2026-09-16 去重 ——
                     原先中间那条状态栏里还有一份只读/可改的副本，已删）。
                     反馈 #4：多角色同场时，这里看的是「当前选中的那位」角色卡上的持久数值；
                     主角色（AI 扮演的第一个角色，见 primaryAiCharId）走会话工作副本并每轮回写卡，其余角色直接读写各自的卡。 */
                  <div className="space-y-2">
                    {aiCards.length > 1 && (
                      <div>
                        <div className="text-10 text-ink-500 mb-1">看哪位角色的数值</div>
                        <ul className="space-y-1">
                          {aiCards.map(c => {
                            const on = (varsCharId || primaryAiCharId(session)) === c.id
                            return (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onClick={() => setVarsCharId(c.id)}
                                  title={`看 ${c.name || 'Ta'} 的本卡数值`}
                                  className={`w-full flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors ${
                                    on ? 'border-amber/40 bg-amber/15' : 'border-transparent hover:bg-ink-800/60'
                                  }`}
                                >
                                  <Avatar src={c.avatar} name={c.name} size={18} />
                                  <span className={`truncate text-11 ${on ? 'text-amber' : 'text-ink-200'}`}>
                                    {c.name || '（未命名）'}
                                  </span>
                                  {c.id === primaryAiCharId(session) && <span className="ml-auto text-10 text-ink-500">主</span>}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                    {(() => {
                      const activeId = varsCharId || primaryAiCharId(session) || ''
                      const primary = activeId === primaryAiCharId(session)
                      const card = castCards.find(c => c.id === activeId) ?? null
                      const vars = primary ? session?.vars : charVarsToTavern(card?.vars)
                      const notes = (primary ? charCard?.vars?.notes : card?.vars?.notes) ?? {}
                      const setV = (k: VarKey, raw: string) => (primary ? setVar(k, raw) : setOtherVar(activeId, k, raw))
                      const setN = (k: VarKey, text: string) => (primary ? setPrimaryNote(k, text) : setOtherNote(activeId, k, text))
                      const reset = primary ? () => void resetVars() : () => resetOtherVars(activeId)
                      return (
                        <TavernVarsPanel
                          vars={vars}
                          varKeys={varKeys}
                          onSetVar={setV}
                          onSetNote={setN}
                          noteOf={k => notes[k] ?? ''}
                          onResetVars={reset}
                          readOnly={!!session?.endedAt}
                          // 🔴 W2-4c（§13 F2）：把当前卡的「进度锁」原文交给面板做一致性提示（只读，面板不改卡）
                          paceLock={card?.conduct?.paceLock ?? ''}
                        />
                      )
                    })()}
                  </div>
                )}
              </div>

              <div className="p-2 border-t border-ink-700">
                <p className="text-10 text-ink-600 leading-relaxed">
                  {statusTab === 'status'
                    ? '角色状态只读 —— 来自六栏记忆，整理入口是「结束本轮对话」；要直接改就去「角色卡片」页的记忆区。'
                    : '数值每轮回复后自动结算，也可随时手改；聊天过程中不跑整理，所以不会卡住对话。'}
                </p>
              </div>
            </aside>
          </>
        )}
      </div>

      <TavernFreeSetup open={setupOpen} onCreate={createFromDraft} onCancel={() => setSetupOpen(false)} />

      {/* 检查点命名：留空就用「第 N 条」（allowEmpty 让它能直接回车）—— F1 */}
      <PromptModal
        open={cpNaming}
        title="给这个检查点起个名字"
        label="名字（可以留空）"
        placeholder="例：表白之前 / 搬走那天"
        allowEmpty
        onSubmit={commitCheckpoint}
        onCancel={() => setCpNaming(false)}
      />

      <TavernRevisionDialog
        open={reviseOpen}
        loading={revising}
        applying={applyingRev}
        proposals={proposals}
        picked={picked}
        error={reviseError}
        onToggle={id => setPicked(prev => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })}
        onToggleAll={next => setPicked(next ? new Set(proposals.map(p => p.id)) : new Set())}
        onApply={() => void applyPicked()}
        onRetry={() => { if (session) void openRevise(session) }}
        onClose={() => setReviseOpen(false)}
      />

      {session && (
        <TavernUsageDialog
          open={usageOpen}
          onClose={() => setUsageOpen(false)}
          mode="free"
          session={session}
          chars={castCards}
        />
      )}

      {/* 收尾摘要：告诉作者这一场到底整理出了什么。
          没有它就等于「点了结束，什么也没看见」—— 人家会怀疑到底跑没跑。 */}
      <Modal
        open={!!endResult}
        onClose={() => setEndResult(null)}
        title="本轮已结束"
        width="lg"
        footer={
          <Button variant="primary" size="sm" onClick={() => setEndResult(null)}>知道了</Button>
        }
      >
        {endResult && (
          <div className="space-y-3">
            <p className="text-11 text-ink-400">
              这一场整理好了：{endResult.memories.length} 位角色的记忆已更新，对话已归档为只读。
              想接着往下演就新开一场 —— 记忆是跨会话共享的，Ta 不会失忆。
            </p>

            {endResult.varChanges.length > 0 && (
              <div>
                <div className="text-11 text-amber/80">本场数值</div>
                <ul className="mt-0.5 space-y-0.5">
                  {endResult.varChanges.map((c, i) => (
                    <li key={i} className="text-11 text-ink-300">
                      {c.label}：{String(c.from || '空')} → {String(c.to || '空')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div className="text-11 text-amber/80">写进 Ta 的日记</div>
              {Object.keys(endResult.journals).length === 0 ? (
                <p className="mt-0.5 text-11 text-ink-500">这次没有产出小结。</p>
              ) : (
                <ul className="mt-0.5 space-y-2">
                  {castCards.filter(c => endResult.journals[c.id]).map(c => (
                    <li key={c.id}>
                      <div className="text-11 text-ink-200">{c.name || '（未命名）'}</div>
                      <div className="text-11 text-ink-300 whitespace-pre-wrap leading-relaxed">
                        {endResult.journals[c.id]}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-10 text-ink-600">
                日记只给作者回顾用，不会注进以后的对话；完整内容在「角色卡片」页底部。
              </p>
            </div>
          </div>
        )}
      </Modal>

      {session && (
        <TavernExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          docTitle={session.title}
          kindLabel="对话记录"
          messageCount={session.messages.filter(m => m.role !== 'system').length}
          hiddenCount={session.messages.filter(m => m.hidden).length}
          build={o => freeDocModel(session, {
            ...o,
            nameOf,
            speakerOf: exportSpeakerOf,
            userLabel: (session.userCharId && nameOf(session.userCharId)) || '你',
          })}
        />
      )}

      <TavernCastDirector
        open={directorOpen}
        rows={directorRows}
        muted={session?.muted ?? []}
        talkativity={session?.talkativity ?? {}}
        showNext={aiCards.length > 1}
        nextId={speakNext}
        onPickNext={id => {
          setSpeakNext(speakNext === id ? '' : id)
          const hit = aiCards.find(c => c.id === id)
          showToast(speakNext === id ? '已取消指定' : '下一位由 ' + (hit?.name ?? '该角色') + ' 接话', 'info')
        }}
        onToggleMute={(id, next) => { if (session) void applyDirection(store.setMuted(session, id, next)) }}
        onSetTalkativity={(id, v) => { if (session) void applyDirection(store.setTalkativity(session, id, v)) }}
        onClose={() => setDirectorOpen(false)}
        note="只影响这一场的发言安排：不改角色卡，也不删记忆 —— 静音的人依然算在场，只是这一轮不发言。"
      />
    </div>
  )
}

