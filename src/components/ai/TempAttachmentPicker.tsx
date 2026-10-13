/**
 * AI 弹窗的「附加文件」—— **一次性**资料：只喂给本次请求，不落素材库、不进索引。
 *
 * 【与「我的参考资料」的区别】（这两个不是一回事，别混）
 *   · 我的参考资料（素材资料页）：长期挂载 → 建索引 → 每次按需召回；
 *   · 本组件：临时递一份文件给**这一次**任务，关掉弹窗就没了。
 *   作者想"以后每次都能读到"就挂参考资料；只想"这次让它看看这份稿子"就用这里。
 *
 * 🔴 生命周期由本组件**独占**管理：列表一变就同步进 `aiContext`，组件卸载时清空。
 *    漏清理的后果很隐蔽 —— 作者关掉这个弹窗后，下一次在别处发起的 AI 请求会莫名带上
 *    上次那个文件，而他完全看不出原因（详见 `aiContext` 里 `TempDoc` 的说明）。
 *
 * 解析直接复用 `chapterImport.readImportFile`：它已经处理好了 BOM、20MB 上限、
 * `.doc` 劝退（提示另存为）与 docx 手写解析 —— 不再造第二套。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { clearTempDocs, setTempDocs, type TempDoc } from '@/lib/ai/tempDocs'
import { readImportFile } from '@/lib/storage/chapterImport'

/** 与 chapterImport 口径一致：`.doc` 故意不收（会在读取时给出"另存为 docx/txt"的明确提示） */
const ACCEPT = '.txt,.md,.markdown,.docx'

export default function TempAttachmentPicker({ hint = true }: { hint?: boolean }) {
  const [docs, setDocs] = useState<TempDoc[]>([])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // 本实例的身份 —— 让"多个 AI 面板同时挂载"时各自只清自己那份（见 aiContext 的 setTempDocs）
  const ownerId = useId()

  // 同步进 aiContext（组装上下文时读取）
  useEffect(() => {
    setTempDocs(ownerId, docs)
  }, [ownerId, docs])
  // 卸载即清空（只清自己那份）—— 见文件头「生命周期」
  useEffect(() => () => clearTempDocs(ownerId), [ownerId])

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    const added: TempDoc[] = []
    const failed: string[] = []
    for (const f of Array.from(files)) {
      try {
        const r = await readImportFile(f)
        const text = (r.text ?? '').trim()
        if (!text) throw new Error(`「${f.name}」里没读到文字内容`)
        added.push({ name: r.fileName, text })
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e))
      }
    }
    setBusy(false)
    if (added.length > 0) {
      // 同名替换（作者改了文件重传时不该出现两条）
      setDocs(prev => [...prev.filter(d => !added.some(a => a.name === d.name)), ...added])
      showToast(`已附加 ${added.length} 个文件（仅本次使用，不会保存到素材资料）`, 'success')
    }
    if (failed.length > 0) showToast(failed.join('\n'), 'error', 7000)
    if (fileRef.current) fileRef.current.value = ''   // 允许重复选同一个文件
  }

  const totalChars = docs.reduce((n, d) => n + d.text.length, 0)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={e => void addFiles(e.target.files)}
        />
        <Button
          variant="secondary"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="gap-1.5"
        >
          <Paperclip size={14} />
          {busy ? '读取中…' : '附加文件'}
        </Button>
        {hint && (
          <span className="text-11 text-ink-500">
            txt / md / docx · 仅本次使用，不保存到素材资料
          </span>
        )}
      </div>

      {docs.length > 0 && (
        <div className="flex flex-col gap-1">
          {docs.map(d => (
            <div
              key={d.name}
              className="flex items-center gap-2 rounded px-2 py-1 text-11 text-ink-300 bg-ink-800/60"
            >
              <FileText size={12} className="shrink-0 text-amber" />
              <span className="flex-1 truncate" title={d.name}>{d.name}</span>
              <span className="shrink-0 text-ink-500">{d.text.length} 字</span>
              <button
                type="button"
                title="移除"
                className="shrink-0 text-ink-500 hover:text-red-400"
                onClick={() => setDocs(prev => prev.filter(x => x.name !== d.name))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="text-11 text-ink-500">
            共 {docs.length} 个文件 / {totalChars} 字 —— 将作为〖本次附加文件〗放进这次的提示词
          </div>
        </div>
      )}
    </div>
  )
}
