/**
 * 字段显示名 · 改名弹窗（2.7.3）
 *
 * 🔴 只改「界面显示的名字」，**不动列名这个存储键** —— 已填的数据一行都不会丢。
 *    想改回默认，把输入框清空即可。
 */
import { useMemo, useState } from 'react'
import { RotateCcw, Save, Type } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import HelpPopover from './HelpPopover'
import { MAX_ALIAS_LEN, sanitizeAliases, validateAliasInput, type AliasMap } from '../lib/fieldAlias'

export default function FieldAliasDialog({
  tabName,
  cols,
  initial,
  onSave,
  onClose,
}: {
  tabName: string
  /** 本表存储键数组（顺序即列顺序） */
  cols: string[]
  /** 当前别名表（存储键 → 显示名） */
  initial: AliasMap
  onSave: (next: AliasMap) => Promise<void> | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<AliasMap>(() => ({ ...initial }))
  const [saving, setSaving] = useState(false)

  const clean = useMemo(() => sanitizeAliases(cols, draft), [cols, draft])
  const renamed = Object.keys(clean)

  /** 逐行实时校验：只提示，不拦着打字 */
  const errOf = (key: string): string | null => {
    const input = draft[key] ?? ''
    if (!input.trim()) return null
    return validateAliasInput(cols, draft, key, input)
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
          给这一页的字段起你自己看得懂的名字（例如把「契约/驯化关系」改成「疯狂星期四v我50」）。
          <span className="text-ink-200"> 只改表格里显示的字，不动您已经填好的内容</span>
          —— 留空即用原名。
          <span className="block mt-1 text-ink-500">
            列名本身是数据的存放位置，改它会让已填内容读不出来，所以这里只做「显示名」，不做真正的重命名。
          </span>
        </p>

        <div className="rounded-lg border border-ink-700 divide-y divide-ink-800 max-h-[46vh] overflow-y-auto">
          {cols.map(key => {
            const err = errOf(key)
            return (
              <div key={key} className="px-3 py-2 flex items-center gap-3">
                <div className="w-[38%] shrink-0 min-w-0">
                  <div className="text-12 text-ink-200 truncate" title={key}>{key}</div>
                  {clean[key] && <div className="text-10 text-amber truncate">显示为「{clean[key]}」</div>}
                </div>
                <div className="flex-1 min-w-0">
                  <input
                    className={`w-full bg-ink-800 border rounded-lg text-ink-100 text-12 px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600 ${err ? 'border-danger/50' : 'border-ink-700'}`}
                    value={draft[key] ?? ''}
                    maxLength={MAX_ALIAS_LEN * 2}
                    placeholder={key}
                    onChange={e => setDraft(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                  {err && <div className="mt-0.5 text-10 text-danger">{err}</div>}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-11 text-ink-500 flex items-center gap-1.5">
            <HelpPopover title="显示名的三条规矩" width="20rem" size={13}>
              {`· 只影响「您看到的字」：表格表头、关系分组视图、设定检索里显示的都是它。
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
