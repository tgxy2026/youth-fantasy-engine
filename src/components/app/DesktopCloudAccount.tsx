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
 * 🔴 **2026-10-31 主人要求改版**：不再让用户填网址、也不跳浏览器 ——
 *    面板就是「账号 + 密码 + 登录」两栏。服务器地址由主进程的 `YFE_CLOUD_BASE`
 *    决定（默认线上地址），界面上只在已登录时用一行小字显示"连的是哪台"。
 */
import { useCallback, useEffect, useState } from 'react'
import { Cloud, ShieldCheck } from 'lucide-react'
import { readStringPref, writeStringPref } from '@/lib/settings/uiPrefs'

/** 上次登录成功的账号名（只用于界面显示「登的是哪个号」；不是秘密，也不随同步走） */
const NAME_KEY = 'desktop-cloud-name'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { desktopAuthStatus, desktopLoginPassword, desktopLogout, DESKTOP_ACCOUNT_EVENT } from '@/lib/cloud/desktopLogin'
import { configureDesktopTransportIfSignedIn } from '@/lib/app/syncBoot'

export default function DesktopCloudAccount() {
  const [open, setOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [encrypted, setEncrypted] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  /** 主进程当前连的账号服务器（只读展示） */
  const [serverBase, setServerBase] = useState('')
  /**
   * 上次登录成功的账号名。
   * 🔴 令牌只存在主进程、状态接口只回"是否已登录"，界面拿不到名字；
   *    而"我现在登的是哪个号"必须能看见，否则换过账号也不知道。
   *    存在本机界面偏好里（`yfe-ui:`），不随同步走、不是秘密。
   */
  const [lastName, setLastName] = useState(() => readStringPref(NAME_KEY) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const st = await desktopAuthStatus()
    setSignedIn(st.signedIn)
    setEncrypted(st.encrypted)
    setServerBase(st.base)
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
      const r = await desktopLoginPassword(name, password)
      if (!r.ok) { setError(r.reason || '登录未完成'); return }
      // 🔴 成功就清掉密码：它只在这一次登录里有用，留在输入框里没有任何好处
      setPassword('')
      const who = r.userName || name.trim()
      if (who) { writeStringPref(NAME_KEY, who); setLastName(who) }
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
    setPassword('')
    writeStringPref(NAME_KEY, '')
    setLastName('')
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
                <Button
                  variant="primary" size="sm"
                  onClick={() => void login()}
                  disabled={busy || !name.trim() || !password}
                  title="登录只建立会话，不会上传、下载或合并任何作品；作品要不要上云，之后在「云端同步」里逐本开启"
                >
                  {busy ? '登录中…' : '登录'}
                </Button>
              )}
            </div>
          </div>
        )}
      >
        <div className="space-y-3">
          {error && (
            <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-12 text-rose-200">
              {error}
            </p>
          )}

          {signedIn ? (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-12 text-emerald-300">
                <ShieldCheck size={12} />
                <span className="min-w-0 truncate">已登录{lastName ? ` · ${lastName}` : ''}</span>
              </p>
              <p className="text-11 leading-relaxed text-ink-500">
                {encrypted
                  ? '凭据保存在这台机器的系统安全存储里，下次启动无需重新登录。'
                  : '这台机器没有可用的安全存储，凭据只在本次运行有效；重启后需重新登录。'}
              </p>
              {serverBase && (
                <p className="text-11 text-ink-600">服务器 {serverBase}</p>
              )}
            </div>
          ) : (
            <>
              {/* 🔴 只留两栏：账号 / 密码。按回车等于点登录（输完密码顺手敲回车是最自然的动作） */}
              <label className="block text-11 text-ink-500">
                账号
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="用户名"
                  className="mt-1 h-8 w-full rounded-lg border border-ink-700 bg-ink-800/40 !px-2 !py-0 text-12 text-ink-100 placeholder:text-ink-600"
                  autoComplete="username"
                  autoFocus
                />
              </label>
              <label className="block text-11 text-ink-500">
                密码
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    // 🔴 中文输入法里按回车是"确认候选词"，不是"提交" —— 不挡会登录到一半的账号名
                    if (e.nativeEvent.isComposing || e.key !== 'Enter') return
                    if (!busy && name.trim() && password) void login()
                  }}
                  placeholder="密码"
                  className="mt-1 h-8 w-full rounded-lg border border-ink-700 bg-ink-800/40 !px-2 !py-0 text-12 text-ink-100 placeholder:text-ink-600"
                  autoComplete="current-password"
                />
              </label>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}