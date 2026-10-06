/**
 * 故事剧本 · **「导入 / 导出」弹窗**（2026-10-06）
 *
 * 【为什么是「粘贴 + 解析」而不是「AI 整理」】
 * 主人拍板：**给规定模板、要求按模板导**（不做 AI 兜底）——
 * 模板由 `storyImport.ts` 的 `IMPORT_TEMPLATE` 提供（唯一真源，改格式只动那一处），
 * 认不出来就**如实报第几行缺什么**，绝不猜。
 *
 * 【一条硬约束】一份文本＝**一个故事**。多个故事请分开导 ——
 * 落地语义是「导入即新建一个故事」，半路冒出第二个没地方放（解析层已直接报错）。
 *
 * 本组件只负责「搬运 + 确认」，正确性全在 `lib/tavern/storyImport.ts`（有全量单测）。
 */
import { useMemo, useState } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import { showToast, copyText } from './dialogs'
import { uid } from '../lib/id'
import { parseStoryImport, IMPORT_TEMPLATE, type ParseResult } from '../lib/tavern/storyImport'
import { createStory, saveStory, listStories, STORY_NAME_MAX, STORY_SETTING_MAX } from '../lib/tavern/story'
import { createScript } from '../lib/tavern/script'
import { emptyWorldEntry } from '../lib/tavern/worldBook'

interface Props {
  open: boolean
  onClose: () => void
  /** 导入成功后：刷新列表并打开新故事（由父级承接） */
  onImported: (storyId: string) => void
}

export default function TavernScriptImportDialog({ open, onClose, onImported }: Props) {
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)

  /** 实时解析（空文本不解析，免得一开弹窗就先报一串错） */
  const parsed: ParseResult | null = useMemo(
    () => (raw.trim() ? parseStoryImport(raw) : null),
    [raw],
  )

  const copyTemplate = async () => {
    await copyText(IMPORT_TEMPLATE, '模板已复制 —— 直接粘给 AI，或填好后粘回上面的框里')
  }

  const doImport = async () => {
    if (!parsed?.ok) return
    setBusy(true)
    try {
      const d = parsed.data

      // ① 故事（同名加序号 —— 不覆盖，也不让列表里出现两个一模一样的名字）
      const stories = await listStories()
      const base = (d.storyName || '未命名故事').slice(0, STORY_NAME_MAX)
      let name = base
      if (stories.some(s => s.name === name)) {
        let n = 2
        while (stories.some(s => s.name === `${base} (${n})`)) n++
        name = `${base} (${n})`
      }
      const story = await createStory({ name })

      // ② 词条（逐个补 id；空名给个占位，免得列表里全是空白条目）
      const entries = d.entries.map(e => ({
        ...emptyWorldEntry(),
        id: uid(),
        ...e,
        title: e.title.trim() || '（未命名词条）',
      }))
      await saveStory({
        ...story,
        name,
        setting: d.setting.slice(0, STORY_SETTING_MAX),
        entries,
      })

      // ③ 剧本（逐个建在这个故事下；各栏超上限时截断，预览里已提前告知过）
      for (const sc of d.scripts) {
        await createScript({ ...sc, storyId: story.id })
      }

      showToast(`已导入「${name}」：词条 ${entries.length} 条 · 剧本 ${d.scripts.length} 份`)
      setRaw('')
      onImported(story.id)
      onClose()
    } catch (e) {
      showToast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const errors = parsed && !parsed.ok ? parsed.issues.filter(i => i.level === 'error') : []
  const warns = parsed?.issues.filter(i => i.level === 'warn') ?? []

  return (
    <Modal open={open} onClose={onClose} title="导入故事 / 剧本" width="lg">
      <div className="space-y-3">
        <div className="rounded-md border border-amber/35 bg-amber/8 px-3 py-2 text-11 leading-relaxed text-ink-300">
          把按模板写好的文本粘进来。一份文本＝<b className="text-ink-200">一个故事</b>
          （含它下面的全部词条与剧本）—— 多个故事请分开导入。
          <span className="text-amber/90"> 认不出标记就会报「第几行缺什么」，绝不猜。</span>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copyTemplate()}>复制模板</Button>
          {raw && <Button variant="secondary" size="sm" onClick={() => setRaw('')}>清空</Button>}
          <span className="flex-1" />
          <span className="text-11 text-ink-500">{raw.trim() ? `${raw.length} 字` : '还没粘贴内容'}</span>
        </div>

        <AutoTextarea
          value={raw}
          onChange={setRaw}
          minRows={9}
          maxHeight={300}
          disabled={busy}
          placeholder={'把文本粘贴到这里 —— 先点「复制模板」拿格式，填好后整段粘回来。'}
          className="w-full resize-none rounded-md border border-ink-700 bg-ink-900 px-2.5 py-2 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
        />

        {/* ---------- 解析结果 ---------- */}
        {parsed && (
          <div className="rounded-md border border-ink-700 bg-ink-900/60 px-3 py-2">
            {parsed.ok ? (
              <div className="space-y-1 text-12 text-ink-300">
                <div className="text-ink-100">
                  将导入：<b>{parsed.data.storyName || '（未命名故事）'}</b>
                </div>
                <div>
                  世界设定 {parsed.data.setting.length} 字 · 词条 {parsed.data.entries.length} 条 ·
                  剧本 {parsed.data.scripts.length} 份
                </div>
                {parsed.data.entries.length > 0 && (
                  <div className="text-11 text-ink-500">
                    词条：{parsed.data.entries.map(e => e.title || '（未命名）').join(' / ').slice(0, 80)}
                  </div>
                )}
                {parsed.data.scripts.length > 0 && (
                  <div className="text-11 text-ink-500">
                    剧本：{parsed.data.scripts.map(s => s.name || '（未命名）').join(' / ').slice(0, 80)}
                  </div>
                )}
              </div>
            ) : (
              <ul className="space-y-1 text-12 text-danger">
                {errors.map((e, i) => (
                  <li key={i}>{e.line ? `第 ${e.line} 行：` : ''}{e.message}</li>
                ))}
              </ul>
            )}

            {warns.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-ink-800 pt-2 text-11 leading-relaxed text-amber">
                {warns.map((w, i) => (
                  <li key={i}>{w.line ? `第 ${w.line} 行：` : ''}{w.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <span className="flex-1" />
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>取消</Button>
          <Button
            variant="primary" size="md"
            disabled={!parsed?.ok || busy}
            title={parsed?.ok ? '把上面解析出来的内容建成一个新故事' : '先粘贴符合模板的文本'}
            onClick={() => void doImport()}
          >
            {busy ? '导入中…' : '导入'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
