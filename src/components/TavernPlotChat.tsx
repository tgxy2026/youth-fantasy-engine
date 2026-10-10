/**
 * 剧情推演 · **中栏对话区**（从 `TavernPlot.tsx` 拆出来的，2026-09-19 D4-3）。
 *
 * 消息列表 / 流式气泡 / 回到底部 / 导演指令条 / 快捷指令条 / 输入区 / 字数与用量入口 —— 一整块搬进来，
 * props 名与原局部变量**同名** ⇒ 内部 JSX 一个字未改。
 *
 * ⚠️ **滚动位置（`scrollRef` / `atBottom` / 贴底跟随 effect）留在主文件**，作为 props 传进来。
 *   原因：贴底跟随即「消息变化时把视口拉到底」，与主文件的会话切换、流式 token 累加是同一拍；
 *   搬进子组件会让它的 effect 提前到父组件 effect 之前执行（React 子先父后），属于无谓的时序改动。
 *   拆分轮宁可多传 4 个 props，也不动执行时序。
 */
import { useRef, type RefObject } from 'react'
import { Z } from '@/lib/zLayer'
import { Button } from '@/components/Button'
import Avatar from '@/components/Avatar'
import TavernMessageBody from '@/components/TavernMessageBody'
import TavernQuickBar, { type QuickAction } from '@/components/TavernQuickBar'
import TavernDirectorNoteBar from '@/components/TavernDirectorNoteBar'
import { renderTavernMessage } from '@/components/TavernMessage'
import AutoTextarea from '@/components/AutoTextarea'
import { MEMORY_SOFT_LIMIT, type TavernSession, type TavernDirectorNote } from '@/lib/tavern/types'
import type { PostApplied } from '@/lib/tavern/postRules'
import type { splitCast } from '@/lib/tavern/engine'

// ⚠️ 对话区的 JSX 是从原文件**逐行搬**过来的，缩进保留原样（12 空格），别重排。

/** 中栏：对话区（消息 + 流式 + 输入） */
export function PlotChat({
  session, casts, castNameOf, lastAiId, streaming, streamText, phase, postNotice,
  input, setInput, dialogChars, scrollRef, atBottom, updateAtBottom, scrollToBottom,
  reroll, saveEdited, toggleHidden, removeMsg, branchAt, selectVariant, applyDirectorNote, send, stop, setUsageOpen,
}: {
  session: TavernSession
  casts: ReturnType<typeof splitCast>
  castNameOf: (id?: string) => string
  /** 只有**末尾那条 AI 回复**能重说（中间那条改了，后面是按旧版接的） */
  lastAiId: string
  streaming: boolean
  streamText: string
  phase: string
  postNotice: { applied: PostApplied[]; errors: string[] }
  input: string
  setInput: (v: string) => void
  dialogChars: number
  scrollRef: RefObject<HTMLDivElement>
  atBottom: boolean
  updateAtBottom: () => void
  scrollToBottom: (smooth?: boolean) => void
  reroll: () => void | Promise<void>
  saveEdited: (id: string, text: string) => void
  toggleHidden: (id: string) => void
  removeMsg: (id: string) => void | Promise<void>
  branchAt: (messageId: string) => void | Promise<void>
  /** T3 多候选：选中某条消息的某个候选（切换后 content 跟着变） */
  selectVariant: (id: string, idx: number) => void
  applyDirectorNote: (note: TavernDirectorNote | null) => void | Promise<void>
  send: (preset?: string) => void | Promise<void>
  stop: () => void
  setUsageOpen: (open: boolean) => void
}) {
  const quickActions: QuickAction[] = [
    { key: 'cont', label: '继续', hint: '让 AI 顺着往下演一轮', text: '「继续，不必解释。」' },
    { key: 'turn', label: '换个方向', hint: '这一轮换一种走向，不要重复刚才的写法', text: '「换一个方向演这一轮，不要重复刚才的走向。」' },
    { key: 'env', label: '补环境', hint: '先补一句（ ）里的环境（光、声、气味），再接着说', text: '「先说一句（ ）里的环境（光、声、气味），再继续。」' },
    { key: 'time', label: '推进时间', hint: '把时间往前推 —— 填进输入框后自己改成需要的时长', text: '「把时间往前推进 半小时，然后继续。」', slot: '半小时' },
    { key: 'wind', label: '收束本场', hint: '给这一幕一个可以停下的落点', text: '「把这一幕收一收，落到一个可以停下的地方。」' },
    { key: 'mind', label: 'Ta 在想什么', hint: '用一个动作或细节透出心里的想法，不直接写心理', text: '「用一个动作或细节写出 Ta 此刻心里在想什么，不要直接写心理。」' },
    { key: 'reroll', label: '重说', hint: '用同一段历史让 AI 重说这一条（只出一个结果）', run: () => void reroll() },
  ]

  /** 输入框 ref：预填后要聚焦并把「该改的那一段」选中 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * 快捷指令预填：把预制文本填进输入框、聚焦，并把该改的那段选中（不发送）。
   * ⚠️ 选区要等 React 把新值渲染进 textarea 之后再设 —— 同步 setState 后立刻设会选到旧值。
   */
  const fillInput = (text: string, slot?: string) => {
    setInput(text)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const i = slot ? text.indexOf(slot) : -1
      if (i >= 0) el.setSelectionRange(i, i + slot!.length)
      else el.setSelectionRange(text.length, text.length)
    })
  }

  return (
          <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-ink-700 overflow-hidden">
            <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} onScroll={updateAtBottom} className="absolute inset-0 overflow-y-auto p-4 space-y-4">
              {session.messages.length === 0 && (
                <div className="text-center text-12 text-ink-500 py-10">
                  还没有对话。在下面输入你的第一句话开演。
                </div>
              )}
              {session.messages.map(m => (
                <div key={m.id} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
                  {/* 头像规则与自由对话一致：多角色同场必须挂，否则分不清谁在说。
                      ⚠️ 剧情模式的角色是**项目角色卡**（CardRecord 没有头像字段），所以这里
                      只会渲染出「名字首字」圆标 —— 角色卡有了头像列之后把 src 接上即可。 */}
                  {m.role !== 'user' && casts.ai.length > 1 && (
                    <Avatar name={castNameOf(m.speakerId) || '?'} size={24} className="mt-0.5" />
                  )}
                  {/* 两侧都不带外框（老大 2026-09-15 定）：用户那侧靠右对齐 + 头像区分。 */}
                  <div className={m.role === 'user'
                    ? 'max-w-[80%] space-y-1'
                    : 'max-w-[85%] space-y-1'}>
                    {m.role !== 'user' && casts.ai.length > 1 && m.speakerId && (
                      <div className="text-11 text-amber">{castNameOf(m.speakerId)}</div>
                    )}
                    <TavernMessageBody
                      content={m.content} hidden={m.hidden} edited={m.edited}
                      ops={{
                        canReroll: m.id === lastAiId && !streaming,
                        busy: streaming,
                        onReroll: () => void reroll(),
                        onSaveEdit: t => saveEdited(m.id, t),
                        onToggleHidden: () => toggleHidden(m.id),
                        onDelete: () => void removeMsg(m.id),
                        onBranch: () => void branchAt(m.id),
                        // T3 多候选：关掉开关时 variants 恒为 undefined ⇒ count=1 ⇒ 不渲染翻页
                        variantIdx: m.variantIdx,
                        variantCount: m.variants?.length,
                        onSelectVariant: idx => selectVariant(m.id, idx),
                      }}
                    />
                  </div>
                </div>
              ))}
              {streaming && (
                <div className="max-w-[85%] space-y-1">
                  {streamText
                    ? renderTavernMessage(streamText)
                    : <div className="text-12 text-ink-500">{phase || '正在生成…'}</div>}
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
                ↓ 回到底部
              </button>
            )}
            </div>

            {/* 输入区 */}
            <div className="border-t border-ink-700 p-3">
              <TavernDirectorNoteBar
                note={session.directorNote}
                postApplied={postNotice.applied}
                postErrors={postNotice.errors}
                disabled={streaming}
                onSave={n => void applyDirectorNote(n)}
                onClear={() => void applyDirectorNote(null)}
              />
              <TavernQuickBar actions={quickActions} disabled={streaming} onFill={fillInput} className="mb-2" />
              <AutoTextarea
                className="bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-13"
                minRows={3}
                maxHeight={200}
                placeholder={casts.user.length
                  ? '以你的角色身份说一句话、做一个动作…（Enter 发送，Shift+Enter 换行）'
                  : '这一场没有你演的角色 —— 可以以旁白或任意角色的身份推进…（Enter 发送，Shift+Enter 换行）'}
                value={input}
                disabled={streaming}
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
                  对话消息 {dialogChars} 字
                  {session.memory ? ` · 记忆 ${session.memory.length}/${MEMORY_SOFT_LIMIT} 字` : ''}
                  <button
                    type="button"
                    onClick={() => setUsageOpen(true)}
                    className="ml-2 text-amber/80 hover:text-amber underline decoration-dotted"
                    title="按真实组装量一遍：协议 / 设定层 / 背景设定 / 记忆各占多少，留给对话历史多少"
                  >
                    用量明细
                  </button>
                </span>
                <div className="flex gap-2">
                  {streaming
                    ? <Button variant="secondary" size="md" onClick={stop}>停止</Button>
                    : <Button variant="primary" size="md" disabled={!input.trim()} onClick={() => void send()}>发送</Button>}
                </div>
              </div>
            </div>
          </div>
  )
}
