/**
 * 联网检索设置（全局）—— 挂在「工作面板 → 模型设置」，紧挨「模型配置」。
 *
 * 【为什么在这儿】
 * 它本来在「酒馆模式 → 控制面板」里。但那件事本身就是错的：联网检索是**全局**能力 ——
 * 角色卡 / 剧本 / 背景设定起草，外加角色管理 / 表单 / 表格的 AI 补全，全都按这一份走，
 * 跟「扮演协议」「上下文预算」这些酒馆专属设置毫无关系。放在配模型的地方，
 * 作者配完模型顺手就把「要不要联网」定了（老大 2026-09-15 定）。
 *
 * 【为什么自包含】
 * 它原先长在控制面板里、跟那一页的草稿态与保存按钮同生共死。搬出来之后它必须能自己读写、
 * 自己落库 —— 否则又得在「灵感启发」里造一套保存流程。设置项少、写起来便宜，所以直接改完就存。
 */
import { useEffect, useState } from 'react'
import { getSearchSettings, saveSearchSettings } from '../lib/searchSettings'
import {
  searchBlockedReason, SEARCH_MODE_LABEL, SEARCH_ENGINE_LABEL,
  BOCHA_ENDPOINT, SEARXNG_ENDPOINT, DEFAULT_SEARCH_SETTINGS,
  type SearchSettings,
} from '../lib/webSearch'
import { PARAM_GUIDES, bandOf } from '../lib/tavern/paramGuide'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import NumberField from './NumberField'

const BOX = 'bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50'

function Field({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-11 text-ink-200 leading-5">{label}</div>
      <div className="mt-1">{children}</div>
      {hint && <div className="mt-1 text-10 text-ink-500 leading-relaxed">{hint}</div>}
    </div>
  )
}

export default function SearchSettingsPanel() {
  const [s, setS] = useState<SearchSettings | null>(null)
  const [savedAt, setSavedAt] = useState(0)

  useEffect(() => {
    let alive = true
    getSearchSettings()
      .then(v => { if (alive) setS(v) })
      .catch(() => { if (alive) setS({ ...DEFAULT_SEARCH_SETTINGS }) })
    return () => { alive = false }
  }, [])

  /** 改动即落库。数值/ 文本类走 commit（失焦或回车）触发，避免每敲一个字都写一次。 */
  const patch = async (p: Partial<SearchSettings>) => {
    if (!s) return
    const next = { ...s, ...p }
    setS(next)
    try {
      await saveSearchSettings(next)
      setSavedAt(Date.now())
    } catch (e) {
      showToast('联网检索设置保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  if (!s) return null
  const blocked = searchBlockedReason(s)
  const guide = PARAM_GUIDES.searchTopK

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-850/30">
      <div className="shrink-0 px-4 py-3 border-b border-ink-800">
        <div className="flex items-center gap-1.5">
          <h2 className="text-13 text-amber">联网检索</h2>
          <HelpPopover title="联网检索怎么用" width="24rem" size={14}>
            <p>起草 / 补全时用什么素材。三种方式：</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><b>模型已有知识 + 粘贴素材</b>：不联网。知名题材（蒂法、梁祝这类）够用；冷门或原创把资料粘进「参考素材」。</li>
              <li><b>模型自带联网</b>：让模型/中转自己去查。本软件看不到它到底查没查，所以生成后会如实标注「无法确认是否联网」。</li>
              <li><b>搜索接口</b>：本软件先查好再喂给模型 —— 与模型有没有联网能力无关，本地 Ollama 也能用。</li>
            </ul>
            <p className="mt-1.5">
              桌面版由主进程代发请求，不受跨域限制，任何返回 JSON 的搜索接口都能接（含自建 SearXNG）；
              在浏览器里运行时没有这一层，只能用它允许跨域的接口（博查）。
            </p>
            <p className="mt-1.5">
              每次起草 / 补全都会在结果上方如实告诉你「这次到底联没联上」——没联上时会明确说明
              「内容是模型凭已有知识生成的」。
            </p>
          </HelpPopover>
        </div>
        <p className="mt-0.5 text-11 text-ink-500 leading-relaxed">
          全局设置：所有「AI 起草 / 补全」都按这一档取素材。默认关闭 —— 不填任何东西也能用一句话起草。
        </p>
      </div>

      <div className="p-4 space-y-4">
        <Field
          label="检索方式"
          hint="每次起草 / 补全都会如实告诉你本次用的是哪一种，包括没查成的情况。"
        >
          <div className="flex flex-wrap gap-2">
            {(['off', 'model', 'api'] as const).map(m => (
              <Button
                key={m} variant="toggle" size="sm"
                selected={s.mode === m}
                onClick={() => void patch({ mode: m })}
              >
                {SEARCH_MODE_LABEL[m]}
              </Button>
            ))}
          </div>
          <p className="mt-1.5 text-10 leading-relaxed text-ink-500">
            {s.mode === 'off'
              ? '不联网。知名题材模型自己就很熟；冷门或原创靠下面「参考素材」粘进去。'
              : s.mode === 'model'
                ? '让模型自己去查 —— 前提是你选的模型/中转本身支持联网。本软件看不到这一步，生成后的回执会如实说明「无法确认」。'
                : '由本软件先查好再喂给模型 —— 所以跟模型本身有没有联网能力无关，本地 Ollama 也能用。桌面版由主进程代发请求、不受跨域限制；在浏览器里运行时只能用它允许跨域的接口（博查）。'}
          </p>
        </Field>

        {s.mode === 'api' && (
          <>
            <Field
              label="搜索引擎"
              hint="博查要密钥、但开箱可用；SearXNG 是自建免费实例、无密钥无次数限制；自定义接口自己填地址。地址里带 {query} 就按 GET 调用，否则按 POST { query, count }。"
            >
              <select
                className={`${BOX} w-full`}
                value={s.engine}
                onChange={e => void patch({ engine: e.target.value as SearchSettings['engine'] })}
              >
                <option value="bocha">博查（推荐，开箱可用）</option>
                <option value="searxng">SearXNG（自建，免费无限量）</option>
                <option value="custom">自定义接口</option>
              </select>
            </Field>

            {s.engine === 'custom' && (
              <Field label="接口地址" hint={`留空则用博查的默认地址 ${BOCHA_ENDPOINT}`}>
                <input
                  className={`${BOX} w-full`}
                  defaultValue={s.endpoint}
                  onBlur={e => void patch({ endpoint: e.target.value })}
                  placeholder={BOCHA_ENDPOINT}
                />
              </Field>
            )}

            {s.engine === 'searxng' && (
              <Field
                label="接口地址"
                hint={`留空即用 ${SEARXNG_ENDPOINT}。三个前提：① settings.yml 的 search.formats 要加上 json（默认只有 html，不加接口回 403）；② limiter 要设成 false（开着会把本软件的调用当机器人回 429）；③ 端口要与你自己的映射一致。`}
              >
                <input
                  className={`${BOX} w-full`}
                  defaultValue={s.endpoint}
                  onBlur={e => void patch({ endpoint: e.target.value })}
                  placeholder={SEARXNG_ENDPOINT}
                />
              </Field>
            )}

            {s.engine !== 'searxng' && (
              <Field
                label="密钥"
                hint="存在本机数据文件里、不随云盘同步；只有起草时才会带着它去请求搜索接口（该请求会发给对应的搜索服务商）。SearXNG 这类自建实例不需要密钥，选了它这一栏就不显示。"
              >
                <input
                  className={`${BOX} w-full`}
                  defaultValue={s.apiKey}
                  onBlur={e => void patch({ apiKey: e.target.value })}
                  placeholder="sk-…（博查控制台里生成）"
                  autoComplete="off"
                />
              </Field>
            )}

            <Field
              label="每次取几条"
              hint={`范围 ${guide.min}–${guide.max} ${guide.unit}。${bandOf(guide, s.topK).effect}`}
            >
              {/* 受控 + 失焦钳制：原来是 defaultValue（非受控），切换搜索模式导致范围变化时
                  输入框不会跟着更新，显示值可能与实际生效值不一致。 */}
              <NumberField
                value={s.topK}
                min={guide.min} max={guide.max} step={guide.step}
                className={`${BOX} w-28`}
                onChange={v => { const n = v ?? s.topK; if (n !== s.topK) void patch({ topK: n }) }}
              />
            </Field>
          </>
        )}

        {/* 当前档 + 问题提示：**两件事都要说**，别写成互斥分支 */}
        <div className="text-10 leading-relaxed">
          <p className="text-ink-400">
            当前：{SEARCH_MODE_LABEL[s.mode]}
            {s.mode === 'api' && `（${SEARCH_ENGINE_LABEL[s.engine]}）`}
            —— 起草 / 补全时按这一档执行
          </p>
          {blocked && <p className="mt-0.5 text-amber">⚠️ {blocked}</p>}
          {savedAt > 0 && <p className="mt-0.5 text-ink-600">改动已自动保存</p>}
        </div>
      </div>
    </section>
  )
}
