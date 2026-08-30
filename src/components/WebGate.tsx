import { useState } from 'react'
import { Lock } from 'lucide-react'
import { showToast } from './dialogs'

// 网页体验版邀请门禁：未通过邀请码前拦截整个应用。
// 邀请码不在客户端明文保存（避免被扒），由服务器 /api/invite/check 比对，
// 仅在 localStorage 记一个「已通过」标记，避免每次刷新都重新输。
const INVITE_KEY = 'yfe-invite-ok'

export function checkInvited(): boolean {
  try {
    return localStorage.getItem(INVITE_KEY) === '1'
  } catch {
    return false
  }
}

export function markInvited() {
  try {
    localStorage.setItem(INVITE_KEY, '1')
  } catch {
    /* localStorage 不可用时退化为每次都输邀请码，不影响功能 */
  }
}

export default function WebGate() {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const v = code.trim()
    if (!v) {
      showToast('请输入邀请码', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await fetch('/api/invite/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: v }),
      })
      if (r.status === 429) {
        // 服务端限流：连续输错已达上限，明确告知要等多久，别让用户干瞪眼
        const d = await r.json().catch(() => null)
        const sec = Number(d?.retryAfter) || 600
        showToast(`尝试次数过多，请 ${Math.ceil(sec / 60)} 分钟后再试`, 'error', 5000)
        return
      }
      if (r.ok) {
        markInvited()
        // 重新加载，让下方 boot 流程以「已邀请」状态执行
        location.reload()
        return
      }
      showToast('邀请码不正确', 'error')
    } catch {
      showToast('无法连接邀请校验服务，请稍后重试', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-2 text-amber">
          <Lock size={18} />
          <span className="font-semibold">青春幻想引擎 · 网页体验版</span>
        </div>
        <p className="mb-4 text-sm text-ink-300 leading-relaxed">
          当前为<strong>邀请制</strong>体验。你的项目数据与 AI 密钥仅保存在
          <strong>本机浏览器</strong>，我们不会上传任何创作内容；仅当你主动提交反馈时才会向我们发送信息。
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="请输入邀请码"
          autoFocus
          className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-ink-100 outline-none focus:border-amber"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="mt-3 w-full rounded-lg bg-amber px-3 py-2 font-medium text-ink-950 disabled:opacity-60"
        >
          {busy ? '校验中…' : '进入'}
        </button>
      </div>
    </div>
  )
}
