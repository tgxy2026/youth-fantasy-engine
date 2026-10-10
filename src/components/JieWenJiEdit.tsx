/**
 * 颉文姬 · 编辑（选区改稿 → 建议段）面板（C1 · 2.4.2 自 JieWenJi.tsx 拆出）
 *
 * 🔴 状态全部来自 useJieWenJiModel（组件只收 m）。
 * 2.9.2 起：改稿下方新增「续写」折叠区块（②的额外要求 + 期望字数落在改稿区）。
 * ⚠️ 五个动作名（`INSTRUCTIONS`）会**直接进提示词**，改名须同步 `jieWenJi.ts` 的定义段。
 */
import { PenLine, Wand2, Loader2, AlertTriangle, CheckCircle2, Trash2, Feather, ChevronDown, ChevronUp } from 'lucide-react'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { Button } from './Button'
import AutoTextarea from './AutoTextarea'
import NumberField from './NumberField'
import { ADVICE_START, INSTRUCTIONS, CONTINUE_PICKS } from './jieWenJiParts'
import { INSTRUCTION_PLACEHOLDERS, INSTRUCTION_PLACEHOLDER_FALLBACK } from '../lib/rewriteAsk'
import AIDataSourceNote from './AIDataSourceNote'
import { countWords } from '../lib/textStats'
import type { JieWenJiModel } from './useJieWenJiModel'

export default function JieWenJiEdit({ m }: { m: JieWenJiModel }) {
  const {
    aiReady, selText, instruction, setInstruction, detail, setDetail, targetWords, setTargetWords,
    rewrite, runRewrite, applyAdvice, aiBtnCls, onClearAdvice,
    contOpen, setContOpen, contWords, setContWords, contPlot, setContPlot, contPicks, toggleContPick,
    contSummaryCount, setContSummaryCount, contPrevTextCount, setContPrevTextCount,
    contPreview, cont, runContinuation, applyContinuation,
  } = m
  // 三类「本次未带入」并成一行（设定段被预算丢 / 前几章正文没带上 / 摘要有章没填）—— 绝不静默丢
  const contMissed = [
    ...contPreview.dropped,
    ...(contPreview.droppedPrevTexts > 0 ? [`前文章节 ${contPreview.droppedPrevTexts} 章`] : []),
    ...(contPreview.missingSummaries > 0 ? [`${contPreview.missingSummaries} 章未填摘要`] : []),
  ]
  const contOver = contPreview.budget > 0 && contPreview.chars > contPreview.budget
  return (
          <>
            <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-10 text-ink-500">当前选区</span>
                {selText && <span className="text-10 text-ink-500">{selText.length} 字</span>}
              </div>
              {selText ? (
                <div className="text-11 text-ink-100 leading-snug max-h-32 overflow-y-auto line-clamp-5">{selText}</div>
              ) : (
                <div className="text-11 text-ink-500 leading-relaxed">先在正文中选中一段文字（选中后无需再点任何按钮，选区会自动同步到这里）。</div>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {INSTRUCTIONS.map(ins => (
                <Button variant="toggle" selected={instruction === ins}
                  key={ins}
                  onClick={() => setInstruction(ins)}
                  className="py-1 rounded-full border hover:border-ink-500"
                >
                  {ins}
                </Button>
              ))}
            </div>

            {/* 2.9.2 · ②：额外要求 + 期望字数。
                「动作 + 额外要求」是**并存**：动作决定纪律（扩写不得造专名等），额外要求是对它的细化。
                🔴 不预填模板（会盖掉作者已写的内容）、不记忆（上次的要求会偷偷影响这次）。 */}
            <div className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 space-y-2">
              <div>
                <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-10 text-ink-500">额外要求（选填）</span>
                  <span className="text-10 text-ink-600">写了就按它补充执行；不写则用「{instruction}」的默认做法</span>
                </div>
                <AutoTextarea
                  value={detail}
                  onChange={setDetail}
                  minRows={2}
                  maxHeight={120}
                  textClass="text-11"
                  className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 px-2 py-1 outline-none focus:border-amber/40 placeholder:text-ink-600"
                  placeholder={INSTRUCTION_PLACEHOLDERS[instruction] ?? INSTRUCTION_PLACEHOLDER_FALLBACK}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-10 text-ink-500">期望字数</span>
                <NumberField
                  value={targetWords}
                  onChange={setTargetWords}
                  min={1} max={20000}
                  allowEmpty
                  className="w-24 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-11 px-2 py-1 outline-none focus:border-amber/40 placeholder:text-ink-600"
                  placeholder="留空＝不限"
                />
                <span className="text-10 text-ink-600">字</span>
                <span className="text-10 text-ink-500">AI 会尽量贴近，实际字数以生成为准</span>
              </div>
            </div>

            <Button variant="bare"
              onClick={() => void runRewrite()}
              disabled={!aiReady || !selText || rewrite.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {rewrite.loading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              {/* ⚠️ 不能写成 `让颉文姬${instruction}选区` —— 动作改名为「语气 / 视角」后会变成
                  「让颉文姬语气选区」这种病句（旧名是「改语气」，才刚好通顺）。 */}
              {rewrite.loading ? '改稿中…' : `让颉文姬按「${instruction}」改这段`}
            </Button>

            {rewrite.error && <div className="text-11 text-danger px-1">{rewrite.error}</div>}

            {rewrite.data && (rewrite.data.rewritten ? (
              <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5 space-y-2">
                <div className="flex items-center gap-1.5 text-11 text-amber">
                  <CheckCircle2 size={12} /> 改稿完成{rewrite.data.notes ? `：${rewrite.data.notes}` : ''}
                </div>
                <div className="text-11 text-ink-100 leading-relaxed whitespace-pre-wrap max-h-52 overflow-y-auto">{rewrite.data.rewritten}</div>
                <Button onClick={applyAdvice} variant="primary" size="md" className="w-full flex items-center justify-center">
                  <PenLine size={12} /> 写入原文下方（建议段）
                </Button>
                <div className="text-10 text-ink-500 leading-relaxed">
                  建议段以「{ADVICE_START}」标记写入原文下方，不会改动你的原文。请自行取舍：保留的直接并入，不用的删除；下方按钮可一键清除全部建议段。
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 space-y-1.5">
                <div className="flex items-center gap-1.5 text-11 text-danger">
                  <AlertTriangle size={12} /> 本次未取到有效内容
                </div>
                <div className="text-10 text-ink-400 leading-relaxed">
                  模型返回的内容无法解析为有效段落（多为返回格式不规范，或选区过长被截断）。
                  建议缩短选区后重试；连续失败可更换模型。你的原文未被改动。
                </div>
              </div>
            ))}

            {/* 2.9.2 · ③：续写（独立于上面的改稿；结果同样落「建议段」）。默认收起。 */}
            <div className="rounded-lg border border-ink-700 bg-ink-900/60 overflow-hidden">
              <Button variant="bare"
                onClick={() => setContOpen(!contOpen)}
                className="w-full flex items-center justify-between px-3 py-2 text-11 text-ink-200 hover:bg-ink-800/60 transition-colors"
              >
                <span className="flex items-center gap-1.5"><Feather size={12} className="text-amber/80" /> 续写（接本章末尾往下写）</span>
                {contOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </Button>

              {contOpen && (
                <div className="px-3 pb-2.5 space-y-2 border-t border-ink-700">
                  <div className="flex flex-wrap items-center gap-2 pt-2.5">
                    <span className="text-10 text-ink-500">续写字数</span>
                    <NumberField
                      value={contWords}
                      onChange={setContWords}
                      min={1} max={20000}
                      allowEmpty
                      className="w-20 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-11 px-2 py-1 outline-none focus:border-amber/40 placeholder:text-ink-600"
                      placeholder="留空＝不限"
                    />
                    <span className="text-10 text-ink-600">字（AI 尽量贴近，实际以生成为准）</span>
                  </div>

                  <div>
                    <div className="mb-1 text-10 text-ink-500">主要情节（选填）</div>
                    <AutoTextarea
                      value={contPlot}
                      onChange={setContPlot}
                      minRows={2}
                      maxHeight={110}
                      textClass="text-11"
                      className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 px-2 py-1 outline-none focus:border-amber/40 placeholder:text-ink-600"
                      placeholder="例：主角在拍卖会上遇到旧敌，竞价被打断，暂时收手"
                    />
                  </div>

                  <div>
                    <div className="mb-1 flex flex-wrap items-baseline gap-x-1.5 text-10 text-ink-500">
                      <span>给 AI 的资料</span>
                      <span className="text-ink-600">勾得越多越可能超预算</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {CONTINUE_PICKS.map(p => (
                        <Button variant="toggle" key={p.key} selected={contPicks.has(p.key)} title={p.hint}
                          onClick={() => toggleContPick(p.key)}
                          className="px-1.5 py-0.5 rounded-full text-10 border hover:border-ink-500"
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {(contPicks.has('summaries') || contPicks.has('prev-texts')) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {contPicks.has('summaries') && (
                        <span className="flex items-center gap-1.5">
                          <span className="text-10 text-ink-500">摘要取</span>
                          <NumberField
                            value={contSummaryCount}
                            onChange={v => setContSummaryCount(v ?? 1)}
                            min={1} max={10}
                            className="w-14 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-11 px-2 py-1 outline-none focus:border-amber/40"
                            placeholder="3"
                          />
                          <span className="text-10 text-ink-600">章（含本章）</span>
                        </span>
                      )}
                      {contPicks.has('prev-texts') && (
                        <span className="flex items-center gap-1.5">
                          <span className="text-10 text-ink-500">正文取</span>
                          <NumberField
                            value={contPrevTextCount}
                            onChange={v => setContPrevTextCount(v ?? 1)}
                            min={1} max={5}
                            className="w-14 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-11 px-2 py-1 outline-none focus:border-amber/40"
                            placeholder="1"
                          />
                          <span className="text-10 text-ink-600">章（上限 5）</span>
                        </span>
                      )}
                    </div>
                  )}

                  <div className="rounded-lg bg-ink-800/50 px-2 py-1.5 text-10 leading-relaxed">
                    {contPreview.loading ? (
                      <span className="text-ink-500">正在估算资料用量…</span>
                    ) : (
                      <>
                        <span className={contOver ? 'text-danger' : 'text-ink-400'}>
                          预计占用约 {contPreview.chars.toLocaleString()} 字 / 预算 {contPreview.budget.toLocaleString()} 字
                        </span>
                        {contOver && <span className="text-danger"> —— 超出的部分不会发送</span>}
                        {contMissed.length > 0 && (
                          <div className="text-amber/80">本次未带入：{contMissed.join('、')}</div>
                        )}
                        {!contPreview.srcFound && (
                          <div className="text-amber/80">未能在章节列表里定位到本章，本次只会带设定资料</div>
                        )}
                      </>
                    )}
                  </div>

                  <Button variant="bare"
                    onClick={() => void runContinuation()}
                    disabled={!aiReady || cont.loading}
                    className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
                    title={!aiReady ? AI_DISABLED_HINT : undefined}
                  >
                    {cont.loading ? <Loader2 size={12} className="animate-spin" /> : <Feather size={12} />}
                    {cont.loading ? '续写中…' : '让颉文姬续写'}
                  </Button>

                  {cont.error && <div className="text-11 text-danger px-1">{cont.error}</div>}

                  {!cont.error && (cont.loading || cont.text) && (
                    <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5 space-y-2">
                      <div className="flex items-center gap-1.5 text-11 text-amber">
                        {cont.loading
                          ? <><Loader2 size={12} className="animate-spin" /> 续写中… 已生成 {countWords(cont.text)} 字</>
                          : <><CheckCircle2 size={12} /> 续写完成 · {countWords(cont.text)} 字</>}
                      </div>
                      <div className="text-11 text-ink-100 leading-relaxed whitespace-pre-wrap max-h-52 overflow-y-auto">{cont.text}</div>
                      {!cont.loading && cont.text && (
                        <>
                          <Button onClick={applyContinuation} variant="primary" size="md" className="w-full flex items-center justify-center">
                            <PenLine size={12} /> 写入原文下方（建议段）
                          </Button>
                          {cont.dropped.length > 0 && (
                            <div className="text-10 text-amber/80 leading-relaxed">
                              本次因预算未带入：{cont.dropped.join('、')}（可少勾几项后重试）
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <div className="text-10 text-ink-600 leading-relaxed">
                    续写结果同样以「{ADVICE_START}」标记写在原文下方，你的原文一字不动。
                  </div>
                  <AIDataSourceNote feature="jiewenji-continue" compact />
                </div>
              )}
            </div>

            <Button variant="bare"
              onClick={() => onClearAdvice?.()}
              className={`${aiBtnCls} bg-ink-800 border-ink-600 text-ink-300 hover:border-danger/40 hover:text-danger`}
            >
              <Trash2 size={12} /> 清除全部建议段
            </Button>
          </>
  )
}
