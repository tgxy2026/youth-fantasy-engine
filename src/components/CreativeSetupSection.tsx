/**
 * 创意写作 · 创作设置（长度档 / 目标 / 想法 / 规划与连写入口）（C1 · 2.4.2 自 CreativeWritingPanel.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useCreativeWritingModel（组件只收 m）。
 */
import AutoTextarea from './AutoTextarea'
import NumberField from './NumberField'
import { Eraser, Loader2, Play, Save, Sparkles, Square, Wand2 } from 'lucide-react'
import { Button } from './Button'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import InspirationPicker from './InspirationPicker'
import { StyleProfilePicker } from './StyleProfilePicker'
import { clearCreativeSession, saveInputsNow, startCreativeRun, stopCreativeRun, updateInputs } from '../lib/creativeSession'
import { MAX_CHAPTERS_PER_VOLUME, MAX_OUTLINE_CHAPTERS, MAX_OUTLINE_VOLUMES } from '../lib/aiTasks'
import { DEAI_TEMPLATES } from '../lib/autoContinue'
import { MAX_CHAPTERS } from '../lib/writingPace'
import { STORY_TEMPLATES } from '../lib/storyStructures'
import { NUM_INPUT, fmtSavedAt, LENGTH_META, LENGTHS, TARGET_META, STRATEGY_META, STRATEGIES } from './creativeWritingParts'
import type { CreativeWritingModel } from './useCreativeWritingModel'

export default function CreativeSetupSection({ m }: { m: CreativeWritingModel }) {
  const { s, inp, setInterview, aiReady, busy, probe, onPickLength, onClearSeed, pace, outlineOnlyTarget, targets, hasOutline, needSeed, hasOutlineCards, batchTotal, batchOversize, gap, gapTotal, gapWillFill, gapFillTo, probeNote, canStart, startLabel } = m
  return (
    <>
      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        {/* ① 篇幅：短篇一次跑完；中长篇把大纲规划与正文生成分成两趟，各自可反复执行 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {LENGTHS.map(l => (
            <Button key={l} variant="toggle" selected={inp.length === l} disabled={busy}
              title={LENGTH_META[l].hint} onClick={() => onPickLength(l)}
              className="rounded-lg">
              {LENGTH_META[l].label}
            </Button>
          ))}
        </div>

        {/* ② 这一次要产出什么（可选项随篇幅变化） */}
        <div className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
          <div className="mb-1.5 text-12 text-ink-300">这一次要产出什么</div>
          <div className="flex flex-wrap gap-1.5">
            {targets.map(k => (
              <Button key={k} variant="toggle" selected={inp.target === k} disabled={busy}
                onClick={() => updateInputs({ target: k })} title={TARGET_META[k].hint}
                className="rounded-lg">
                {TARGET_META[k].label}
              </Button>
            ))}
          </div>
          <p className="mt-1 text-10 leading-relaxed text-ink-500">{TARGET_META[inp.target].hint}</p>
          {/* 🔴 起点是自动判定的，所以必须把"AI 会从哪开始"写出来 —— 否则作者无从知道
              这一次到底会重跑设定、还是接着上次往下排。 */}
          {probeNote && <p className="mt-1 text-10 leading-relaxed text-amber">{probeNote}</p>}
        </div>

        {/* ③ 输入：库里还没有大纲 → 必须先给一句话想法（设定奠基的唯一依据）；
               已有大纲且要写正文 → 可以给一句可选的剧情方向 */}
        {needSeed ? (
          <div className="mt-3">
            {/* 一句话想法：给出**显式保存 / 清空**（老大 2026-09-20 要求）——
                原先只有自动防抖落盘：作者既看不到存没存，也没有一个能主动确认的动作。 */}
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-13 text-ink-200">一句话想法</span>
              <span className="text-10 text-ink-500"
                title={s.lastSavedAt ? `最近保存：${new Date(s.lastSavedAt).toLocaleString('zh-CN')}` : '改动会自动保存到本项目'}>
                {s.lastSavedAt ? `已保存 · ${fmtSavedAt(s.lastSavedAt)}` : '尚未保存'}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="secondary" disabled={busy}
                  title="立刻把当前输入保存到本项目（平时改动也会自动保存）"
                  onClick={() => void saveInputsNow()}>
                  <Save size={12} /> 保存
                </Button>
                <Button size="sm" variant="secondary" disabled={busy || !inp.seed.trim()}
                  title="清空输入框，重新写"
                  onClick={() => void onClearSeed()}>
                  <Eraser size={12} /> 清空
                </Button>
              </div>
            </div>
            <textarea
              value={inp.seed}
              onChange={e => updateInputs({ seed: e.target.value })}
              disabled={s.running}
              spellCheck={false}
              placeholder="例：一个靠吞噬他人修为续命的少年，在正道与魔道之间越走越深。"
              className="h-24 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-12 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
            />
            <p className="mt-1.5 text-11 leading-relaxed text-ink-500">
              想法按项目保存：切页签、关掉软件再打开都还在。「保存」立刻写入，「清空」清掉重写。
            </p>
          </div>
        ) : inp.target !== 'outline' ? (
          <div className="mt-3">
            <div className="mb-1.5 text-13 text-ink-200">情节概要（可选，不填则严格承接上一章往下写）</div>
            <AutoTextarea
              value={inp.intent}
              onChange={v => updateInputs({ intent: v })}
              minHeight={60}
              maxHeight={160}
              disabled={s.running}
              placeholder="例如：陈渊在秘境深处发现上古遗迹，意外获得一卷残破功法……"
            />
            <p className="mt-1.5 text-11 text-ink-500 leading-relaxed">
              小提示：续写前，若先对前几章正文通读梳理一遍（或在编辑器里重新生成章节压缩摘要），
              能让 AI 更好地承接剧情、衔接更自然流畅。
            </p>
          </div>
        ) : null}

        {/* 规模参数（同一行）：大纲规划档问"排多大"，正文档问"写多少"。
            🔴 尺寸一律 h-8（与本面板其余 toggle 对齐 —— 混着 24/28px 会看着散）。 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-11 text-ink-400">
          {outlineOnlyTarget ? (
            <>
              {/* 中长篇才分批：短篇就是 1 卷，不劳作者去设 */}
              {/* 🔴 缺口模式下「本批卷数」不生效（本批只补那一卷）—— 收起来，免得作者以为它会算数 */}
              {inp.length === 'long' && !gap && (
                <label className="flex items-center gap-1.5">本批卷数
                  <NumberField value={inp.volumes} min={1} max={MAX_OUTLINE_VOLUMES} disabled={s.running}
                    title={`本批要排几卷：1 ~ ${MAX_OUTLINE_VOLUMES}（超出范围会调回最近的边界）`}
                    onChange={v => updateInputs({ volumes: v ?? 1 })} className={NUM_INPUT} />
                </label>
              )}
              <label className="flex items-center gap-1.5">{inp.length === 'long' ? '每卷章数' : '全书章数'}
                <NumberField value={inp.chaptersPerVolume} min={1} max={MAX_CHAPTERS_PER_VOLUME} disabled={s.running}
                  title={gap
                    ? '缺口模式下它用来推断「这一卷原本规划多少章」（老数据的卷卡只写了范围文本时靠它补齐）'
                    : `每卷多少章：1 ~ ${MAX_CHAPTERS_PER_VOLUME}（硬指标，超出范围会调回最近的边界）`}
                  onChange={v => updateInputs({ chaptersPerVolume: v ?? 20 })} className={NUM_INPUT} />
              </label>
              {/* 2.5.0 · A1 结构模板：给大纲规划注入「全书结构参考」（选「不使用」＝行为与旧版一致）。
                  🔴 缺口补齐模式下不显示 —— 缺口批次不注入结构参考（走向已被既有卷约束）。 */}
              {!gap && (
                <label className="flex items-center gap-1.5">参考结构
                  <select value={inp.structureId} disabled={s.running}
                    onChange={e => updateInputs({ structureId: e.target.value })}
                    title="给大纲规划注入全书结构参考（节拍占比按总章数折算，AI 贴合但不硬对齐）；缺口补齐不生效。"
                    className="bg-ink-800 border border-ink-700 rounded-md text-ink-100 text-11 px-2 py-1 outline-none focus:border-amber/40 disabled:opacity-60">
                    <option value="">不使用</option>
                    {STORY_TEMPLATES.map(t => (
                      <option key={t.id} value={t.id}>{t.name}（{t.beats.length} 拍）</option>
                    ))}
                  </select>
                </label>
              )}
              {/* 🔴 缺口模式：本次产出多少章由**缺口**决定，「卷数 × 每卷章数」不参与 —— 必须如实说明 */}
              {gap ? (
                <span className="text-10 text-amber">
                  本次补《{gap.title}》缺口 {gapTotal} 章中的第 {gap.gapFrom}-{gapFillTo} 章
                  {gapWillFill < gapTotal ? `（单批上限 ${MAX_OUTLINE_CHAPTERS} 章，剩下的下次继续）` : ''}
                  —— 卷数不生效，补满后再排新卷
                </span>
              ) : (
                <span className={batchOversize ? 'text-10 text-amber' : 'text-10 text-ink-500'}>
                  本批共 {batchTotal} 章
                  {batchOversize ? ` —— 超过单批上限 ${MAX_OUTLINE_CHAPTERS} 章，请拆成几批排` : ''}
                </span>
              )}
            </>
          ) : (
            <>
              <label className="flex items-center gap-1.5">本次写几章
                <NumberField value={inp.chapters} min={1} max={MAX_CHAPTERS} disabled={s.running}
                  title={`本次写几章：1 ~ ${MAX_CHAPTERS}（超出范围会调回最近的边界）`}
                  onChange={v => updateInputs({ chapters: v ?? 1 })} className={NUM_INPUT} />
              </label>
              <label className="flex items-center gap-1.5">每章目标字数
                <NumberField value={inp.words} min={800} max={8000} step={100} disabled={s.running}
                  title="每章目标字数：800 ~ 8000（超出范围会调回最近的边界）"
                  onChange={v => updateInputs({ words: v ?? 2500 })} className={NUM_INPUT} />
              </label>
              {/* 「用推荐值」紧跟每章目标字数（推荐值是按字数×模型窗口一起算出来的，
                  按钮文案里也写着调成几章，不会误读成"改字数"） */}
              {pace && inp.chapters !== pace.recommendedChapters && (
                <Button size="sm" variant="secondary" disabled={s.running} title={pace.model}
                  onClick={() => updateInputs({ chapters: pace.recommendedChapters })}>
                  用推荐值（{pace.recommendedChapters} 章）
                </Button>
              )}
            </>
          )}
          {/* 对话引导：只服务「一句话想法」那个输入框（库里已有大纲时用不上） */}
          {needSeed && (
            <Button size="sm" variant="secondary" disabled={s.running} onClick={() => setInterview(true)}>
              <Sparkles size={12} /> 对话引导
            </Button>
          )}
        </div>
        {!outlineOnlyTarget && pace && (
          <p title={pace.model} className={`mt-1 text-10 leading-relaxed ${pace.level === 'ok' ? 'text-ink-500' : 'text-amber'}`}>
            {pace.note}
          </p>
        )}

        {/* 连写设置（两种起点共用 —— 融合点之一：从零创作与接着写用的是同一套连写引擎，
            设定同步策略、去 AI 味儿、逐章确认两边完全一致）
            「只做大纲规划」不写正文，这些设置整块收起来，免得让人以为接下来还要连写 */}
        {!outlineOnlyTarget && (
        <details className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2" open>
          <summary className="cursor-pointer text-12 text-ink-200">连写设置（每章设定同步 · 去 AI 味儿 · 逐章确认）</summary>
          <div className="mt-2.5 space-y-3">
            <div>
              <div className="mb-1.5 text-12 text-ink-300">每章设定同步策略</div>
              <p className="mb-1.5 text-10 leading-relaxed text-ink-500">
                每章写完都会固定做三件事：① 抽取本章设定 → ② 新增的补登进设定表 → ③ 已登记且发生变化的信息做更新。
                下面三档只决定 ②③ 的力度，不决定做不做。
              </p>
              <div className="flex flex-wrap gap-1.5">
                {STRATEGIES.map(k => (
                  <Button key={k} variant="toggle" selected={inp.strategy === k} disabled={s.running}
                    onClick={() => updateInputs({ strategy: k })} title={STRATEGY_META[k].hint}
                    className="rounded-lg">
                    {STRATEGY_META[k].label}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-10 leading-relaxed text-ink-500">{STRATEGY_META[inp.strategy].hint}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="toggle" selected={inp.deAiOn} disabled={s.running}
                onClick={() => updateInputs({ deAiOn: !inp.deAiOn })}
                className="rounded-lg"
                title="开启后，AI 每章初稿会先按所选提示词润色一遍，再交你裁决">
                <Wand2 size={12} className="mr-1" />
                去 AI 味儿：{inp.deAiOn ? '已开启' : '已关闭'}
              </Button>
              <Button variant="toggle" selected={inp.reviewEach} disabled={s.running}
                onClick={() => updateInputs({ reviewEach: !inp.reviewEach })}
                className="rounded-lg"
                title="开启时每章初稿弹窗让你决定采纳或重写；关闭＝全自动连写">
                逐章确认初稿：{inp.reviewEach ? '已开启' : '已关闭（全自动）'}
              </Button>
              {hasOutlineCards && (
                <Button variant="toggle" selected={inp.useOutline} disabled={s.running}
                  onClick={() => updateInputs({ useOutline: !inp.useOutline })}
                  className="rounded-lg"
                  title="项目里存在《章节细纲》卡时，按章号取当章细纲写进提示词，让正文跟着大纲走">
                  按《章节细纲》写：{inp.useOutline ? '已开启' : '已关闭'}
                </Button>
              )}
              {/* 🔴 正文缺口优先（2026-09-20）：这是本面板**唯一会改动已有正文**的开关，
                  所以文案必须把"改哪一章、改什么"讲明白 */}
              <Button variant="toggle" selected={inp.topUpLast} disabled={s.running}
                onClick={() => updateInputs({ topUpLast: !inp.topUpLast })}
                className="rounded-lg"
                title="开启时：开写新章之前，若最后一章明显没写完（字数低于目标），先把它补到目标字数再往下写。只补最后一章，历史章一个字不动">
                先补完最后一章：{inp.topUpLast ? '已开启' : '已关闭'}
              </Button>
              {/* 2.5.2 · A2：作者灵感（灵感夹只读勾选 → 注入本章提示词「作者灵感」段） */}
              <InspirationPicker disabled={s.running}
                selected={inp.inspirations ?? []}
                onChange={v => updateInputs({ inspirations: v })} />
            </div>

            {inp.deAiOn && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {DEAI_TEMPLATES.map(t => (
                    <Button key={t.id} variant="toggle" selected={inp.deAiTpl === t.id} disabled={s.running}
                      onClick={() => updateInputs({ deAiTpl: t.id })} title={t.desc}
                      className="rounded-lg">
                      {t.label}
                    </Button>
                  ))}
                </div>
                {inp.deAiTpl === 'custom' && (
                  <AutoTextarea value={inp.deAiCustom} onChange={v => updateInputs({ deAiCustom: v })}
                    minHeight={50} maxHeight={140}
                    placeholder="粘贴你自己的去 AI 味儿提示词（例如：去掉说教感，多用短句……）" />
                )}
                <p className="text-10 leading-relaxed text-ink-500">
                  内置 3 套去味儿提示词（即网络常见「去 AI 味儿 skill」的本地化版本），可切换或自定义；
                  润色结果异常时自动保留原稿。
                  另外：初稿生成时就已经带上同一套文风纪律（模板词 / 句式 / 节奏三类判据），
                  不是「先写出一股 AI 腔、再回头洗」 —— 两道一起才洗得干净。
                </p>
              </div>
            )}

            {/* 文风档（#015）：与「去 AI 味儿」并列 —— 那条管「别像 AI」，这条管「像作者自己」 */}
            <StyleProfilePicker ownerTab="creative-writing"
              hint="按你提炼的文风落笔；与去 AI 味儿、灵感并列，互不覆盖" />
          </div>
        </details>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={s.running || !canStart}
            onClick={() => void startCreativeRun()}>
            {s.running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {s.running ? '创作中…' : startLabel}
          </Button>
          {!s.running && s.resume && (
            <Button size="sm" variant="secondary" onClick={() => void startCreativeRun({ fromScratch: true })}>
              从头重写（丢弃断点）
            </Button>
          )}
          {s.running && (
            <Button size="sm" variant="danger" onClick={() => stopCreativeRun()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {!s.running && s.result && (
            <Button size="sm" variant="secondary" onClick={clearCreativeSession}>清空本次记录</Button>
          )}
          {s.running && <span className="text-11 text-ink-400">{s.progress?.message ?? ''}</span>}
          {!aiReady && <span className="text-11 text-amber">{AI_DISABLED_HINT}</span>}
        </div>

        {!s.running && s.resume && (
          <div className="mt-1 text-11 leading-relaxed text-ink-400">
            上次中止在：{s.resume.label}。点「继续写作」从断点接着写，
            <b className="text-ink-300">已落库的章不会重写</b>；
            <span className="text-ink-500">改了「连写章数」会令断点失效（自动从头跑），避免剩余章数算错。</span>
          </div>
        )}
        <div className="mt-1.5 text-10 leading-relaxed text-ink-500">
          {outlineOnlyTarget
            ? (hasOutline
                ? `本次只做大纲规划：从第 ${(probe?.maxOutlineNo ?? 0) + 1} 章起接着往下排 ${batchTotal} 章（不写正文、不抽设定），确认后即收工。`
                : '本次只做大纲规划：先做设定奠基，再排分卷大纲与章节细纲。大纲确认后即收工、不写正文；两个闸门处都可放弃（放弃＝不留半成品）。')
            : (hasOutline
                ? '从项目里最后一章往下写，随时可中止；已落库的章不会被改写，写完去「正文编辑」逐章审阅。'
                : '本次会一次跑完：设定奠基 → 分卷大纲 → 逐章连写；随时可中止，写完去「正文编辑」逐章审阅。')}
        </div>
      </section>
    </>
  )
}
