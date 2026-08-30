
import { useState } from 'react'
import { MessageSquareWarning } from 'lucide-react'
import { showToast } from './dialogs'
import { Modal } from './Modal'
import { Button } from './Button'

// 网页体验版反馈入口：右下角常驻按钮 + 弹窗。
// 仅当用户主动点「提交」时才向我们发送数据（文本 + 可选附带的文件），
// 项目创作内容本身不离开浏览器。服务端 /api/feedback 仅落盘、不回显。
export default function FeedbackButton() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!text.trim()) {
      showToast('请填写反馈内容', 'error')
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('text', text.trim())
      fd.append('ua', navigator.userAgent)
      if (file) fd.append('file', file)
      const r = await fetch('/api/feedback', { method: 'POST', body: fd })
      if (r.ok) {
        showToast('反馈已提交，感谢！', 'success')
        setOpen(false)
        setText('')
        setFile(null)
      } else {
        showToast('提交失败（' + r.status + '），请稍后重试', 'error')
      }
    } catch {
      showToast('提交失败，请检查网络', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="提交反馈 / 优化建议"
        className="flex items-center gap-2 rounded-full border border-amber/40 bg-ink-900/90 px-4 py-2 text-sm text-amber shadow-lg backdrop-blur hover:bg-ink-800"
      >
        <MessageSquareWarning size={16} />
        反馈
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="提交反馈 / 优化建议"
        width={448}
        surface="900"
        footer={
          <>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2 text-sm text-ink-300 hover:bg-ink-800"
            >
              取消
            </button>
            <Button onClick={submit}
                disabled={busy} variant="primary" solid size="md" className="text-ink-950">
                {busy ? '提交中…' : '提交'}
              </Button>
          </>
        }
      >
        <p className="mb-3 text-xs text-ink-400">
          仅此刻会向我们发送数据；你的项目内容仍留在本地浏览器，不会被读取。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="描述你遇到的问题，或想优化的点…"
          className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none focus:border-amber"
        />
        <label className="mt-3 block text-xs text-ink-400">
          可选：附带一个导出文件（.json）
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-xs text-ink-300"
          />
        </label>
      </Modal>
    </>
  )
}
