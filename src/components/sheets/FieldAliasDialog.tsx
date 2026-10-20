/**
 * 字段显示名 · 改名弹窗（2.7.3 · 表格 / 表单 / 卡片三类页签共用）
 *
 * 🔴 只改「界面显示的名字」，**不动存储键**（表格＝列名，表单与卡片＝`模块名::字段名`）
 *    —— 已填的数据一行都不会丢，想改回默认把输入框清空即可。
 *
 * 🔴🔴 3.2.0 · T3 起，改名会同步给 AI（模型按**当前名称**理解这一项），所以必须区分两件事：
 *    · 只是换个叫法（所属势力 → 效忠组织）⇒「含义不变」，原用途照常运行；
 *    · 字段含义也变了（修炼境界 → 社会声望）⇒「含义已改变」并写明新含义。
 *    历史别名迁移来的改名默认「待确认」，不替作者默认任何一边；未确认前该字段不进入
 *    AI 上下文 / 索引 / 补全目标（界面照常显示）。
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, RotateCcw, Save, Type } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import HelpPopover from '@/components/common/HelpPopover'
import { MAX_ALIAS_LEN, sanitizeAliases, validateAliasInput, type AliasMap } from '@/lib/settings/fieldAlias'
import type { MeaningDecision, PendingRename } from '@/lib/templates/useFieldRenames'
import { foldVh } from '@/lib/settings/theme'

/** 弹窗的一项＝一个可改名的字段 */
export interface AliasTarget {
  /** 存储键（表格＝列名；表单与卡片＝`模块名::字段名`） */
  key: string
  /** 界面上展示的原名（表单里只显示字段名，不带「模块::」前缀） */
  label: string
  /** 提醒用：这一项原本能填什么 */
  hint: string
  /** 所属分组（表单的模块名）；表格类不传 ⇒ 弹窗按单组展示 */
  group?: string
}

export default function FieldAliasDialog({
  title,
  intro,
  targets,
  initial,
  pending,
  onSave,
  onClose,
}: {
  title: string
  /** 顶部那句说明（各页签自己写，如「填的是这一页的字段」） */
  intro: string
  targets: AliasTarget[]
  /** 当前显示名（存储键 → 名字；只含改过名的，未改名的留空回退原名） */
  initial: AliasMap
  /** 待确认含义的改名（历史别名迁移来的） */
  pending?: Record<string, PendingRename>
  onSave: (next: AliasMap, meanings: Record<string, MeaningDecision>) => Promise<void> | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<AliasMap>(() => ({ ...initial }))
  const [meanings, setMeanings] = useState<Record<string, MeaningDecision>>({})
  const [formErr, setFormErr] = useState('')
  const [saving, setSaving] = useState(false)

  const keys = useMemo(() => targets.map(t => t.key), [targets])
  const clean = useMemo(() => sanitizeAliases(keys, draft), [keys, draft])
  const renamed = Object.keys(clean)

  /** 按分组归拢（无分组的表格类 ⇒ 合成一组，顺序即列顺序） */
  const groups = useMemo(() => {
    const out: { name: string; items: AliasTarget[] }[] = []
    for (const t of targets) {
      const g = t.group ?? ''
      const last = out[out.length - 1]
      if (last && last.name === g) last.items.push(t)
      else out.push({ name: g, items: [t] })
    }
    return out
  }, [targets])

  /** 逐行实时校验：只提示，不拦着打字 */
  const errOf = (key: string): string | null => {
    const input = draft[key] ?? ''
    if (!input.trim()) return null
    return validateAliasInput(keys, draft, key, input)
  }

  const pendingKeys = useMemo(
    () => Object.keys(pending ?? {}).filter(k => targets.some(t => t.key === k)),
    [pending, targets],
  )
  /** 输入框被清空的待确认项＝作者选择恢复原名，不再需要确认含义 */
  const livePending = pendingKeys.filter(k => (draft[k] ?? '').trim())
  const undecided = livePending.filter(k => !meanings[k])

  const setMeaning = (key: string, m: MeaningDecision) => {
    setFormErr('')
    setMeanings(prev => ({ ...prev, [key]: m }))
  }

  const save = async () => {
    if (undecided.length > 0) {
      setFormErr(`还有 ${undecided.length} 条改名没确认含义：选「含义不变」或「含义已改变」后再保存`)
      return
    }
    const changedWithoutDesc = livePending.find(k => meanings[k]?.status === 'changed' && !meanings[k]?.description?.trim())
    if (changedWithoutDesc) {
      setFormErr(`「${pending?.[changedWithoutDesc]?.label ?? changedWithoutDesc}」标为「含义已改变」时，请写明它现在是什么意思`)
      return
    }
    setSaving(true)
    try {
      await onSave(clean, meanings)
      onClose()
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    // 🔴 宽度 896px（原 md=448 的**两倍**）：一页动辄几十个字段，「原名 + 提示 + 输入框」挤在 448
    //    里输入框太窄没法看全自己改的名字（2026-10-03 反馈）。窄屏仍由 Modal 的 max-w-[92vw] 兜底。
    <Modal open onClose={onClose} icon={<Type size={14} />} title={title} width={896} maxHeight="80vh">
      <div className="space-y-3">
        <p className="text-12 text-ink-400 leading-relaxed">
          {intro}
          <span className="text-ink-200">名称会同步给 AI 读取这一项时使用，不动您已经填好的内容与存储键</span>—— 留空即用原名。
        </p>

        {/* 🔴 硬提醒：现在 AI 按新名称理解，但「含义变没变」只有作者知道 */}
        <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber shrink-0 mt-0.5" />
          <div className="text-12 text-ink-300 leading-relaxed">
            <span className="text-amber font-medium">改名后，AI 会按新名称理解这一项。</span>
            <span className="block mt-1">
              · <strong className="text-ink-100">只是换个叫法</strong>（如「所属势力」→「效忠组织」）：
              选「含义不变」即可，原用途照常运行。
            </span>
            <span className="block mt-1">
              · <strong className="text-ink-100">字段含义也变了</strong>（如「修炼境界」→「社会声望」）：
              必须选「含义已改变」并写明新含义。未确认前，这一项不会进入 AI 上下文、索引与 AI 补全。
            </span>
            <span className="block mt-1">
              · 已填的内容一个字节都不会动；保存后旧版「字段名」的记录也会收进这份定义，不再两处各说各话。
            </span>
          </div>
        </div>

        {livePending.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg border border-amber/25 bg-ink-850/50">
            <span className="text-12 text-ink-200">待确认含义 {livePending.length} 项</span>
            <span className="text-10 text-ink-500">这些改名来自旧版「字段名」，先确认含义再交给 AI</span>
            <Button
              variant="secondary" size="xs" className="ml-auto"
              onClick={() => {
                setFormErr('')
                setMeanings(prev => {
                  const next = { ...prev }
                  for (const k of livePending) if (!next[k]) next[k] = { status: 'unchanged' }
                  return next
                })
              }}
            >
              全部标为含义不变
            </Button>
          </div>
        )}

        {/* 🔴 高度走 foldVh（与 AIOrganize / AITemplateFill 的 42vh 同一口径）：
            CSS 类里的 vh 不随界面 zoom 折算，132% 缩放下会顶出弹窗。 */}
        <div className="rounded-lg border border-ink-700 overflow-y-auto" style={{ maxHeight: foldVh('42vh') }}>
          {groups.map(g => (
            <div key={g.name} className="border-b border-ink-700 last:border-b-0">
              {g.name && (
                <div className="px-3 py-1.5 bg-ink-850 text-11 text-ink-300 font-medium sticky top-0">{g.name}</div>
              )}
              <div className="divide-y divide-ink-700">
                {g.items.map(t => {
                  const err = errOf(t.key)
                  const alias = clean[t.key]
                  return (
                    <div key={t.key} className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        <div className="w-[38%] shrink-0 min-w-0">
                          <div className="text-12 text-ink-200 truncate" title={t.key}>{t.label}</div>
                          <div className="text-10 text-ink-500 truncate" title={t.hint}>{t.hint}</div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <input
                            className={`w-full bg-ink-800 border rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600 ${err ? 'border-danger/50' : 'border-ink-700'}`}
                            value={draft[t.key] ?? ''}
                            maxLength={MAX_ALIAS_LEN * 2}
                            placeholder={t.label}
                            onChange={e => setDraft(prev => ({ ...prev, [t.key]: e.target.value }))}
                          />
                          {err && <div className="mt-0.5 text-10 text-danger">{err}</div>}
                          {alias && !err && (
                            <div className="mt-0.5 text-10 text-amber truncate">
                              {pending?.[t.key] && !meanings[t.key]
                                ? `显示为「${alias}」· 含义未确认前不会交给 AI`
                                : `显示为「${alias}」· AI 按这个名字理解这一项`}
                            </div>
                          )}
                          {pending?.[t.key] && (draft[t.key] ?? '').trim() && (
                            <div className="mt-2 rounded-lg border border-amber/25 bg-amber/5 px-2.5 py-2">
                              <div className="text-10 text-ink-400">
                                旧名「{pending[t.key].defaultLabel ?? t.label}」
                                <span className="text-ink-600"> → </span>
                                现名「{(draft[t.key] ?? '').trim() || pending[t.key].label}」
                                {pending[t.key].description && (
                                  <span className="block text-ink-500 mt-0.5 truncate" title={pending[t.key].description}>
                                    原说明：{pending[t.key].description}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                                <Button
                                  variant="toggle" size="xs"
                                  selected={meanings[t.key]?.status === 'unchanged'}
                                  onClick={() => setMeaning(t.key, { status: 'unchanged' })}
                                >
                                  含义不变
                                </Button>
                                <Button
                                  variant="toggle" size="xs"
                                  selected={meanings[t.key]?.status === 'changed'}
                                  onClick={() => setMeaning(t.key, {
                                    status: 'changed',
                                    ...(meanings[t.key]?.description ? { description: meanings[t.key].description } : {}),
                                  })}
                                >
                                  含义已改变
                                </Button>
                                {meanings[t.key]?.status === 'unchanged' && (
                                  <span className="text-10 text-ink-500">原用途保持不变，AI 继续按这个字段的用途使用</span>
                                )}
                              </div>
                              {meanings[t.key]?.status === 'changed' && (
                                <input
                                  className="mt-1.5 w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-11 px-2.5 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
                                  value={meanings[t.key]?.description ?? ''}
                                  maxLength={500}
                                  placeholder="写明它现在是什么意思，例如：角色在修真社会中的声望等级"
                                  onChange={e => setMeaning(t.key, { status: 'changed', description: e.target.value })}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {formErr && (
          <div className="px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">{formErr}</div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-11 text-ink-500 flex items-center gap-1.5">
            <HelpPopover title="显示名的三条规矩" width="20rem" size={13}>
              {`· 影响「您看到的字」和 AI 理解这一项时用的名字；已填数据与存储键一个字节都不会动。
· 含义没变选「含义不变」；含义变了必须写明新含义，否则 AI 会按旧含义解释新名称。
· 不能和同页其它字段重名，也不能超过 ${MAX_ALIAS_LEN} 个字 —— 重名会让人分不清是哪一项，会自动退回原名。`}
            </HelpPopover>
            已改名 {renamed.length} / {targets.length}
            {livePending.length > 0 && <span className="text-amber">· 待确认 {livePending.length}</span>}
          </span>
          {/* 🔴 2026-10-12 主人反馈「并排按钮一高一矮」：这三个键同处一条 flex 行，
              必须同 size。原先「全部恢复默认 / 取消」走 bare（**无 size 类，高度随内容 ≈20px**），
              与右侧 sm(h-8/32px) 的「保存」并排差 12px，比 AI 提示词那对还夸张。
              按项目口径：同排主次操作统一 sm（xs 只留给行内工具键）。 */}
          <div className="flex items-center gap-2">
            <Button
              variant="bare"
              size="sm"
              onClick={() => setDraft({})}
              disabled={renamed.length === 0 && Object.keys(draft).length === 0}
              title="清空所有显示名，全部恢复默认"
            >
              <RotateCcw size={12} /> 全部恢复默认
            </Button>
            <Button variant="bare" size="sm" onClick={onClose}>取消</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={12} /> {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
