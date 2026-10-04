import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import AutoTextarea from './AutoTextarea'
import AIDataSourceNote from './AIDataSourceNote'
import { useTaskRunner } from '../lib/aiTaskCenter'
import { showToast } from './dialogs'
import { getAllChapters } from '../lib/db'
import {
  extractFingerprint, loadFingerprints, loadActiveFingerprintId,
  saveActiveFingerprintId, upsertFingerprint, removeFingerprint, metricsLine,
  MIN_SAMPLE_WORDS, type StyleProfile,
} from '../lib/styleFingerprint'

/** 一次最多投喂多少字参考文本（再多对提炼几乎没增量，只是白烧额度） */
const MAX_SAMPLE_CHARS = 12000

/**
 * 「文风档」管理窗（2.8.0 · 台账 #015）。
 *
 * 三块：① 从参考文本提炼（粘贴 / 导入 txt / 从已有章节取）② 档列表（启用 / 重命名 / 删除）
 * ③ 选中档的预览（量化特征 + AI 归纳）与作者补充 note。
 *
 * 🔴 两条纪律：
 *   · 提炼走 `aiTaskCenter`（kind `style-fingerprint-extract`）—— **可切页签、可中止**，不占住弹窗；
 *   · 新档**不自动启用** —— 是否让 AI 按这份味道写，由作者自己按（与「默认一条不勾」同一条精神）。
 */
export function StyleProfileDialog({ open, onClose, ownerTab, onChanged }: {
  open: boolean
  onClose: () => void
  /** 发起任务的页签 id（`editor` / `creative-writing`）—— 指示器「点回去看」靠它 */
  ownerTab: string
  /** 档列表或启用状态变化时回调（调用方刷新自己的下拉） */
  onChanged?: () => void
}) {
  const [list, setList] = useState<StyleProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [picked, setPicked] = useState('')
  const [sample, setSample] = useState('')
  const [name, setName] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [chapters, setChapters] = useState<{ id: string; title: string; content: string }[]>([])
  const [chapterPick, setChapterPick] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  /** 已处理的完成结果 task id（防同一条结果被重复落库） */
  const handled = useRef('')

  const t = useTaskRunner<StyleProfile>({
    ownerTab, kind: 'style-fingerprint-extract', title: '提炼文风档',
    writes: ['meta:styleFingerprints'],
  })

  const reload = useCallback(async () => {
    const [ls, id] = await Promise.all([loadFingerprints(), loadActiveFingerprintId()])
    setList(ls)
    setActiveId(id)
    setPicked(p => (ls.some(x => x.id === p) ? p : (ls[0]?.id ?? '')))
    return ls
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      await reload()
      try {
        const chs = await getAllChapters()
        if (!cancelled) setChapters(chs.map(c => ({ id: c.id, title: c.title, content: c.content ?? '' })))
      } catch { /* 章节目录读不到不影响粘贴 / 导入两条路 */ }
    })()
    return () => { cancelled = true }
  }, [open, reload])

  // 选中的档变化 → 同步 note 草稿
  const cur = list.find(x => x.id === picked) ?? null
  useEffect(() => { setNoteDraft(cur?.note ?? '') }, [cur?.id, cur?.note])

  // 提炼完成 → 落库 + 选中新档（🔴 不自动启用）
  useEffect(() => {
    const tk = t.task
    const res = t.result
    if (!tk || tk.status !== 'done' || !res) return
    if (handled.current === tk.id) return
    handled.current = tk.id
    void (async () => {
      const ls = await upsertFingerprint(res)
      setList(ls)
      setPicked(res.id)
      setSample('')
      setName('')
      onChanged?.()
      showToast(`已生成文风档「${res.name}」—— 点右边的「启用」才会生效`, 'success')
    })()
  }, [t.task, t.result, onChanged])

  useEffect(() => {
    if (t.task?.status === 'failed' && t.error) showToast(`提炼失败：${t.error}`, 'error')
  }, [t.task, t.error])

  const takeChapter = (id: string) => {
    setChapterPick(id)
    const ch = chapters.find(c => c.id === id)
    if (ch?.content?.trim()) setSample(ch.content.slice(0, MAX_SAMPLE_CHARS))
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''                      // 允许重选同一个文件
    if (!f) return
    try {
      const text = await f.text()
      setSample(text.slice(0, MAX_SAMPLE_CHARS))
    } catch {
      showToast('读取文件失败 —— 也可以直接把文本粘贴进来', 'error')
    }
  }

  const runExtract = () => {
    const texts = sample.trim() ? [sample] : []
    if (!texts.length) { showToast('先粘贴参考文本，或从章节 / 文件导入', 'info'); return }
    t.run(
      ctx => extractFingerprint(texts, { name, signal: ctx.signal }),
      () => null,                            // 完成提示由上面的 useEffect 给出（要说清"还需要手动启用"）
    )
  }

  const toggleActive = async (id: string) => {
    const next = activeId === id ? '' : id
    await saveActiveFingerprintId(next)
    setActiveId(next)
    onChanged?.()
    showToast(next ? '已启用该文风档 —— 续写 / 整章改写 / 伴写都会按它落笔' : '已停用文风档 —— 回到不使用文风档的状态', 'success')
  }

  const renamePicked = async (v: string) => {
    if (!cur || v.trim() === cur.name) return
    const next = { ...cur, name: v.trim() || cur.name }
    setList(await upsertFingerprint(next))
    onChanged?.()
  }

  const saveNote = async () => {
    if (!cur) return
    const next = { ...cur, note: noteDraft }
    if ((cur.note ?? '') === noteDraft) return
    setList(await upsertFingerprint(next))
    onChanged?.()
  }

  const del = async (id: string) => {
    const target = list.find(x => x.id === id)
    setList(await removeFingerprint(id))
    setActiveId(prev => (prev === id ? '' : prev))
    onChanged?.()
    showToast(`已删除文风档「${target?.name ?? ''}」`, 'success')
  }

  const sampleWords = sample.trim().length

  return (
    <Modal open={open} onClose={onClose} title="文风档" width="lg">
      <div className="space-y-4">
        <p className="text-ink-400 text-12 leading-relaxed">
          喂给 AI 一两段参考文本，这边会先做本地统计（句长 / 对白占比 / 标点密度…），再让模型归纳成「文风特征」，
          存成一份可命名的文风档。启用后，<span className="text-ink-200">续写、整章改写、AI 伴写</span>三处都会按这份味道落笔。
          没启用任何档时，行为与以前完全一样。
        </p>
        <AIDataSourceNote feature="style-fingerprint" />

        {/* ① 提炼 */}
        <div className="space-y-2 rounded-lg border border-ink-700 bg-ink-800/40 p-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-ink-200 text-12">从参考文本提炼</span>
            <span className="text-ink-500 text-10">建议 300 字以上；至少 {MIN_SAMPLE_WORDS} 字</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={chapterPick}
              onChange={e => takeChapter(e.target.value)}
              className="bg-ink-800 border border-ink-700 rounded px-2 py-1 text-11 text-ink-100 outline-none focus:border-amber/40 max-w-[220px]"
            >
              <option value="">从已有章节取…</option>
              {chapters.map(c => <option key={c.id} value={c.id}>{c.title || '(无标题)'}</option>)}
            </select>
            <Button variant="secondary" size="xs" onClick={() => fileRef.current?.click()}>导入 txt</Button>
            <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={onFile} />
            <span className="text-ink-500 text-10">已填 {sampleWords} 字</span>
          </div>
          <AutoTextarea
            value={sample}
            onChange={v => setSample(v.slice(0, MAX_SAMPLE_CHARS))}
            minHeight={90}
            maxHeight={220}
            placeholder="把想模仿的那几段文字粘贴在这里（自己的旧作、喜欢的小说片段都行 —— 只学风格，不会照搬句子）"
            className="!px-3 !py-2 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 focus:border-amber/40 outline-none placeholder:text-ink-600 w-full"
          />
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="档名（可留空）"
              className="flex-1 bg-ink-800 border border-ink-700 rounded px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/40 placeholder:text-ink-600"
            />
            <Button variant="primary" size="sm" onClick={runExtract} disabled={t.running || !sample.trim()}>
              {t.running ? '提炼中…' : '提炼'}
            </Button>
            {t.running && <Button variant="secondary" size="sm" onClick={t.stop}>中止</Button>}
          </div>
        </div>

        {/* ② 档列表 */}
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-ink-200 text-12">我的文风档</span>
            <span className="text-ink-500 text-10">全局保存，换项目也在；一次只启用一份</span>
          </div>
          {!list.length && (
            <div className="text-ink-500 text-11 rounded border border-dashed border-ink-700 px-3 py-3 text-center">
              还没有文风档 —— 上面粘贴一段文字，点「提炼」生成第一份。
            </div>
          )}
          {list.length > 0 && (
            <div className="divide-y divide-ink-700/60 rounded border border-ink-700 overflow-hidden">
              {list.map(p => {
                const on = p.id === activeId
                return (
                  <div key={p.id} className="flex items-center gap-2 px-2.5 py-2 bg-ink-800/30">
                    <button
                      onClick={() => setPicked(p.id)}
                      className={`flex-1 text-left text-12 truncate ${p.id === picked ? 'text-amber' : 'text-ink-100'} hover:text-amber`}
                      title="点击查看这份档的详情"
                    >
                      {p.name}
                    </button>
                    <span className="text-ink-500 text-10 shrink-0">
                      {p.sampleChars ? `${p.sampleChars} 字样本` : '手动档'}
                    </span>
                    <Button variant="toggle" size="xs" selected={on} onClick={() => void toggleActive(p.id)}>
                      {on ? '已启用' : '启用'}
                    </Button>
                    <Button variant="secondary" size="xs" onClick={() => void del(p.id)}>删除</Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ③ 选中档预览 */}
        {cur && (
          <div className="space-y-2 rounded-lg border border-ink-700 bg-ink-800/40 p-3">
            <div className="flex items-center gap-2">
              <span className="text-ink-500 text-10 shrink-0">档名</span>
              <input
                defaultValue={cur.name}
                onBlur={e => void renamePicked(e.target.value)}
                className="flex-1 bg-ink-800 border border-ink-700 rounded px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/40"
              />
            </div>
            {cur.aiSummary && <p className="text-ink-300 text-12 leading-relaxed whitespace-pre-wrap">{cur.aiSummary}</p>}
            {cur.traits.length > 0 && <ProfileLine label="用词倾向" items={cur.traits} />}
            {cur.dos.length > 0 && <ProfileLine label="宜" items={cur.dos} />}
            {cur.donts.length > 0 && <ProfileLine label="忌" items={cur.donts} />}
            <div className="text-ink-500 text-10 leading-relaxed">{metricsLine(cur.metrics)}</div>
            {cur.metrics.repeatedWords.length > 0 && (
              <div className="text-ink-500 text-10">高频重复词：{cur.metrics.repeatedWords.join('、')}</div>
            )}
            <div className="space-y-1 pt-1 border-t border-ink-700">
              <div className="flex items-baseline gap-1.5">
                <span className="text-ink-200 text-12">作者补充</span>
                <span className="text-ink-500 text-10">可编辑；注入时优先级最高（盖过 AI 归纳）</span>
              </div>
              <AutoTextarea
                value={noteDraft}
                onChange={setNoteDraft}
                minHeight={52}
                maxHeight={140}
                placeholder="例如：对白要短、少用书面连接词"
                className="!px-3 !py-2 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 focus:border-amber/40 outline-none placeholder:text-ink-600 w-full"
              />
              <div className="flex justify-end">
                <Button variant="secondary" size="xs" disabled={noteDraft === (cur.note ?? '')} onClick={() => void saveNote()}>
                  保存补充
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-ink-700">
          <div className="text-ink-500 text-10 leading-relaxed">
            只学风格特征，不会照搬参考文本里的句子；参考文本不写入项目数据。
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Modal>
  )
}

function ProfileLine({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="text-12 leading-relaxed">
      <span className="text-ink-500">{label}：</span>
      <span className="text-ink-200">{items.join('；')}</span>
    </div>
  )
}
