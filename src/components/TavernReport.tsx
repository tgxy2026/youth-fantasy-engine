/**
 * 酒馆模式 · 推演报告（tavern-report）
 *
 * 定位：剧情模式的产出。方案 §8.2 的布局 —— 左列表、右详情，三档 findings 分组。
 *
 * 🔑 每条 finding 提供**跳转到对应条目**：派发 `yfe:navigate` 事件（detail 为 { tabId, rowId }），
 *    App 侧会切页签并把该行高亮 —— 这是「报告必须能指回具体条目」这条规矩的最后一环，
 *    否则作者拿着一堆描述也找不到该改哪里。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as store from '../lib/tavern/store'
import { confirmDialog, showToast } from './dialogs'
import { Button } from './Button'
import TavernExportDialog from './TavernExportDialog'
import { reportDocModel } from '../lib/tavern/exportDoc'
import { TABS } from '../lib/schema'
import type { TavernReport as Report, TavernFinding, TavernReportIndexItem } from '../lib/tavern/types'

const LEVEL_STYLE: Record<TavernFinding['level'], string> = {
  矛盾: 'text-red-400 border-red-400/30 bg-red-400/10',
  漏洞: 'text-amber border-amber/30 bg-amber/10',
  存疑: 'text-ink-400 border-ink-600 bg-ink-800',
}
const LEVELS: TavernFinding['level'][] = ['矛盾', '漏洞', '存疑']

const tabName = (id: string) => TABS.find(t => t.id === id)?.name ?? id

/**
 * 报告名：默认「推演标题 + 报告」。
 * 同一场推演可以反复结束、生成多份报告，光显示推演标题会分不清是哪一份；
 * 末尾补「报告」二字既点明它是报告，也让左侧列表一眼能对上号。
 */
const reportName = (sessionTitle: string) =>
  (sessionTitle.endsWith('报告') ? sessionTitle : `${sessionTitle} · 报告`)

export default function TavernReport() {
  const [list, setList] = useState<TavernReportIndexItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  /** 左栏筛选词（报告攒多了一行行找太慢） */
  const [q, setQ] = useState('')
  /** 导出文档弹窗（B5） */
  const [exportOpen, setExportOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setList(await store.listReports())
    } catch {
      showToast('读取报告列表失败', 'error')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    let alive = true
    if (!activeId) { setReport(null); return }
    void store.getReport(activeId).then(r => { if (alive) setReport(r) })
    return () => { alive = false }
  }, [activeId])

  /** 跳到该 finding 指向的表与行（App 侧会切页签并高亮） */
  const jumpTo = (f: TavernFinding) => {
    if (!f.targetTabId) return
    window.dispatchEvent(new CustomEvent('yfe:navigate', {
      detail: { tabId: f.targetTabId, rowId: f.targetRecordId },
    }))
  }

  const removeReport = async () => {
    if (!report) return
    const okDel = await confirmDialog({ title: '删除这份报告？', message: `「${report.sessionTitle}」的推演报告将被删除，不可恢复。`, confirmText: '删除' })
    if (!okDel) return
    await store.deleteReport(report.id)
    setActiveId('')
    setReport(null)
    await refresh()
    showToast('已删除')
  }

  const grouped = (r: Report) => LEVELS.map(lv => ({ lv, items: r.findings.filter(f => f.level === lv) }))

  /** 左栏列表：按报告名 / 锚点章名过滤 */
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return list
    return list.filter(it =>
      `${reportName(it.sessionTitle)} ${it.anchorChapterLabel}`.toLowerCase().includes(kw))
  }, [list, q])

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50">推演报告</h1>
        <p className="text-[12px] text-ink-400 mt-1">
          每场推演结束后的合理性报告。每条问题尽量指向具体角色卡或表格条目，点「定位」可直接跳过去。
        </p>
      </header>

      {list.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-[13px] text-ink-300">还没有推演报告</p>
            <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
              去「剧情推演」演完一场，点「结束推演」，报告就会出现在这里。
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-3 pt-3">
          {/* 左栏：报告列表（名称默认「推演标题 + 报告」） */}
          <aside className="flex w-72 shrink-0 flex-col gap-2 rounded-lg border border-ink-800 bg-ink-850/40 p-3">
            {list.length > 4 && (
              <input
                className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-[11.5px] text-ink-100 outline-none focus:border-amber/50"
                placeholder="筛选报告（标题 / 锚点）"
                value={q}
                onChange={e => setQ(e.target.value)}
              />
            )}
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {rows.map(it => {
                const active = activeId === it.id
                const total = it.counts['矛盾'] + it.counts['漏洞'] + it.counts['存疑']
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => setActiveId(it.id)}
                    className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors ${
                      active ? 'border-amber/40 bg-amber/10' : 'border-transparent hover:bg-ink-800/60'
                    }`}
                  >
                    <div className={`truncate text-[12px] ${active ? 'text-amber' : 'text-ink-100'}`}>
                      {reportName(it.sessionTitle)}
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-ink-500">{it.anchorChapterLabel || '（无锚点）'}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10.5px]">
                      {it.counts['矛盾'] > 0 && <span className="text-red-400">矛盾 {it.counts['矛盾']}</span>}
                      {it.counts['漏洞'] > 0 && <span className="text-amber">漏洞 {it.counts['漏洞']}</span>}
                      {it.counts['存疑'] > 0 && <span className="text-ink-400">存疑 {it.counts['存疑']}</span>}
                      {total === 0 && <span className="text-ink-500">未发现问题</span>}
                      <span className="ml-auto shrink-0 text-ink-600">{new Date(it.createdAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                )
              })}
              {rows.length === 0 && (
                <p className="px-1 py-2 text-[11px] leading-relaxed text-ink-500">没有匹配的报告。</p>
              )}
            </div>
            <div className="shrink-0 border-t border-ink-800 pt-2 text-[10.5px] text-ink-500">共 {list.length} 份</div>
          </aside>

          {/* 右栏：详情 */}
          <div className="flex-1 min-w-0 overflow-y-auto rounded-lg border border-ink-800 p-4">
            {!report ? (
              <div className="text-center text-[12px] text-ink-500 py-10">从左边选一份报告</div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold text-ink-50 truncate">{reportName(report.sessionTitle)}</h2>
                    <div className="mt-0.5 text-[11px] text-ink-500">
                      {report.anchorChapterLabel || '（无锚点）'} · {report.mode === 'immersive' ? '沉浸推演' : '导演推演'} ·
                      {' '}{new Date(report.createdAt).toLocaleString()}
                    </div>
                    {report.cast.length > 0 && (
                      <div className="mt-1 text-[11px] text-ink-500">
                        {report.cast.map(c => `${c.name}（${c.role === 'user' ? '你演' : c.role === 'ai' ? 'AI 演' : '在场'}）`).join('、')}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary" size="md" className="text-[12px]"
                      onClick={() => setExportOpen(true)}
                      title="把这份报告导出成 Markdown 或带样式的单文件 HTML"
                    >
                      导出
                    </Button>
                    <Button variant="ghost" size="md" className="text-[12px]" onClick={removeReport}>删除</Button>
                  </div>
                </div>

                <section className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                  <div className="text-[11px] text-ink-500 mb-1">概览</div>
                  <div className="text-[13px] text-ink-200 leading-relaxed whitespace-pre-wrap">{report.overview}</div>
                </section>

                {report.findings.length === 0 ? (
                  <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-4 text-center text-[12px] text-ink-400">
                    这一场没有发现问题 —— 角色反应与设定是自洽的。
                  </div>
                ) : (
                  grouped(report).map(({ lv, items }) => items.length === 0 ? null : (
                    <section key={lv}>
                      <div className={`inline-block rounded px-2 py-0.5 text-[11px] border ${LEVEL_STYLE[lv]}`}>
                        {lv} · {items.length} 条
                      </div>
                      <div className="mt-2 space-y-2">
                        {items.map(f => (
                          <div key={f.id} className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                {f.targetLabel && (
                                  <div className="text-[11.5px] text-ink-400">
                                    {f.targetTabId ? tabName(f.targetTabId) : '（未能定位）'}
                                    {f.targetLabel ? ` · ${f.targetLabel}` : ''}
                                  </div>
                                )}
                                <div className="mt-0.5 text-[13px] text-ink-100 leading-relaxed">{f.detail}</div>
                                {f.suggestion && (
                                  <div className="mt-1 text-[12px] text-ink-400 leading-relaxed">建议：{f.suggestion}</div>
                                )}
                              </div>
                              {f.targetTabId && f.targetRecordId && (
                                <Button variant="secondary" size="md" className="shrink-0 text-[12px]" onClick={() => jumpTo(f)}>
                                  定位
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))
                )}

                <div className="border-t border-ink-800 pt-2 text-[11px] text-ink-500">
                  报告只做诊断，不会写回任何项目表 —— 是否采纳由你决定。
                  {report.findings.some(f => f.level === '存疑') && ' 「存疑」是模型有疑虑但指不出具体条目的部分，未必是错。'}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {report && (
        <TavernExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          docTitle={`${report.sessionTitle} · 推演报告`}
          kindLabel="推演报告"
          metaLabel="附报告信息"
          metaHint="锚点、推演类型、参演角色与生成时间 —— 报告攒多了也能一眼认出是哪一份。"
          summary={o => {
            const total = report.findings.length
            return [
              total === 0 ? '未发现问题' : `共 ${total} 条问题（矛盾 ${report.findings.filter(f => f.level === '矛盾').length} · 漏洞 ${report.findings.filter(f => f.level === '漏洞').length} · 存疑 ${report.findings.filter(f => f.level === '存疑').length}）`,
              o.withMeta ? '附报告信息' : '',
            ].filter(Boolean).join(' · ')
          }}
          build={o => reportDocModel(report, tabName, o)}
        />
      )}
    </div>
  )
}
