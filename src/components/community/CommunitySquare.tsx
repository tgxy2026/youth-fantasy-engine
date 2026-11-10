// 投稿广场 · 应用内 / 网页版共用外壳（3.5.0）
//
// 【同一个服务】网页云端账号走同源 Cookie，桌面版走已登录的云端通道；
// 组件本身**不区分形态**，只依赖 `@/lib/community/api`（它已封好通道差异）。
//
// 🔴 未登录也能浏览（规划 §2.1）：只有「投稿 / 我的 / 设置」需要登录，
//    「排行」与「广场」是公共读。登录态判定用一次 `fetchProfile()`，
//    失败不等于广场坏了 —— 分别提示「未登录」与「网络不可用」。
// 🔴 社区服务故障不得影响本地写作：本组件是**独立浮层**，不挂在编辑器关键路径上，
//    任何异常都在浮层内显示，不抛到 App 的错误边界。

import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'
import { WEB_CLOUD, WEB_GUEST } from '@/lib/app/platform'
import { communityEndpointReady, adminOverview, fetchProfile, fetchSquare } from '@/lib/community/api'
import { accountKeyOf } from '@/lib/community/draft'
import { uploadRank } from '@/lib/community/rankUpload'
import type { CommunityProfile, CommunitySquareState, DisplayMode } from '@/lib/community/types'
import FeedPanel from '@/components/community/FeedPanel'
import PublishPanel, { type EditTarget } from '@/components/community/PublishPanel'
import MyPanel from '@/components/community/MyPanel'
import RankPanel from '@/components/community/RankPanel'
import SettingsPanel from '@/components/community/SettingsPanel'
import AdminPanel from '@/components/community/AdminPanel'
import { Notice } from '@/components/community/ui'

type Tab = 'feed' | 'write' | 'mine' | 'rank' | 'settings' | 'admin'

interface Props {
  /** 浮层模式（项目中心）传入关闭回调；页签模式不传 */
  onClose?: () => void
  /** 'overlay' = 全局浮层；'page' = 正文写作组页签（与正文编辑同级） */
  mode?: 'overlay' | 'page'
}

export default function CommunitySquare({ onClose, mode = 'overlay' }: Props) {
  const [tab, setTab] = useState<Tab>('feed')
  const [square, setSquare] = useState<CommunitySquareState | null>(null)
  const [profile, setProfile] = useState<CommunityProfile | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [canAdmin, setCanAdmin] = useState(false)
  const [adminCount, setAdminCount] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [feedKey, setFeedKey] = useState(0)

  const endpointReady = communityEndpointReady()
  const guest = WEB_GUEST
  /**
   * 草稿归属键：网页版由服务端注入账号 id；桌面版的账号 id 是运行时解析的
   * （`syncBoot.getSyncAccountId`），这里异步取一次。
   * 🔴 拿不到就退到 'local'：宁可「本机共用」，也不要去猜一个不存在的本地键。
   */
  const [cloudAccountId, setCloudAccountId] = useState<string | undefined>(() => {
    try { return (window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id } catch { return undefined }
  })
  useEffect(() => {
    if (WEB_CLOUD) return
    let cancelled = false
    void (async () => {
      try {
        const m = await import('@/lib/app/syncBoot')
        const id = m.getSyncAccountId()
        if (!cancelled) setCloudAccountId(id)
      } catch { /* 未登录或模块不可用：保持 undefined */ }
    })()
    return () => { cancelled = true }
  }, [])
  const accountKey = accountKeyOf(cloudAccountId)

  const loadHeader = useCallback(async () => {
    setError('')
    try {
      const s = await fetchSquare()
      setSquare(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    try {
      const p = (await fetchProfile()).profile
      setProfile(p); setSignedIn(true)
    } catch {
      setSignedIn(false)
      setProfile(null)
    }
  }, [])

  useEffect(() => { void loadHeader() }, [loadHeader])

  // 管理员入口：只有服务端确认过才显示（普通用户这里会 403，直接忽略）
  useEffect(() => {
    if (!signedIn) { setCanAdmin(false); return }
    let cancelled = false
    void (async () => {
      try {
        const o = await adminOverview()
        if (!cancelled) { setCanAdmin(true); setAdminCount(o.queue.posts + o.queue.comments + o.queue.reports) }
      } catch { if (!cancelled) setCanAdmin(false) }
    })()
    return () => { cancelled = true }
  }, [signedIn])

  // 打开广场时顺带补一次排行上报（节流在 uploadRank 内；未开启会直接跳过）
  useEffect(() => {
    if (!signedIn) return
    void uploadRank().catch(() => undefined)
  }, [signedIn])

  const canWrite = signedIn === true && !guest
  const defaultDisplay: DisplayMode = profile?.postDisplay || 'anonymous'

  function requireLogin() {
    setNotice(guest
      ? '游客数据只在本机，无法参与社区。注册后即可投稿、评论与参与排行（本地游客项目仍保留在此浏览器）。'
      : '请先登录云端账号（桌面版在「设置 → 云端账号」登录），本地写作不受影响。')
  }

  function goTab(next: Tab) {
    setNotice(''); setError('')
    if ((next === 'write' || next === 'mine' || next === 'settings') && !canWrite) { requireLogin(); return }
    setTab(next)
  }

  /**
   * 两种形态共用同一套内容：
   *  · `overlay`：项目中心打开，铺满屏、可关闭（没有工作区时也能进广场）
   *  · `page`   ：正文写作组页签，占满工作区内容区，不额外加遮罩（侧栏仍可用）
   * 🔴 页签模式不能给 fixed 定位：那会把侧栏与正文一起盖住，和「与正文编辑同级」相矛盾。
   */
  const shell = (
    <div className={mode === 'overlay'
      ? 'flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-surface-app shadow-2xl'
      : 'flex h-full w-full flex-col overflow-hidden rounded-xl border border-ink-700 bg-surface-app'}>
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-15 font-semibold text-ink-100">投稿广场</h2>
          <p className="text-11 text-ink-400">分享你愿意公开的文字片段；默认匿名展示。</p>
        </div>
        {square && !square.open && <Notice kind="warn">广场暂时关闭，仅管理员可处理待审内容。</Notice>}
        {mode === 'overlay' && onClose && (
          <Button variant="ghost" iconOnly onClick={onClose} aria-label="关闭投稿广场"><X size={18} /></Button>
        )}
      </header>

        <nav className="flex flex-wrap gap-1 border-b border-ink-700 px-3 py-1.5" aria-label="广场分区">
          <Button size="sm" variant="toggle" selected={tab === 'feed'} onClick={() => goTab('feed')}>广场</Button>
          <Button size="sm" variant="toggle" selected={tab === 'write'} onClick={() => goTab('write')}>投稿</Button>
          <Button size="sm" variant="toggle" selected={tab === 'mine'} onClick={() => goTab('mine')}>我的</Button>
          <Button size="sm" variant="toggle" selected={tab === 'rank'} onClick={() => goTab('rank')}>排行</Button>
          <Button size="sm" variant="toggle" selected={tab === 'settings'} onClick={() => goTab('settings')}>设置</Button>
          {canAdmin && (
            <Button size="sm" variant="toggle" selected={tab === 'admin'} onClick={() => goTab('admin')}>
              审阅{adminCount ? ` (${adminCount})` : ''}
            </Button>
          )}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {!endpointReady && (
            <Notice kind="warn">
              当前形态没有可用的云端连接：桌面版请先在「设置 → 云端账号」登录后再打开广场。本地写作与既有功能不受影响。
            </Notice>
          )}
          {error && <Notice kind="error">{error}</Notice>}
          {notice && <Notice kind="warn">{notice}</Notice>}

          {signedIn === false && (tab === 'feed' || tab === 'rank') && (
            <Notice>你现在未登录：可以浏览，但不能投稿、评论或参与排行。</Notice>
          )}

          {tab === 'feed' && <FeedPanel canWrite={canWrite} defaultDisplay={defaultDisplay} onNeedLogin={requireLogin} key={feedKey} />}
          {tab === 'write' && canWrite && (
            <PublishPanel
              accountKey={accountKey}
              defaultDisplay={defaultDisplay}
              editTarget={editTarget}
              onCancelEdit={() => setEditTarget(null)}
              onSubmitted={(message) => { setNotice(message); setEditTarget(null); setFeedKey((k) => k + 1); setTab('mine') }}
            />
          )}
          {tab === 'mine' && canWrite && (
            <MyPanel
              onEdit={(t) => { setEditTarget(t); setTab('write') }}
              onChanged={() => { void loadHeader(); setFeedKey((k) => k + 1) }}
            />
          )}
          {tab === 'rank' && <RankPanel onOpenSettings={() => goTab('settings')} />}
          {tab === 'settings' && canWrite && <SettingsPanel accountId={cloudAccountId} onProfileChanged={setProfile} />}
          {tab === 'admin' && canAdmin && <AdminPanel onTitle={setAdminCount} />}
        </div>

<footer className="border-t border-ink-700 px-3 py-2 text-11 text-ink-400">
        {WEB_CLOUD ? '网页云端账号' : guest ? '游客浏览' : '桌面 / 便携版'} · 内容审核由管理员人工确认；社区服务不可用时不会影响本地写作。
      </footer>
    </div>
  )

  if (mode === 'page') return shell
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-2 sm:p-6" style={{ zIndex: Z.modal }} role="dialog" aria-modal="true" aria-label="投稿广场">
      {shell}
    </div>
  )
}