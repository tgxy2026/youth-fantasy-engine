// 投稿广场 · 应用内 / 网页版共用外壳（3.5.0）
//
// 【同一个服务】网页云端账号走同源 Cookie，桌面版走已登录的云端通道；
// 组件本身**不区分形态**，只依赖 `@/lib/community/api`（它已封好通道差异）。
//
// 【布局】宽屏：左侧投稿流为主、右侧固定「码字排行」竖栏（用户 2026-11-10 明确要求）；
//   窄屏：排行收成可展开区域，入口仍在顶部，功能不缺。
// 🔴 页签模式不能给 fixed 定位：那会盖住侧栏，和「与正文编辑同级」相矛盾。
// 🔴 社区服务故障不得影响本地写作：本组件是独立页面/浮层，任何异常都在内部显示。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
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

type Tab = 'feed' | 'write' | 'mine' | 'settings' | 'admin'
type RankTab = 'rank'

interface Props {
  /** 浮层模式（项目中心）传入关闭回调；页签模式不传 */
  onClose?: () => void
  /** 'overlay' = 全局浮层；'page' = 正文写作组页签（与正文编辑同级） */
  mode?: 'overlay' | 'page'
  /** 测试/嵌入用：强制宽屏或窄屏布局 */
  forceLayout?: 'wide' | 'narrow'
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'feed', label: '广场' },
  { id: 'write', label: '投稿' },
  { id: 'mine', label: '我的' },
  { id: 'settings', label: '设置' },
]

export default function CommunitySquare({ onClose, mode = 'overlay', forceLayout }: Props) {
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
  const [rankOpen, setRankOpen] = useState(false)
  const [wide, setWide] = useState(forceLayout === 'wide')
  const hostRef = useRef<HTMLDivElement | null>(null)

  const endpointReady = communityEndpointReady()
  const guest = WEB_GUEST

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

  // 布局宽度：用布局像素（÷ 界面缩放由 clientWidth 自动体现），≥ 900 视为宽屏
  useEffect(() => {
    if (forceLayout) { setWide(forceLayout === 'wide'); return }
    const el = hostRef.current
    if (!el) return
    const measure = () => setWide(el.clientWidth >= 900)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [forceLayout])

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
        if (!cancelled) {
          setCanAdmin(true)
          setAdminCount(o.queue.posts + o.queue.comments + o.queue.reports + o.queue.appeals)
        }
      } catch { if (!cancelled) setCanAdmin(false) }
    })()
    return () => { cancelled = true }
  }, [signedIn])

  // 打开广场时顺带补一次排行上报（节流在 uploadRank 内；未开启会直接跳过）
  useEffect(() => {
    if (!signedIn) return
    void uploadRank({ accountKey }).catch(() => undefined)
  }, [signedIn, accountKey])

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

  const openSettings = () => goTab('settings')
  const shellClass = mode === 'overlay'
    ? 'flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-surface-app shadow-2xl'
    : 'flex h-full w-full flex-col overflow-hidden rounded-xl border border-ink-700 bg-surface-app'

  const nav = (
    <nav className="flex items-center gap-1 overflow-x-auto border-b border-ink-700 px-3 py-2 sm:px-4" aria-label="广场分区">
      {TABS.map((t) => (
        <Button key={t.id} size="sm" variant="toggle" selected={tab === t.id} onClick={() => goTab(t.id)}>{t.label}</Button>
      ))}
      {canAdmin && (
        <Button size="sm" variant="toggle" selected={tab === 'admin'} onClick={() => goTab('admin')}>
          审阅{adminCount ? ` (${adminCount})` : ''}
        </Button>
      )}
    </nav>
  )

  /**
   * 窄屏的排放入口**单独一行**，不塞进页签条：
   * 🔴 页签条是 `overflow-x-auto`，把排行放在最右会在 390px 上被挤出可视区，
   *    用户以为「窄屏没有排行」。单独一行也给了它 `aria-expanded` 与展开区域关联。
   */
  const narrowRankBar = !wide ? (
    <div className="border-b border-ink-700 px-3 py-1.5 sm:px-4">
      <Button size="sm" variant="toggle" selected={rankOpen} aria-expanded={rankOpen} aria-controls="community-rank-inline"
        onClick={() => setRankOpen((v) => !v)}>
        码字排行<ChevronDown size={12} className={`transition-transform ${rankOpen ? 'rotate-180' : ''}`} />
      </Button>
    </div>
  ) : null

  const content = (
    <>
      {!endpointReady && (
        <Notice kind="warn">
          当前形态没有可用的云端连接：桌面版请先在「设置 → 云端账号」登录后再打开广场。本地写作与既有功能不受影响。
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="warn">{notice}</Notice>}
      {signedIn === false && tab === 'feed' && (
        <Notice>你现在未登录：可以浏览广场，但不能投稿、评论或参与排行。</Notice>
      )}

      {!wide && rankOpen && (
        <div id="community-rank-inline" className="rounded-xl border border-ink-700 bg-ink-900/40 p-3">
          {/* 窄屏展开只给前 5 名并隐藏长篇说明：再多会把正文挤出首屏 */}
          <RankPanel compact dense max={5} onOpenSettings={openSettings} />
        </div>
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
      {tab === 'settings' && canWrite && <SettingsPanel accountId={cloudAccountId} onProfileChanged={setProfile} />}
      {tab === 'admin' && canAdmin && <AdminPanel onTitle={setAdminCount} />}
    </>
  )

  const shell = (
    <div ref={hostRef} className={shellClass}>
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-16 font-semibold text-ink-100">
            投稿广场
            {square && !square.open && <span className="rounded-full border border-amber/40 px-2 py-0.5 text-11 font-normal text-amber">暂停开放</span>}
          </h2>
          <p className="mt-0.5 text-11 text-ink-400">分享你愿意公开的文字片段；默认匿名展示，审核通过后公开。</p>
        </div>
        {mode === 'overlay' && onClose && (
          <Button variant="ghost" iconOnly onClick={onClose} aria-label="关闭投稿广场"><X size={18} /></Button>
        )}
      </header>

      {nav}
      {narrowRankBar}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className={`mx-auto w-full px-3 py-4 sm:px-5 ${tab === 'feed' ? 'max-w-4xl' : 'max-w-3xl'} space-y-3`}>
            {content}
          </div>
        </div>
        {wide && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-ink-700 bg-ink-900/30 px-3 py-4 xl:w-80">
            <RankPanel compact onOpenSettings={openSettings} />
          </aside>
        )}
      </div>

      <footer className="border-t border-ink-700 px-3 py-2 text-11 text-ink-400 sm:px-4">
        {WEB_CLOUD ? '网页云端账号' : guest ? '游客浏览' : '桌面 / 便携版'} · 内容由管理员人工确认后发布；社区服务不可用不影响本地写作。
      </footer>
    </div>
  )

  // 浮层形态：铺满屏、可关闭；页签形态直接占满内容区（不能 fixed，否则盖住侧栏）
  if (mode === 'overlay') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-2 sm:p-6"
        style={{ zIndex: Z.modal }} role="dialog" aria-modal="true" aria-label="投稿广场">
        {shell}
      </div>
    )
  }
  return shell
}

/** 供测试引用：当前页签类型（避免测试与实现各写一套字符串） */
export type CommunityTabId = Tab | RankTab