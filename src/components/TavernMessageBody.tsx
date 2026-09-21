/**
 * 酒馆模式 · 消息体 + 消息级操作（重说 / 编辑 / 隐藏 / 删除）
 *
 * 剧情推演与自由对话共用这一个组件。两页的气泡外壳不同（头像、说话人名、左右对齐），
 * 但**正文渲染与工具条必须完全一致** —— 各写一份必然慢慢漂移，这是本项目的反复教训。
 *
 * 【五个动作的语义，别搞混】
 *   · 重说：用**同一段历史**让 AI 再生成一次（只出一个结果，不做多候选）。
 *     ★ 只给**末尾那条 AI 回复**提供入口 —— 重说中间某条，后面的内容是按旧版接的，
 *       改了必然互相打架；中间想改就用「编辑」。
 *   · 编辑：就地改正文（AI 的和自己的都能改）。改完**不会自动重跑** ——
 *     如果是最后一轮的输入，改完点「重说」让 AI 重新接一次。
 *   · 隐藏：**不进上下文**（组装时跳过），但界面留着、可随时恢复。
 *   · 分支：**另开一场**推演、只保留到这一条（原推演原封不动）—— 从这里换个走向试试。
 *     只有剧情推演页传 `onBranch`；自由对话不传，按钮就不出现。
 *   · 删除：从历史里移走（不可撤销，调用方负责二次确认）。
 *
 * ⚠️ 外层 `div.group/msg` **必须恒定存在**（编辑态也不能换掉它），且正文始终在**同一个分支**里渲染：
 *   自动化测试按行号定位这一行（`div[class*="group/msg"]`），换掉它行号就错位 —— 踩过一次。
 */
import { useState } from 'react'
import { renderTavernMessage } from './TavernMessage'
import AutoTextarea from './AutoTextarea'
import { Button } from './Button'

export type MessageOps = {
  /** 能不能重说（= 是不是末尾那条 AI 回复，且当前没在生成） */
  canReroll: boolean
  busy: boolean
  onReroll: () => void
  onSaveEdit: (text: string) => void
  onToggleHidden: () => void
  onDelete: () => void
  /** 从这一条分支（不传 = 这个页面没有分支功能，按钮不渲染） */
  onBranch?: () => void
  /**
   * 🔴 整条工具条锁住（自由对话「结束本轮对话」归档之后）。
   *    为什么不是「把按钮 disabled」：归档之后**这些操作根本不存在**，
   *    灰着还挂在 hover 里，作者会以为"多点点也许能通"。直接不渲染最不容易误解。
   */
  locked?: boolean
}

export function TavernMessageBody({ content, hidden, edited, ops }: {
  content: string
  hidden?: boolean
  edited?: boolean
  ops: MessageOps
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(content)

  return (
    <div className="group/msg">
      {editing ? (
        <div className="space-y-2">
          <AutoTextarea
            className="bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
            textClass="text-12"
            minRows={3}
            maxHeight={260}
            value={text}
            onChange={setText}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => { setEditing(false); setText(content) }}>取消</Button>
            <Button
              variant="primary" size="sm" disabled={!text.trim()}
              onClick={() => { ops.onSaveEdit(text.trim()); setEditing(false) }}
            >
              保存
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={hidden ? 'opacity-45' : ''}>{renderTavernMessage(content)}</div>

          {(hidden || edited) && (
            <div className="mt-0.5 text-10 text-ink-600">
              {hidden ? '已隐藏 · 不进上下文' : ''}
              {hidden && edited ? ' · ' : ''}
              {edited ? '改过' : ''}
            </div>
          )}

          {/* 工具条：hover 才出现（触屏上 hover 表现为点按后保留）。
              归档只读（ops.locked）时**整条不渲染** —— 理由见 MessageOps.locked。 */}
          {!ops.locked && (
          <div className="mt-1 flex flex-wrap items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
            {ops.canReroll && (
              <Button
                variant="secondary" size="xs" disabled={ops.busy}
                title="用同一段历史让 AI 重说这一条（只出一个结果）"
                onClick={ops.onReroll}
              >
                重说
              </Button>
            )}
            <Button
              variant="secondary" size="xs" disabled={ops.busy}
              title="改这条的正文；改完不会自动重跑 —— 若是最后一轮的输入，可以再点「重说」"
              onClick={() => { setText(content); setEditing(true) }}
            >
              编辑
            </Button>
            <Button
              variant="secondary" size="xs" disabled={ops.busy}
              title={hidden ? '恢复这条，让它重新参与上下文' : '这条先不让 AI 看见（界面仍留着）'}
              onClick={ops.onToggleHidden}
            >
              {hidden ? '取消隐藏' : '隐藏'}
            </Button>
            {ops.onBranch && (
              <Button
                variant="secondary" size="xs" disabled={ops.busy}
                title="从这一条另开一场推演（只保留到这里，原推演不动）—— 用来试另一个走向"
                onClick={ops.onBranch}
              >
                分支
              </Button>
            )}
            <Button
              variant="secondary" size="xs" disabled={ops.busy}
              title="从这场的记录里删掉（不可撤销）"
              onClick={ops.onDelete}
            >
              删除
            </Button>
          </div>
          )}
        </>
      )}
    </div>
  )
}

export default TavernMessageBody
