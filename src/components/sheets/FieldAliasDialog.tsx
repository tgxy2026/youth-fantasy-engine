/**
 * 字段显示名 · 改名弹窗（2.7.3 · 表格 / 表单 / 卡片三类页签共用）
 *
 * 🔴 只改「界面显示的名字」，**不动存储键**（表格＝列名，表单与卡片＝`模块名::字段名`）
 *    —— 已填的数据一行都不会丢，想改回默认把输入框清空即可。
 *
 * 🔴🔴 必须在界面上把「改名 ≠ 改语义」讲清楚：AI 读表用的仍是**原字段名**。
 *    若作者把「契约/驯化关系」改名成「外勤预约」后往里填别的性质的东西，
 *    AI 会**按原名理解**这一列 —— 补全 / 整理 / 写作辅助全跑偏，且不报错。
 *    所以顶部有醒目提醒条，每项还标出「原本能填什么」，让人自己对照。
 *    反之：不用 AI 的作者纯按自己看着舒服改，零影响（弹窗里也这么写）。
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, RotateCcw, Save, Type } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import HelpPopover from '@/components/common/HelpPopover'
import { MAX_ALIAS_LEN, sanitizeAliases, validateAliasInput, type AliasMap } from '@/lib/settings/fieldAlias'
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
  onSave,
  onClose,
}: {
  title: string
  /** 顶部那句说明（各页签自己写，如「填的是这一页的字段」） */
  intro: string
  targets: AliasTarget[]
  /** 当前别名表（存储键 → 显示名） */
  initial: AliasMap
  onSave: (next: AliasMap) => Promise<void> | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<AliasMap>(() => ({ ...initial }))
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

  const save = async () => {
    setSaving(true)
    try {
      await onSave(clean)
      onClose()
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
          <span className="text-ink-200">只改界面上显示的字，不动您已经填好的内容</span>—— 留空即用原名。
        </p>

        {/* 🔴 硬提醒：改名不改语义，AI 仍按原字段名理解 */}
        <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber shrink-0 mt-0.5" />
          <div className="text-12 text-ink-300 leading-relaxed">
            <span className="text-amber font-medium">改名不等于改含义，AI 读表用的仍是原来的字段名。</span>
            <span className="block mt-1">
              · 改名后，这一项<strong className="text-ink-100">填的内容仍要和原字段的语义一致</strong>：
              每行下面都标了「原本能填什么」，请对照着填。填成完全不同的性质时，AI 补全 / AI 整理 /
              写作辅助会按原字段名去理解，这一项就会跑偏（且不会报错）。
            </span>
            <span className="block mt-1">
              · <strong className="text-ink-100">不使用 AI 功能的话</strong>，纯按自己看着舒服改即可，
              没有任何影响 —— 显示名只出现在您看到的界面上。
            </span>
          </div>
        </div>

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
                              显示为「{alias}」· AI 仍按「{t.label}」理解这一项
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

        <div className="flex items-center justify-between gap-2">
          <span className="text-11 text-ink-500 flex items-center gap-1.5">
            <HelpPopover title="显示名的三条规矩" width="20rem" size={13}>
              {`· 只影响「您看到的字」：表头、字段名、关系分组视图里显示的都是它。
· 已填的数据一个字节都不会动，导出与 AI 上下文照旧按原字段名走（不会错位）。
· 不能和同页其它字段重名，也不能超过 ${MAX_ALIAS_LEN} 个字 —— 重名会让人分不清是哪一项，会自动退回原名。`}
            </HelpPopover>
            已改名 {renamed.length} / {targets.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="bare"
              onClick={() => setDraft({})}
              disabled={renamed.length === 0 && Object.keys(draft).length === 0}
              title="清空所有显示名，全部恢复默认"
            >
              <RotateCcw size={12} /> 全部恢复默认
            </Button>
            <Button variant="bare" onClick={onClose}>取消</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={12} /> {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
