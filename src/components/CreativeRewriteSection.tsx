/**
 * 创意写作 · 整章改写（C1 · 2.4.2 自 CreativeWritingPanel.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useCreativeWritingModel（组件只收 m）。
 */
import AIDataSourceNote from './AIDataSourceNote'
import HelpPopover from './HelpPopover'
import AutoTextarea from './AutoTextarea'
import ChapterPicker from './ChapterPicker'
import NumberField from './NumberField'
import { Loader2, Square, Wand2 } from 'lucide-react'
import { Button } from './Button'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { applyRewrite, discardRewrite, startChapterRewrite, stopChapterRewrite } from '../lib/creativeSession'
import { CHAPTER_REWRITE_META } from '../lib/aiTasks'
import { countWords } from '../lib/textStats'
import { NUM_INPUT, RW_ACTIONS, RW_SCOPE_NOTE } from './creativeWritingParts'
import type { CreativeWritingModel } from './useCreativeWritingModel'

export default function CreativeRewriteSection({ m }: { m: CreativeWritingModel }) {
  const { s, aiReady, tree, rwChapter, setRwChapter, rwAction, setRwAction, rwReq, setRwReq, rwWords, setRwWords, busy, reloadChapters, latestId, pickInfo } = m
  return (
    <>
      {/* 整章改写：对已有章节做整章级的润色 / 扩写 / 精简 / 续写 / 改写 */}
      <section className="mt-4 rounded-lg border border-ink-700 bg-ink-900/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-ink-100">整章改写</span>
          <HelpPopover title="整章改写怎么用" width="24rem" size={12}>
            <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
              <p>挑一章，对<b>整章正文</b>做润色 / 扩写 / 精简 / 续写 / 改写。与颉文姬的「选区改稿」不同 —— 那边面向一段、产出叫「建议段」；这里送进去的是<b>整章</b>，产出先给你过目，确认后才替换正文。</p>
              <p><b>「扩写」与「续写」不是一回事</b>：扩写会<b>重写</b>整章（把原句写长、补细节），文字与原稿不同；续写则<b>原文一字不动</b>，只在末尾接着往下写，把全章补到目标字数 —— 觉得「这一章还没写完」就用<b>续写</b>。</p>
              <p>改写时会一并送<b>上一章结尾</b>（约 1200 字），保证改完仍接得上；上面那栏「补充要求」可以告诉它往哪个方向改（例如「打斗写细一点」「对话再口语些」）。</p>
              <p>点「替换该章正文」之前，旧稿会自动存进<b>「时光机 · 本章版本历史」</b>，随时能恢复。章节标题、状态、所属卷都不会被改动。</p>
              <p>改写纪律由<b>「动作 × 章位置」</b>共同决定：<b>历史章</b>设定类内容一律冻结（润色只换字不换事；扩写只能加描写、不得新增专名与来历；精简不得删掉承载设定交代的句子；改写只改叙述方式）；<b>最新章</b>只有「改写」档可放开手脚，改完落库会自动抽取 / 补登 / 更新设定表。</p>
              <AIDataSourceNote feature="chapter-rewrite" compact />
            </div>
          </HelpPopover>
          <span className="text-11 text-ink-500">
            挑一章做整章润色 / 扩写 / 精简 / 续写 / 改写 —— 结果先给你过目，确认后才替换正文（旧稿自动留档）
          </span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => void reloadChapters()}>刷新章节</Button>
        </div>

        <div className="mt-2.5 space-y-2">
          <div>
            <div className="mb-1 text-11 text-ink-400">选一章（可搜章号 / 标题，点卷名折叠）</div>
            <ChapterPicker groups={tree} value={rwChapter} onChange={setRwChapter}
              disabled={busy} {...(latestId ? { latestId } : {})} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-11 text-ink-400">
          <div className="flex items-center gap-1.5">动作
            {RW_ACTIONS.map(k => (
              <Button key={k} variant="toggle" selected={rwAction === k} disabled={busy}
                onClick={() => setRwAction(k)} title={CHAPTER_REWRITE_META[k].hint}
                className="px-3 h-8 rounded-lg text-12">
                {CHAPTER_REWRITE_META[k].label}
              </Button>
            ))}
          </div>
          {CHAPTER_REWRITE_META[rwAction].needWords && (
            <label className="flex items-center gap-1.5">目标字数
              <NumberField value={rwWords} min={300} max={20000} step={100} disabled={busy}
                title="目标字数：300 ~ 20000（超出范围会调回最近的边界）"
                onChange={v => setRwWords(v ?? 3000)} className={NUM_INPUT} />
            </label>
          )}
          </div>
        </div>
        <p className="mt-1 text-10 leading-relaxed text-ink-500">{CHAPTER_REWRITE_META[rwAction].hint}</p>
        {/* 改写纪律：由「动作 × 章位置」共同决定（与提示词侧同一矩阵）—— 先说清楚，
            别让作者改完旧章才发现设定对不上，也别让人以为"最新章"就能放开润色 */}
        {pickInfo && (() => {
          const isLatest = pickInfo.chapter.id === latestId
          const tone = isLatest ? 'text-success' : (rwAction === 'polish' ? 'text-ink-400' : 'text-amber')
          return (
            <p className={`mt-1 text-10 leading-relaxed ${tone}`}>
              {isLatest ? RW_SCOPE_NOTE[rwAction].latest : RW_SCOPE_NOTE[rwAction].history}
            </p>
          )
        })()}

        <div className="mt-2">
          <AutoTextarea
            value={rwReq}
            onChange={setRwReq}
            minHeight={44}
            maxHeight={120}
            disabled={busy}
            placeholder="补充要求（可选）：例如「打斗写细一点」「对话再口语些」「把章末钩子改得更狠」"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={!aiReady || !rwChapter || busy}
            // 🔴 文案别用「开始改写」：上面那排动作里就有一个叫「改写」，两者撞车 ——
            //    更糟的是选了「润色」时按钮仍说"开始改写"，读起来像要执行另一个动作。
            //    改成「开始生成 / 重新生成」（与 AITemplateFill、颉文姬的措辞一致），
            //    动作名只由上面那排承担，这里只说"开始产出结果"。
            title="按上面选的动作与「补充要求」处理这一章：先出结果给你过目，确认后才替换正文"
            onClick={() => void startChapterRewrite({ chapterId: rwChapter, action: rwAction, requirement: rwReq, words: rwWords })}>
            <Wand2 size={12} /> {s.rewrite ? '重新生成' : '开始生成'}
          </Button>
          {s.rewrite?.running && (
            <Button size="sm" variant="danger" onClick={() => stopChapterRewrite()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {!aiReady && <span className="text-11 text-amber">{AI_DISABLED_HINT}</span>}
        </div>

        {s.rewrite && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2 text-11">
              <span className="text-ink-200">
                {s.rewrite.no > 0 ? `第${s.rewrite.no}章 ` : ''}{s.rewrite.title}
              </span>
              {s.rewrite.running
                ? <span className="text-ink-400"><Loader2 size={11} className="inline animate-spin" /> 正在改写…</span>
                : <span className={s.rewrite.suspect ? 'text-amber' : 'text-success'}>
                    {s.rewrite.fromWords} → {countWords(s.rewrite.text)} 字{s.rewrite.suspect ? ' · 结果异常' : ''}
                  </span>}
            </div>
            <div className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-ink-700 bg-ink-900 p-3 text-12 leading-[1.9] text-ink-200">
              {s.rewrite.text || '（等待模型输出…）'}
            </div>
            {!s.rewrite.running && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" solid disabled={!!s.rewrite.suspect}
                  onClick={() => void applyRewrite()}>替换该章正文</Button>
                <Button size="sm" variant="secondary" onClick={() => discardRewrite()}>丢弃这次结果</Button>
                {s.rewrite.suspect
                  ? <span className="text-10 text-amber">结果与期望的约 {s.rewrite.expectWords} 字相差过大（实际 {countWords(s.rewrite.text)} 字），已锁住替换 —— 请重新生成。</span>
                  : <span className="text-10 text-ink-500">替换前会自动把旧稿存进「时光机 · 本章版本历史」，可随时恢复。</span>}
              </div>
            )}
          </div>
        )}
      </section>
    </>
  )
}
