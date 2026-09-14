/**
 * 酒馆模式 · 剧本新建/编辑弹窗
 *
 * 【为什么要有它】
 * 「新建对话」里要选剧本，而作者第一次打开时列表是空的 —— 如果只能跳去「剧本编辑」页签写，
 * 就会卡在「想开一场戏，却要先离开这个弹窗、去另一个页签、写完再回来重开对话框」。
 * 所以就地给一个入口：同一个六栏表单（`TavernScriptFields`，与页签共用一份），写完直接选中。
 *
 * 【与页签的分工】
 * 弹窗只做「新建 / 快速改一份」，不做列表管理与删除 —— 那些是页签的事。
 * 表单共用是为了**两边永远一致**（各写一份必然会漂移，这个项目在别处已经栽过）。
 */
import { useEffect, useMemo, useState } from 'react'
import { showToast } from './dialogs'
import { Button } from './Button'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import TavernScriptFields from './TavernScriptFields'
import { RefsField, SearchPlanLine, DraftSourceLine, useSearchSettings } from './DraftBits'
import {
  draftScript, saveScript, mergeScriptDraft, EMPTY_SCRIPT_FIELDS, scriptToText, snapshotOf,
  isEmptyScriptFields, type ScriptDraftFields,
} from '../lib/tavern/script'
import type { DraftSource } from '../lib/tavern/draft'
import type { TavernScript } from '../lib/tavern/types'

export default function TavernScriptDialog({ open, onClose, onSaved, editing }: {
  open: boolean
  onClose: () => void
  /** 保存成功 → 把新剧本交回调用方（新建对话那边会立刻选中它） */
  onSaved: (s: TavernScript) => void
  /** 传入 = 编辑这一份；不传 = 新建 */
  editing?: TavernScript | null
}) {
  const [fields, setFields] = useState<ScriptDraftFields>(EMPTY_SCRIPT_FIELDS)
  const [seed, setSeed] = useState('')
  const [refs, setRefs] = useState('')
  const [lastSource, setLastSource] = useState<DraftSource | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const search = useSearchSettings()

  useEffect(() => {
    if (!open) return
    setSeed('')
    setRefs('')
    setLastSource(null)
    setDrafting(false)
    setSaving(false)
    setFields(editing
      ? {
        name: editing.name, situation: editing.situation, opening: editing.opening,
        playerRole: editing.playerRole, goal: editing.goal, taboo: editing.taboo,
      }
      : EMPTY_SCRIPT_FIELDS)
  }, [open, editing])

  const patch = (p: Partial<ScriptDraftFields>) => setFields(prev => ({ ...prev, ...p }))
  const preview = useMemo(
    () => scriptToText(snapshotOf({ ...EMPTY_SCRIPT_FIELDS, ...fields, id: editing?.id ?? 'preview' } as TavernScript)),
    [fields, editing],
  )
  const empty = isEmptyScriptFields(fields)

  const runDraft = async () => {
    setDrafting(true)
    try {
      const { fields: out, source } = await draftScript({
        seed, refs,
        ...(search ? { searchSettings: search } : {}),
      })
      setFields(prev => mergeScriptDraft(prev, out))
      setLastSource(source)
      showToast(`已生成六栏（${source.label}）—— 过一遍再保存`)
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setDrafting(false)
    }
  }

  const submit = async () => {
    setSaving(true)
    try {
      const saved = await saveScript(editing ? { ...editing, ...fields } : {
        ...EMPTY_SCRIPT_FIELDS, ...fields, id: '', draftedAt: 0, createdAt: 0, updatedAt: 0,
      })
      showToast(`已保存「${saved.name || '未命名剧本'}」`)
      onSaved(saved)
      onClose()
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open} onClose={onClose} title={editing ? '编辑剧本' : '新建剧本'} width="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[11px] text-ink-500">
            {empty ? '六栏全空 —— 保存了也不会进上下文' : `每轮注入约 ${preview.length} 字（开场白单列一条消息）`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
            <Button variant="primary" size="md" disabled={saving || empty} onClick={() => void submit()}>
              {saving ? '保存中…' : '保存并选用'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="min-h-0">
          <TavernScriptFields value={fields} onChange={patch} />
        </div>
        <aside className="space-y-3">
          <div className="rounded-lg border border-amber/25 bg-amber/5 p-3">
            <div className="text-[12px] text-amber">AI 起草</div>
            <p className="mt-1 text-[10.5px] text-ink-400 leading-relaxed">
              写一句你想要的戏，AI 补全六栏（不会覆盖你已经写好的内容）。
            </p>
            <AutoTextarea
              value={seed}
              onChange={setSeed}
              minRows={3}
              maxHeight={180}
              placeholder="例：雨夜便利店，她是夜班店员，我是每天来买烟的人。今天她忽然锁了烟柜。"
            />
            <div className="mt-2">
              <RefsField value={refs} onChange={setRefs} minRows={2} />
            </div>
            <SearchPlanLine settings={search} />
            <Button
              variant="primary" size="md" className="mt-2 w-full"
              disabled={drafting || (!seed.trim() && !refs.trim())}
              onClick={() => void runDraft()}
            >
              {drafting ? '正在生成…' : '一键起草'}
            </Button>
            <DraftSourceLine source={lastSource} />
          </div>
          <div className="rounded-lg border border-ink-800 bg-ink-850/30 p-3">
            <div className="text-[12px] text-ink-200">注入预览</div>
            <pre className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900/60 p-2 text-[10.5px] leading-relaxed text-ink-400">
              {preview || '（空）'}
            </pre>
          </div>
        </aside>
      </div>
    </Modal>
  )
}
