/**
 * 酒馆 · 故事剧本 —— **右栏**（AI 起草 / 注入情况 / 注入预览）
 *
 * 【为什么单独拆出来（3.0 · W3-3 · §11.1 L5 收尾）】
 * `TavernScript.tsx` 抽走左栏（`TavernScriptTree`）与中栏（`TavernScriptEditor`）后，
 * 右栏是本文件里**最后一块**成规模的分区（原 457–659 行，约 203 行）。
 *
 * 量化依据（`dep-cost.mjs`，先量化再下刀）：
 *   右栏整体 props 面 = 15~20 项，看着比左栏宽，但**全是只读数据 + 回调**，
 *   没有任何「写存储 / 业务规则」逻辑 —— 数据流是单向的（父 → 右栏）。
 *   故抽取方式是「**受控展示组件**」：父级持有全部状态与动作，右栏只负责渲染与转发。
 *
 * 🔴 为什么现在才拆：§11.1 L5 原要求「与 #11 跑团对酒馆页的扩展一起规划」。
 *    3.0 中跑团（W4-3）已落成独立页签 `components/tavern/RunPanel.tsx`，
 *    **并未改动本右栏的 props 面**（跑团用的是 `lib/run/*` 与自己的面板），
 *    ⇒ 原先「先拆会白拆」的顾虑已消除，此时拆分是安全的收尾动作。
 */
import AutoTextarea from '@/components/common/AutoTextarea'
import { Button } from '@/components/common/Button'
import { RefsField, SearchPlanLine, DraftSourceLine } from '@/components/editor/DraftBits'
import { buildStoryWorldBook } from '@/lib/tavern/story'
import { SCRIPT_MAX_CHARS, isEmptyScriptFields, isEmptySnapshot, snapshotOf, scriptToText, firstLine } from '@/lib/tavern/script'
import { fmtWindow } from '@/lib/tavern/quotas'
import type { TavernQuota } from '@/components/tavern/useTavernQuota'
import type { DraftSource } from '@/lib/tavern/draft'
import type { ScriptDraftFields } from '@/lib/tavern/script'
import type { StoryDraftFields } from '@/lib/tavern/story'
import type { TavernScript, TavernScriptIndexItem, TavernStory } from '@/lib/tavern/types'
import type { SearchSettings } from '@/lib/ai/webSearch'

export interface TavernScriptAsideProps {
  /** 中间面板在编辑谁：故事 / 剧本 / 谁都没选 */
  kind: 'story' | 'script' | null
  story: TavernStory | null
  cur: TavernScript | null
  /** 故事两栏草稿（给起草当输入） */
  storyFields: StoryDraftFields
  /** 剧本六栏草稿 */
  fields: ScriptDraftFields
  /** 索引列表（统计旗下剧本数用） */
  scripts: TavernScriptIndexItem[]
  /** 当前故事挂的角色卡张数 */
  storyCharCount: number
  /** 额度视图（`useTavernQuota` 的返回值） */
  quota: TavernQuota
  /** 检索设置（有则参与起草） */
  search: SearchSettings | null
  /** 起草中 */
  drafting: boolean
  /** AI 起草的一句话想法 */
  seed: string
  setSeed: (v: string) => void
  /** 参考素材 */
  refs: string
  setRefs: (v: string) => void
  /** 上次起草实际用的素材来源 */
  lastSource: DraftSource | null
  onOpenInterview: () => void
  runStoryDraft: () => void
  runDraft: () => void
}

export default function TavernScriptAside({
  kind, story, cur, storyFields, fields, scripts, storyCharCount, quota, search,
  drafting, seed, setSeed, refs, setRefs, lastSource, onOpenInterview, runStoryDraft, runDraft,
}: TavernScriptAsideProps) {
  /** 注入预览（情境 / 你的位置 / 目标 / 不要发生 —— 开场白不进这里） */
  const preview = cur ? scriptToText(snapshotOf({ ...cur, id: cur.id || 'preview' })) : ''

  return (
    <aside className="w-72 shrink-0 space-y-3 overflow-y-auto">
      {kind === 'story' && story ? (
        <>
          <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
            <div className="text-12 text-amber">AI 起草世界设定</div>
            <p className="mt-1 text-10 text-ink-400 leading-relaxed">
              写一句这个世界大概什么样，AI 补全名称与设定。已有内容一并交给它做「补完」——
              它写不出来就不会动你写的部分，生成后请照例审一遍。
            </p>
            <div className="mt-2">
              <div className="text-11 text-ink-400">一句话想法</div>
              <AutoTextarea
                value={seed}
                onChange={setSeed}
                minRows={3}
                maxHeight={200}
                placeholder="例：现代都市但有低阶术法，术士受牌照管制，普通人不知道灵脉存在。江湖与官面井水不犯河水。"
              />
            </div>
            <div className="mt-2">
              <RefsField value={refs} onChange={setRefs} />
            </div>
            <div className="mt-1.5">
              <SearchPlanLine settings={search} />
            </div>
            <Button
              variant="primary" size="md" className="mt-2 w-full"
              disabled={drafting || (!seed.trim() && !refs.trim() && !storyFields.name && !storyFields.setting.trim())}
              onClick={runStoryDraft}
            >
              {drafting ? '正在生成…' : '一键起草（缺的补上）'}
            </Button>
            <div className="mt-1.5">
              <Button variant="secondary" size="md" className="w-full" onClick={onOpenInterview}>
                对话引导（边聊边写）
              </Button>
            </div>
            <DraftSourceLine source={lastSource} />
            {story.draftedAt ? (
              <p className="mt-1.5 text-10 text-ink-500">
                上次生成：{new Date(story.draftedAt).toLocaleString()}
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
            <div className="text-12 text-ink-200">注入情况</div>
            {(() => {
              // 🔴 两种形态分开算（2026-10-05）：
              //   · 没有词条 ⇒ 整段世界设定退化成一个常驻词条，受**固定额度**约束（这里是"全量注入"）
              //   · 有词条   ⇒ 逐条按触发词命中，受**动态额度**约束、超了逐条取舍
              const hasEntries = (story.entries ?? []).length > 0
              const settingChars = story.setting.trim().length
              const cap = hasEntries ? quota.dynamic : quota.fixed
              // 「本轮最少注入」= 空上下文下必带的那些（常驻词条 / 整段设定）
              // 🔴 两个 0 都是「不限额、原样返回」（见 worldBook.renderEntries 的 `max <= 0` 分支）——
              //    这一行的语义是「空上下文下**必带的那些**的完整长度」。
              //    漏传 `fixedMaxChars` 会让固定层回落到 2400 而把整段设定截断，
              //    于是 `over` 恒为 false、「超额度」告警永不出现（2026-10-05 实机 audit-q D2 抓到）。
              const minChars = buildStoryWorldBook(
                hasEntries ? { setting: '', entries: story.entries } : { setting: story.setting },
                '', { maxChars: 0, fixedMaxChars: 0 },
              ).text.length
              const over = minChars > cap
              return (
                <div className="mt-1.5 space-y-1 text-11 text-ink-400">
                  <div>
                    {hasEntries ? '词条写下来共 ' : '世界设定 '}
                    <span className="text-ink-200">{(story.entries ?? []).reduce((n, x) => n + (x.body ?? '').length + (x.title ?? '').length, 0) || settingChars}</span> 字
                  </div>
                  <div>
                    每轮最少注入 <span className={over ? 'text-amber' : 'text-ink-200'}>{minChars}</span> 字
                    <span className="text-ink-600"> / {hasEntries ? `动态额度 ${quota.dynamic}` : `固定额度 ${quota.fixed}`}</span>
                  </div>
                  {over && (
                    <div className="text-amber leading-relaxed">
                      {hasEntries
                        ? `常驻词条已超动态额度 ${quota.dynamic} 字 —— 超出部分按优先级逐条取舍（先留常驻、再留直接命中，最后才砍被引荐的）。给它们加触发词最省。`
                        : `世界设定已超固定额度 ${quota.fixed} 字，保存会被拦下 —— 请精简，或拆成带触发词的「世界书词条」（那样按命中注入、更省）。`}
                    </div>
                  )}
                  <div className="text-ink-600">
                    额度按 {quota.ready ? `「${quota.modelLabel || '当前模型'}」` : '当前模型'}的
                    {' '}{fmtWindow(quota.windowTokens)} 窗口算
                    {quota.windowFallback && '（模型没填窗口，按 32K 估）'}
                  </div>
                  <div className="leading-relaxed">
                    旗下剧本 <span className="text-ink-200">{scripts.filter(s => s.storyId === story.id).length}</span> 份，
                    角色卡 <span className="text-ink-200">{storyCharCount}</span> 张
                  </div>
                  {!settingChars && !hasEntries && <div className="text-ink-600">（还没写设定，扮演时会缺世界观）</div>}
                </div>
              )
            })()}
          </div>
        </>
      ) : kind === 'script' && cur ? (
        <>
          <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
            <div className="text-12 text-amber">AI 起草剧本六栏</div>
            <p className="mt-1 text-10 text-ink-400 leading-relaxed">
              写一句你想要的戏（越具体越好），AI 补全六栏。它空着的栏不会覆盖你已写的内容，
              生成后过一遍再保存。
            </p>
            <div className="mt-2">
              <div className="text-11 text-ink-400">一句话想法</div>
              <AutoTextarea
                value={seed}
                onChange={setSeed}
                minRows={3}
                maxHeight={200}
                placeholder="例：雨夜便利店，她是夜班店员，我是每天来买烟的人，今天她忽然锁了烟柜。我想让她说出为什么。
也可以点名已有作品：例：按《梁山伯与祝英台》设计一场楼台会的戏。"
              />
            </div>
            <div className="mt-2">
              <RefsField value={refs} onChange={setRefs} />
            </div>
            <div className="mt-1.5">
              <SearchPlanLine settings={search} />
            </div>
            <Button
              variant="primary" size="md" className="mt-2 w-full"
              disabled={drafting || (!seed.trim() && !refs.trim() && isEmptyScriptFields(fields))}
              onClick={runDraft}
            >
              {drafting ? '正在生成…' : '一键起草（缺的栏补上）'}
            </Button>
            <div className="mt-1.5">
              <Button variant="secondary" size="md" className="w-full" onClick={onOpenInterview}>
                对话引导（边聊边写）
              </Button>
            </div>
            <DraftSourceLine source={lastSource} />
            {cur.draftedAt ? (
              <p className="mt-1.5 text-10 text-ink-500">
                上次生成：{new Date(cur.draftedAt).toLocaleString()}
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
            <div className="text-12 text-ink-200">注入情况</div>
            <div className="mt-1.5 space-y-1 text-11 text-ink-400">
              <div>
                每轮注入 <span className={preview.length > SCRIPT_MAX_CHARS ? 'text-amber' : 'text-ink-200'}>{preview.length}</span>
                <span className="text-ink-600"> / 上限 {SCRIPT_MAX_CHARS} 字</span>
              </div>
              {preview.length > SCRIPT_MAX_CHARS && (
                <div className="text-amber leading-relaxed">
                  超了 —— 它每轮都进上下文，会挤掉对话历史。建议精简情境与目标。
                </div>
              )}
              <div>开场白单列一条消息，不占这 {SCRIPT_MAX_CHARS} 字</div>
              {isEmptyScriptFields(fields) && <div className="text-ink-600">（六栏全空，不进上下文）</div>}
            </div>
          </div>

          <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
            <div className="text-12 text-ink-200">注入预览</div>
            <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-ink-700 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
              {preview || '（空）'}
            </pre>
            {!isEmptyScriptFields(fields) && (
              <>
                <div className="mt-2 text-10 text-ink-500">
                  开场白（在对话里作为「开场」单独显示，示例）：
                </div>
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-ink-700 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
                  {cur.opening.trim() || '（没写开场白 → 没有第一条消息，你直接开口）'}
                </pre>
              </>
            )}
            {!isEmptySnapshot(snapshotOf(cur)) && (
              <p className="mt-2 text-10 leading-relaxed text-ink-600">
                这段在会话里以「这一场」为标题注入，排在角色卡之后、记忆之前。
                开头那句是 {firstLine(cur.situation, 24) || '（没写情境）'}。
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
          <div className="text-12 text-ink-200">故事设定</div>
          <p className="mt-1.5 text-10 leading-relaxed text-ink-400">
            世界设定「每轮都要给模型看」，写太长会挤掉对话历史；建议 400–1200 字，
            把「不写出来模型就会瞎编」的那几件大事写清楚即可。
            细节让背景设定（关键词触发）去扛 —— 它命中才注入，不占常驻额度。
          </p>
          {story && (
            <div className="mt-2 space-y-1 text-11 text-ink-400">
              <div>
                当前字数 <span className="text-ink-200">{story.setting.trim().length}</span>
                <span className="text-ink-600"> 字</span>
              </div>
              <div>
                旗下剧本 <span className="text-ink-200">{scripts.filter(s => s.storyId === story.id).length}</span>
                <span className="text-ink-600"> 份</span>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
