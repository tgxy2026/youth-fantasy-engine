/**
 * 模型配置 · **自定义请求头编辑器**（3.1.1 第 4 项）
 *
 * 【为什么单独一个组件】
 * ① `AIConfigPanel` 已到 935 行（软上限 800）—— 这段自带状态的 UI 是最自然的一块割出去；
 * ② 🔴 编辑期需要**行数组**（对象以头名为键，新增行时键是空的 ⇒ 打第一个字符就被吞），
 *    而「行数组」与「落库的 Record」是两份状态。放在**子组件里**，随配置表单一起挂载/卸载，
 *    取消或保存后自然复位 —— 不会出现「重开显示上一轮被放弃的草稿」。
 *
 * 🔴 浏览器禁止设置的头（`User-Agent` / `Cookie` …）由 `sanitizeCustomHeaders` **点名拒绝**并在此展示，
 *    绝不静默丢弃（详见 `lib/aiCore/headers.ts`）。
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { sanitizeCustomHeaders } from '@/lib/aiCore/headers'

interface Row { name: string; value: string }

interface Props {
  /** 当前配置的 id：换一条配置时丢弃上一轮草稿 */
  providerId: string
  headers: Record<string, string> | undefined
  /** 是否 OpenCode Go 预设（显示该平台专属说明） */
  isOpencodeGo: boolean
  onChange: (headers: Record<string, string> | undefined) => void
}

const rowsOf = (headers: Record<string, string> | undefined): Row[] =>
  Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))

export default function CustomHeadersEditor({ providerId, headers, isOpencodeGo, onChange }: Props) {
  const [draft, setDraft] = useState<{ id: string; rows: Row[] }>({ id: '', rows: [] })
  const rows = draft.id === providerId ? draft.rows : rowsOf(headers)

  const rejected = sanitizeCustomHeaders(
    Object.fromEntries(rows.filter(r => r.name.trim()).map(r => [r.name, r.value])),
  ).rejected

  /** 行 → 配置：非法的头不写进配置（已在下方点名提示），合法的落库 */
  const apply = (next: Row[]) => {
    setDraft({ id: providerId, rows: next })
    const { allowed } = sanitizeCustomHeaders(
      Object.fromEntries(next.filter(r => r.name.trim()).map(r => [r.name, r.value])),
    )
    onChange(Object.keys(allowed).length ? allowed : undefined)
  }
  const patch = (i: number, key: keyof Row, v: string) =>
    apply(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)))

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <label className="block text-11 text-ink-500">自定义请求头（选填）</label>
        <span className="text-10 text-ink-600">不填 ＝ 不发任何额外头</span>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="mb-1.5 flex items-center gap-2">
          <input
            className="w-2/5 min-w-0 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-2 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
            value={row.name}
            onChange={e => patch(i, 'name', e.target.value)}
            placeholder="x-opencode-session"
          />
          <input
            className="flex-1 min-w-0 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-12 px-2 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600"
            value={row.value}
            onChange={e => patch(i, 'value', e.target.value)}
            placeholder="值（OpenCode Go 可填任意 UUID）"
          />
          <Button variant="icon-danger" size="sm" iconOnly title="删除这一行"
            onClick={() => apply(rows.filter((_, j) => j !== i))}><Trash2 size={12} /></Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => apply([...rows, { name: '', value: '' }])}>
        <Plus size={12} /> 添加请求头
      </Button>
      {isOpencodeGo && (
        <p className="mt-1 text-10 text-ink-500 leading-relaxed">
          OpenCode Go 订阅：端点已自动填好，并预置了一条 <code>x-opencode-session</code>（可填任意 UUID，已默认生成）。
          它只认 <b>OpenAI 兼容</b>的模型 —— 走 Anthropic / responses 端点的那批（MiniMax、部分 Qwen、GPT 系）本项目接不了。
        </p>
      )}
      {rejected.length > 0 && (
        <p className="mt-1 text-10 text-danger leading-relaxed">
          {rejected.map(r => `「${r.name}」${r.reason}`).join('；')} —— 这些头不会随请求发出。
        </p>
      )}
      <p className="mt-1 text-10 text-amber leading-relaxed">
        ⚠️ 自定义头会随本机配置保存，并一起写进导出 / 备份文件 —— 请不要在这里填长期有效的密钥。
      </p>
    </div>
  )
}
