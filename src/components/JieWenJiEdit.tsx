/**
 * 颉文姬 · 编辑（选区改稿 → 建议段）面板（C1 · 2.4.2 自 JieWenJi.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useJieWenJiModel（组件只收 m）。
 */
import { PenLine, Wand2, Loader2, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { Button } from './Button'
import { ADVICE_START, INSTRUCTIONS } from './jieWenJiParts'
import type { JieWenJiModel } from './useJieWenJiModel'

export default function JieWenJiEdit({ m }: { m: JieWenJiModel }) {
  const { aiReady, selText, instruction, setInstruction, rewrite, runRewrite, applyAdvice, aiBtnCls, onClearAdvice } = m
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
                  className="px-2.5 py-1 rounded-full border text-11 hover:border-ink-500"
                >
                  {ins}
                </Button>
              ))}
            </div>

            <Button variant="bare"
              onClick={() => void runRewrite()}
              disabled={!aiReady || !selText || rewrite.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {rewrite.loading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              {rewrite.loading ? '改稿中…' : `让颉文姬${instruction}选区`}
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

            <Button variant="bare"
              onClick={() => onClearAdvice?.()}
              className={`${aiBtnCls} bg-ink-800 border-ink-600 text-ink-300 hover:border-danger/40 hover:text-danger`}
            >
              <Trash2 size={12} /> 清除全部建议段
            </Button>
          </>
  )
}
