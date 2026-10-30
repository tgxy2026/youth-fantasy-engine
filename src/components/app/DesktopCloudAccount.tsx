/**
 * 桌面版 · 云端账号（3.3.2 · P5）。
 *
 * 【它解决什么】桌面版此前完全没有「账号」入口：`desktopLogin` 的封装早就有了，
 *   但没有任何界面能调到它，于是"三端接续"在桌面端等于不存在。
 *
 * 🔴 登录本身**不上传、不下载、不合并任何作品**（规划 §3.2）：它只拿到一个会话令牌，
 *    作品要不要上云，是之后在「云端同步」里**逐本**开启。
 * 🔴 令牌不出主进程：这里只显示"已登录 / 是否记住"，拿不到 token 原文。
 * 🔴 服务器地址只记在本地界面偏好（`yfe-ui:`），不进项目数据、不随同步走。
 */
import { useCallback, useEffect, useState } from 'react'
import { Cloud, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { desktopAuthStatus, desktopLogin, desktopLogout, DESKTOP_ACCOUNT_EVENT } from '@/lib/cloud/desktopLogin'
import { configureDesktopTransportIfSignedIn } from '@/lib/app/syncBoot'
import { readStringPref, writeStringPref } from '@/lib/settings/uiPrefs'

const BASE_KEY = 'desktop-cloud-base'

export default function DesktopCloudAccount() {
  const [open, setOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [encrypted, setEncrypted] = useState(false)
  const [baseUrl, setBaseUrl] = useState(() => readStringPref(BASE_KEY) || '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const st = await desktopAuthStatus()
    setSignedIn(st.signedIn)
    setEncrypted(st.encrypted)
    // 冷启动时 bootSync 可能还没跑；这里顺手保证通道与登录态一致
    await configureDesktopTransportIfSignedIn()
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const login = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await desktopLogin(baseUrl, name)
      if (!r.ok) { setError(r.reason || '登录未完成'); return }
      writeStringPref(BASE_KEY, baseUrl.trim())
      showToast(r.message, 'success', 6000)
      await refresh()
      window.dispatchEvent(new CustomEvent(DESKTOP_ACCOUNT_EVENT))
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    if (!await confirmDialog({
      title: '退出云端账号',
      message: '退出后本机作品与待同步内容不会被删除；云端已上传的版本也不受影响。\n\n'
        + '下次使用「云端同步」需要重新登录。',
      confirmText: '退出登录', danger: true,
    })) return
    await desktopLogout()
    await configureDesktopTransportIfSignedIn()
    await refresh()
    window.dispatchEvent(new CustomEvent(DESKTOP_ACCOUNT_EVENT))
    showToast('已退出云端账号', 'success')
  }

  return (
    <>
      <Button
        variant="secondary"
        size="xs"
        className="w-full !justify-start gap-1.5"
        onClick={() => setOpen(true)}
        title="登录云端账号后，可逐本作品开启跨设备同步"
      >
        <Cloud size={12} /> 云端账号
        <span className={`ml-auto truncate ${signedIn ? 'text-emerald-400' : 'text-ink-500'}`}>
          {signedIn ? '已登录' : '未登录'}
        </span>
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="云端账号"
        icon={<Cloud size={15} />}
        width="md"
        footer={(
          <div className="flex w-full items-center gap-2">
            {signedIn && (
              <Button variant="ghost" size="sm" onClick={() => void logout()} disabled={busy}>
                退出登录
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>关闭</Button>
              {!signedIn && (
                <Button variant="primary" size="sm" onClick={() => void login()} disabled={busy || !baseUrl.trim()}>
                  {busy ? '等待浏览器…' : '用浏览器登录'}
                </Button>
              )}
            </div>
          </div>
        )}
      >
        <div className="space-y-3">
          <p className="text-12 leading-relaxed text-ink-400">
            登录只建立一个会话，<strong className="text-ink-200">不会上传、下载或合并任何作品</strong>。
            作品要不要上云，之后在「云端同步」里逐本开启。
          </p>

          {error && (
            <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-12 text-rose-200">
              {error}
            </p>
          )}

          {signedIn ? (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-12 text-emerald-300">
                <ShieldCheck size={12} /> 已登录
              </p>
              <p className="text-11 leading-relaxed text-ink-500">
                {encrypted
                  ? '凭据保存在这台机器的系统安全存储里，下次启动无需重新登录。'
                  : '这台机器没有可用的安全存储，凭据只在本次运行有效；重启后需重新登录。'}
              </p>
            </div>
          ) : (
            <>
              <label className="block text-11 text-ink-500">
                账号服务器地址
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://youth-fantasy-engine.online"
                  className="mt-1 h-8 w-full rounded-lg border border-ink-700 bg-ink-800/40 !px-2 !py-0 text-12 text-ink-100 placeholder:text-ink-600"
                  autoComplete="off"
                />
              </label>
              <label className="block text-11 text-ink-500">
                用户名（可选，浏览器里还可以改）
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="留空则在网页里自己填"
                  className="mt-1 h-8 w-full rounded-lg border border-ink-700 bg-ink-800/40 !px-2 !py-0 text-12 text-ink-100 placeholder:text-ink-600"
                  autoComplete="off"
                />
              </label>
              <p className="flex items-start gap-1.5 text-11 leading-relaxed text-amber-300/90">
                <ShieldAlert size={12} className="mt-0.5 shrink-0" />
                登录会打开系统浏览器。令牌只交给桌面主进程，网页脚本拿不到；请使用 <strong>https</strong> 地址。
              </p>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}