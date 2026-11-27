/**
 * 「其他设定」卡内多条独立设定编辑器（3.7.5 · Q-05③ 轻路线）
 *
 * 仍复用 `设定内容::内容` 纯文本存储键（以 `## 明细名称` 分段），不改数据库结构、
 * 不破坏 `seedRef` / `miscSettings` / AI 上下文 / 导出。支持修改每条明细的名称、自适应换行正文与增删条目。
 */
import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import AutoTextarea from '@/components/common/AutoTextarea'

export interface MiscBlock {
  title: string
  body: string
}

const HEADING_RE = /^##\s+(.+)$/

/** 将 `设定内容::内容` 解析为一条或多条相对独立的明细块 */
export function parseMiscBlocks(raw: string): MiscBlock[] {
  const normalized = raw.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (!lines.some(l => HEADING_RE.test(l.trim()))) {
    return [{ title: '设定正文', body: normalized }]
  }
  const blocks: MiscBlock[] = []
  let curTitle = '设定正文'
  let buf: string[] = []
  let seenHeading = false
  for (const line of lines) {
    const m = line.trim().match(HEADING_RE)
    if (m) {
      if (seenHeading || buf.some(x => x.trim())) {
        blocks.push({ title: curTitle, body: buf.join('\n').trim() })
      }
      curTitle = m[1].trim() || '未命名设定'
      buf = []
      seenHeading = true
    } else {
      buf.push(line)
    }
  }
  if (seenHeading || buf.some(x => x.trim())) {
    blocks.push({ title: curTitle, body: buf.join('\n').trim() })
  }
  return blocks.length ? blocks : [{ title: '设定正文', body: '' }]
}

/** 序列化回 `设定内容::内容`：单条默认名称时保持纯文本，多条或改过名则写 `## 名称` */
export function serializeMiscBlocks(blocks: MiscBlock[]): string {
  if (blocks.length === 1 && blocks[0].title.trim() === '设定正文') {
    return blocks[0].body
  }
  return blocks
    .map(b => `## ${b.title.trim() || '未命名设定'}\n${b.body}`)
    .join('\n\n')
}

interface Props {
  value: string
  onChange: (next: string) => void
}

export default function MiscBlocksEditor({ value, onChange }: Props) {
  const blocks = useMemo(() => parseMiscBlocks(value), [value])

  const updateBlock = (idx: number, patch: Partial<MiscBlock>) => {
    const next = blocks.map((b, i) => (i === idx ? { ...b, ...patch } : b))
    onChange(serializeMiscBlocks(next))
  }

  const addBlock = () => {
    const next = [...blocks, { title: `明细设定 ${blocks.length + 1}`, body: '' }]
    onChange(serializeMiscBlocks(next))
  }

  const removeBlock = (idx: number) => {
    if (blocks.length <= 1) return
    onChange(serializeMiscBlocks(blocks.filter((_, i) => i !== idx)))
  }

  return (
    <div className="space-y-2.5">
      {blocks.map((block, idx) => (
        <div
          key={idx}
          className="rounded-lg border border-ink-700/70 bg-ink-900/45 p-3 space-y-2"
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              aria-label={`明细设定名称 ${idx + 1}`}
              value={block.title}
              onChange={e => updateBlock(idx, { title: e.target.value })}
              placeholder="输入明细设定名称…"
              className="flex-1 min-w-0 bg-ink-850/80 border border-ink-700/70 focus:border-amber/60 rounded-md px-2.5 py-1 text-12 font-medium text-ink-100 outline-none transition-colors"
            />
            {blocks.length > 1 && (
              <Button
                variant="icon-danger"
                iconOnly
                size="xs"
                onClick={() => removeBlock(idx)}
                title="删除这条明细设定"
                aria-label="删除这条明细设定"
              >
                <Trash2 size={12} />
              </Button>
            )}
          </div>
          <AutoTextarea
            ariaLabel={block.title || `明细设定内容 ${idx + 1}`}
            value={block.body}
            onChange={body => updateBlock(idx, { body })}
            placeholder="点击填写设定正文（支持多行换行）…"
            minHeight={48}
            maxRows={3}
            maxHeight={0}
          />
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          size="xs"
          onClick={addBlock}
          className="flex items-center gap-1"
        >
          <Plus size={12} /> 新增一条设定内容
        </Button>
      </div>
    </div>
  )
}
