/**
 * 字段显示名 · 改名弹窗（2.7.3）
 *
 * 🔴 只改「界面显示的名字」，**不动列名这个存储键** —— 已填的数据一行都不会丢。
 *    想改回默认，把输入框清空即可。
 *
 * 🔴🔴 必须在界面上把「改名 ≠ 改语义」讲清楚：AI 读表用的仍是**原字段名**。
 *    若作者把「契约/驯化关系」改名成「疯狂星期四v我50」后，往里填的却是梗或别的东西，
 *    AI 会**按原名理解**这一列 —— 补全 / 整理 / 写作辅助全跑偏，且不报错。
 *    所以顶部有醒目提醒条，每个字段行还标出「原本能填什么」，让作者自己对照。
 *    反之：不用 AI 的作者，纯按自己看着舒服改，零影响（弹窗里也这么写）。
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, RotateCcw, Save, Type } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import HelpPopover from './HelpPopover'
import { MAX_ALIAS_LEN, sanitizeAliases, validateAliasInput, type AliasMap } from '../lib/fieldAlias'

/** 弹窗需要的列信息：键 + 该列原本的取值范围（用于提醒作者别填偏语义） */
export interface AliasTarget {
  key: string
  options?: readonly string[]
}

export default function FieldAliasDialog({
  tabName,
  cols,
  initial,
  onSave,
  onClose,
}: {
  tabName: string
  /** 本表可见列（顺序即列顺序） */
  cols: AliasTarget[]
  /** 当前别名表（存储键 → 显示名） */
  initial: AliasMap
  onSave: (next: AliasMap) => Promise<void> | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<AliasMap>(() => ({ ...initial }))
  const [saving, setSaving] = useState(false)

  const keys = useMemo(() => cols.map(c => c.key), [cols])
  const clean = useMemo(() => sanitizeAliases(keys, draft), [keys, draft])
  const renamed = Object.keys(clean)

  /** 逐行实时校验：只提示，不拦着打字 */
  const errOf = (key: string): string | null => {
    const input = draft[key] ?? ''
    if (!input.trim()) return null
    return validateAliasInput(keys, draft, key, input)
  }

  /** 这一列原本能填什么 —— 提醒作者「填的内容仍要符合原字段的语义」 */
  const hintOf = (t: AliasTarget): string =>
    t.options?.length ? `原本可填：${t.options.join(' / ')}` : '原本是自由填写'

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
    <Modal
      open
      onClose={onClose}
      icon={<Type size={14} />}
      title={`字段显示名 · ${tabName}`}
      width="md"
      maxHeight="80vh"
    >
      <div className="space-y-3">
        <p className="text-12 text-ink-400 leading-relaxed">
          给这一页的字段起你自己看得懂的名字（例如把「契约/驯化关系」改成「外勤预约」）。
          <span className="text-ink-200">只改表格里显示的字，不动您已经填好的内容</span>
          —— 留空即用原名。
        </p>

        {/* 🔴 硬提醒：改名不改语义，AI 仍按原字段名理解 */}
        <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber shrink-0 mt-0.5" />
          <div className="text-12 text-ink-300 leading-relaxed">
            <span className="text-amber font-medium">改名不等于改含义，AI 读表用的仍是原来的字段名。</span>
            <span className="block mt-1">
              · 改名后，这一列<strong className="text-ink-100">填的内容仍要和原字段的语义一致</strong>：
              上面每行都标了「原本可填什么」，请对照着填。填成完全不同的性质时，AI 补全 / AI 整理 /
              写作辅助会按原字段名去理解，这一列就会跑偏（且不会报错）。
            </span>
            <span className="block mt-1">
              · <strong className="text-ink-100">不使用 AI 功能的话</strong>，纯按自己看着舒服改即可，
              没有任何影响 —— 显示名只出现在您看到的表头上。
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-ink-700 divide-y divide-ink-800 max-h-[42vh] overflow-y-auto">
          {cols.map(t => {
            const err = errOf(t.key)
            const alias = clean[t.key]
            return (
              <div key={t.key} className="px-3 py-2">
                <div className="flex items-center gap-3">
                  <div className="w-[38%] shrink-0 min-w-0">
                    <div className="text-12 text-ink-200 truncate" title={t.key}>{t.key}</div>
                    <div className="text-10 text-ink-500 truncate">{hintOf(t)}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <input
                      className={`w-full bg-ink-800 border rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600 ${err ? 'border-danger/50' : 'border-ink-700'}`}
                      value={draft[t.key] ?? ''}
                      maxLength={MAX_ALIAS_LEN * 2}
                      placeholder={t.key}
                      onChange={e => setDraft(prev => ({ ...prev, [t.key]: e.target.value }))}
                    />
                    {err && <div className="mt-0.5 text-10 text-danger">{err}</div>}
                    {alias && !err && (
                      <div className="mt-0.5 text-10 text-amber truncate">
                        显示为「{alias}」· AI 仍按「{t.key}」理解这一列
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-11 text-ink-500 flex items-center gap-1.5">
            <HelpPopover title="显示名的三条规矩" width="20rem" size={13}>
              {`· 只影响「您看到的字」：表格表头、关系分组视图里显示的都是它。
· 已填的数据一个字节都不会动，导出与 AI 上下文照旧按原字段名走（不会错位）。
· 不能和本表其它字段重名，也不能超过 ${MAX_ALIAS_LEN} 个字 —— 重名会让人分不清是哪一列，会自动退回原名。`}
            </HelpPopover>
            已改名 {renamed.length} / {cols.length}
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
