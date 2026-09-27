/**
 * 酒馆模式 · 角色卡片（tavern-card）
 *
 * 自由模式的角色卡管理：四章模板（世界 / 人物档案 / 行为规范 / 示例对话），分区块表单编辑。
 *
 * 【为什么是「分区块表单」而不是一个大文本框】
 * 四章是给模型的**不同层**用的：第 2 章管「Ta是谁」、第 3 章管「怎么演」、
 * 第 4 章管「照着这个说话」。合成一坨，作者一定会漏掉最关键的第四章。
 *
 * 【第 4 章「示例对话」是杠杆最高、也最容易被跳过的一章】
 * 手册实测：模型会**直接吸收**示例里的应对话术与格式。所以它在这一页拿到的是
 * 醒目位置（amber 边框）+ 三条硬规矩（踩过坑的），而不是和别的字段一样一个普通输入框：
 *   ① 格式必须与期望输出完全一致 —— 示例里写「角色名：台词」，正式输出就会照做
 *      （曾因此把人称带偏成第三人称）。**只给对方加标记（用输入侧符号 〖对方〗，不占输出字母表），角色那一侧不加任何前缀。**
 *   ② 三段覆盖不同侧面（常态 / 应激 / 松动），别都是同一情绪
 *   ③ 别写长 —— 三段短来回足够，写成整段剧情既费上下文又容易被照搬
 *
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），
 * 提示用 showToast。
 *
 * 阶段：本页是 P2 范围（CRUD + 表单）。「从小说角色 AI 转换」与「导入导出 JSON」属 P3，
 * 页面上留了入口但**明确置灰并说明**，不假装能用。
 *
 * ⚠️ 2026-09-19 D4-4 拆分之后，**本文件只负责装配**：
 *   状态与全部动作在 `useTavernCardModel.ts`；卡面四块在 `TavernCardBasics` /
 *   `TavernCardChapters` / `TavernCardMemoryPanel` / `TavernCardJournalPanel`；
 *   「从小说角色导入」弹窗在 `TavernCardNovelImportDialog.tsx`。
 */

import HelpPopover from './HelpPopover'
import { UNSAVED_CHANGES_HINT } from '../lib/constants'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import { Modal } from './Modal'
import { LoadingState } from './LoadingState'
import { storyDisplayName } from '../lib/tavern/story'
import { cardStoryId } from '../lib/tavern/types'
import { interviewToCard } from '../lib/tavern/interview'
import TavernCardList from './TavernCardList'
import TavernCardDraftDialog from './TavernCardDraftDialog'
import TavernInterviewDialog from './TavernInterviewDialog'
import TavernCardBasics from './TavernCardBasics'
import TavernCardChapters from './TavernCardChapters'
import TavernCardMemoryPanel from './TavernCardMemoryPanel'
import TavernCardJournalPanel from './TavernCardJournalPanel'
import TavernCardNovelImportDialog from './TavernCardNovelImportDialog'
import { useTavernCardModel } from './useTavernCardModel'

export default function TavernCard() {
  const {
    // 页级 / 左栏
    loading, list, stories, draft, openIds, setOpenIds, gaps, setGaps, dirty,
    open, openCreatePicker, setAiDraftOpen, setInterviewOpen, openNovelPicker,
    fileRef, exportCard, exportAll, importCards,
    pickOpen, setPickOpen, pickStoryId, setPickStoryId, confirmCreate,
    aiDraftOpen, interviewOpen, flattenCard, applyCardDraft,
    duplicate, remove, save, saving,
    // 卡面 · 基本 + 四章
    up, setDraft, setDirty, changeStory, sameNameOthers,
    // 卡面 · Ta 的记忆 / Ta 的日记
    mem, setMem, memDirty, setMemDirty, showMem, setShowMem, softLimit,
    savingMem, seedingMem, genMemory, saveMem, clearMem,
    journal, showJournal, setShowJournal, clearJournal, dropJournal,
    // 从小说角色导入弹窗
    importOpen, setImportOpen, novelChars, nq, setNq, ntab, setNtab, converting, convert,
  } = useTavernCardModel()

  /**
   * 「复制为新卡 / 删除 / 保存」——卡面顶部（头像右侧）与编辑区底部**各放一份**
   * （老大 2026-09-16 反馈 #9：这张卡很长，这三个按钮原先只挂在最底部，
   *  改完一处得一路滚到底才存得上，来回很别扭）。
   *
   * 🔴 抽成**一个变量渲染两处**，而不是复制两段 JSX：
   *    ① 复制逻辑最容易出现「同一个动作、两个按钮行为不一致」；
   *    ② 两处必须共享同一份状态 —— `dirty`（没改动时一起变灰）与 `saving`（保存中一起变「保存中…」）。
   */
  const actionButtons = (
    <>
      <Button
        variant="secondary" size="sm" onClick={() => void duplicate()}
        title="四章照抄一份新卡，可在它基础上改；记忆与日常状态不复制"
      >
        复制为新卡
      </Button>
      <Button variant="danger" size="sm" onClick={remove}>删除</Button>
      <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </>
  )

  return (
    /* 固定头部 + 下方独立滚动区：滚动只发生在标题条**下面**，
       内容不会再滑到条子后面被半透明条盖住（原先 sticky + bg-ink-900/95 的观感问题）。 */
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-ink-800 pb-3">
        <div className="flex items-center gap-1.5">

          <h1 className="text-xl font-bold text-ink-50">角色卡片</h1>

          <HelpPopover title="角色卡片怎么填" width="24rem" size={14}>
  一张卡 = AI 的「人设说明书」：写得越具体，演得越像。四章模板：

  · 归属故事：决定这张卡用哪一套世界观 —— 世界设定写在「故事剧本」页的故事里，这里不再重复。
  · 第 1 章 角色与设定的关系：不写世界本身（世界观在「故事剧本」的故事里），只写身份、处境、常去的地方。
  · 第 2 章 人物档案 / 第 3 章 行为规范：都是按小项分条填的表格（如「外貌：短发」一行一项），
    模板没覆盖到的写进该栏的「其他」。不确定怎么填就先看每格的灰字例句。
  · 第 4 章 示例对话：AI 会照着它的格式与语气模仿，所以按输出规范写（对白不带名字、除对白外一律套（ ））。

  两种起手方式（右上「AI 起草 / 对话引导」）：已经想清楚了 → 一句话补全；只有点感觉、说不清 → 对话引导，
  让 AI 按上面的模板一轮轮问你，边聊边成形。
  卡片是全局的（跨项目、换书照样在），也能导出成文件发给别人。
  <AIDataSourceNote feature="tavern-card-draft" />
</HelpPopover>

        </div>
        <p className="text-12 text-ink-400 mt-1">
          自由模式的角色卡片：四章模板 + 归属故事（世界观在故事里，不用重复写）。
          左栏按故事分组，「未归属」抽屉存放暂时不属于任何故事的卡。
        </p>

      </header>

      {loading ? <div className="min-h-0 flex-1 overflow-y-auto pt-3"><LoadingState /></div> : (
        <div className="min-h-0 flex-1 overflow-y-auto pt-3">
        <div className="flex gap-4 min-h-0">
          {/* 左：角色列表（已抽成独立组件，见 TavernCardList.tsx） */}
          <TavernCardList
            list={list}
            stories={stories}
            draft={draft}
            openIds={openIds}
            setOpenIds={setOpenIds}
            onOpenCard={open}
            onNewCard={openCreatePicker}
            onAiDraft={() => setAiDraftOpen(true)}
            onInterview={() => setInterviewOpen(true)}
            onImportNovel={() => void openNovelPicker()}
            fileRef={fileRef}
            onExportCard={exportCard}
            onExportAll={() => void exportAll()}
            onImportCards={p => void importCards(p)}
          />

          {/* 右：编辑区 */}
          <div className="flex-1 min-w-0">
            {!draft ? (
              <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-12 text-center">
                <p className="text-13 text-ink-300">选一张角色卡开始编辑</p>
                <p className="mt-2 text-12 text-ink-500 leading-relaxed">
                  四章模板里，<span className="text-amber">第 4 章「示例对话」最影响演出效果</span> ——
                  模型会直接照着你给的示例说话。
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-4 space-y-6">
                {/* 草稿待补提示（AI 转换/导入后必须让作者看见） */}
                {gaps.length > 0 && (
                  <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-11 text-ink-300 leading-relaxed">
                        <span className="text-amber/90">这张卡有 {gaps.length} 处还需要你补：</span>
                        {gaps.join('、')}
                        {gaps.some(g => g.includes('示例对话')) && '（示例对话通常是模型编的，最该改）'}
                      </p>
                      <Button variant="secondary" size="xs" onClick={() => setGaps([])} className="shrink-0">
                        知道了
                      </Button>
                    </div>
                  </div>
                )}

                {/* 未归属提示（审计 P1-4）：导入 / AI 转换进来的卡 storyId 是空的。
                    旧流程里作者只会看到左栏多一张卡，根本不知道"还要归类" ——
                    而没归属的卡在「新建对话」的角色列表里根本选不到（角色按故事过滤），
                    表现就是「这张卡怎么不出现」，却看不出原因。 */}
                {!cardStoryId(draft) && stories.length > 0 && (
                  <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2">
                    <p className="text-11 text-ink-300 leading-relaxed">
                      <span className="text-amber/90">这张卡还没有归属故事</span> —— 没有归属，
                      对话时拿不到世界观，也不会出现在「新建对话」的角色列表里。
                      在下面「归属故事」里选一个，它就能用了。
                    </p>
                  </div>
                )}

                <TavernCardBasics
                  draft={draft} up={up} setDirty={setDirty}
                  stories={stories} changeStory={changeStory} sameNameOthers={sameNameOthers}
                  actionButtons={actionButtons}
                />

                <TavernCardChapters draft={draft} up={up} setDraft={setDraft} setDirty={setDirty} />

                <TavernCardMemoryPanel
                  mem={mem} setMem={setMem} memDirty={memDirty} setMemDirty={setMemDirty}
                  showMem={showMem} setShowMem={setShowMem} softLimit={softLimit}
                  savingMem={savingMem} seedingMem={seedingMem}
                  genMemory={genMemory} saveMem={saveMem} clearMem={clearMem}
                />

                <TavernCardJournalPanel
                  journal={journal} showJournal={showJournal} setShowJournal={setShowJournal}
                  clearJournal={clearJournal} dropJournal={dropJournal}
                />

                {/* 操作 */}
                <div className="flex items-center justify-between border-t border-ink-800 pt-3">
                  <span className="text-11 text-ink-500">
                    {dirty ? UNSAVED_CHANGES_HINT : `上次保存：${new Date(draft.updatedAt).toLocaleString('zh-CN')}`}
                  </span>
                  {/* 与卡面顶部那组是**同一份 JSX**（`actionButtons`）—— 两处按钮不可能走样 */}
                  <div className="flex gap-2">{actionButtons}</div>
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
      )}

      <TavernCardNovelImportDialog
        importOpen={importOpen} setImportOpen={setImportOpen}
        novelChars={novelChars} nq={nq} setNq={setNq} ntab={ntab} setNtab={setNtab}
        converting={converting} convert={convert}
      />

      {/* 新建角色卡第一步：选归属故事。为什么不在卡里填完再回头补 —— 没归属的卡对话时是悬空的 */}
      <Modal open={pickOpen} onClose={() => setPickOpen(false)} title="这张卡属于哪个故事？" width="md">
        <div className="space-y-3">
          <p className="text-12 text-ink-300 leading-relaxed">
            故事决定「这个世界什么样」；角色卡只写角色自己。选一个故事之后，这张卡对话时就用它的世界观。
          </p>
          <select
            className="w-full bg-ink-900 border border-ink-700 rounded-md px-2.5 py-2 text-12 text-ink-100 outline-none focus:border-amber/50"
            value={pickStoryId}
            onChange={e => setPickStoryId(e.target.value)}
          >
            {stories.map(s => <option key={s.id} value={s.id}>{storyDisplayName(s)}</option>)}
          </select>
          <p className="text-11 text-ink-500 leading-relaxed">
            想在另一个世界里用同一个角色 —— 复制这张卡再改归属就行，两张卡的记忆互不干扰。
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setPickOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" onClick={() => void confirmCreate()}>创建角色卡</Button>
          </div>
        </div>
      </Modal>

      <TavernCardDraftDialog
        open={aiDraftOpen}
        {...(draft ? { existing: flattenCard(draft) } : {})}
        onClose={() => setAiDraftOpen(false)}
        onApply={(fields, source) => applyCardDraft(fields, source.label)}
      />

      <TavernInterviewDialog
        open={interviewOpen}
        kind="card"
        subject="角色卡"
        {...(draft ? { existing: flattenCard(draft) } : {})}
        onClose={() => setInterviewOpen(false)}
        onApply={filled => applyCardDraft(interviewToCard(filled), '对话引导')}
      />
    </div>
  )
}
