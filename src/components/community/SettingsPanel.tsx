// 投稿广场 · 昵称、匿名与排行授权（3.5.0）
//
// 🔴 这里的三组选择彼此独立：投稿展示 / 评论展示 / 排行展示。
//    切换只影响**新提交**；已发布内容要单独改（「我的投稿 → 编辑」重选展示方式）。
//    这是规划 §10 的口径，界面上必须说清楚，否则用户会以为历史内容也被改掉了。
// 🔴 排行同步默认关闭，与云同步资格无关；关闭 = 撤回，服务端立即删除已上传数据。

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/common/Button'
import { activateSyncCode, fetchProfile, updateProfile } from '@/lib/community/api'
import { getAllProjects } from '@/lib/db/projects'
import { COMMUNITY_LIMITS, charCount } from '@/lib/community/limits'
import { cnDateKey, pendingRankDeltaCount, readLedger, summarizeLedger } from '@/lib/community/rankLedger'
import { uploadRank } from '@/lib/community/rankUpload'
import { accountKeyOf } from '@/lib/community/draft'
import type { CommunityProfile, DisplayMode } from '@/lib/community/types'
import { Field, Notice, StatusPill, errorText, formatTime } from '@/components/community/ui'

interface Props {
  accountId?: string
  onProfileChanged?: (profile: CommunityProfile) => void
}

export default function SettingsPanel({ accountId, onProfileChanged }: Props) {
  const [profile, setProfile] = useState<CommunityProfile | null>(null)
  const [nickname, setNickname] = useState('')
  const [activationCode, setActivationCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [ledger, setLedger] = useState<{ total: number; days: number } | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const p = (await fetchProfile()).profile
      setProfile(p)
      setNickname(p.nickname || '')
      onProfileChanged?.(p)
    } catch (e) { setError(errorText(e)) }
  }, [onProfileChanged])

  useEffect(() => { void load() }, [load])

  // 本地账本概况：只展示合计与天数，不展示任何项目名
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await getAllProjects()
        let total = 0
        let days = 0
        for (const p of list) {
          const rows = await readLedger(p.id)
          const s = summarizeLedger(rows, profile?.rankOptInAt ? cnDateKey(profile.rankOptInAt) : undefined)
          total += s.total
          days += s.days
        }
        if (!cancelled) setLedger({ total, days })
      } catch { if (!cancelled) setLedger(null) }
    })()
    return () => { cancelled = true }
  }, [profile?.rankOptInAt])

  async function save(patch: Partial<CommunityProfile>, message: string) {
    setBusy(true); setError(''); setNotice('')
    try {
      const r = await updateProfile(patch)
      setProfile(r.profile)
      onProfileChanged?.(r.profile)
      setNotice(message)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  async function saveNickname() {
    const n = nickname.trim()
    if (!n) { setError('请填写昵称'); return }
    if (charCount(n) > COMMUNITY_LIMITS.nicknameMax) { setError(`昵称最多 ${COMMUNITY_LIMITS.nicknameMax} 个字符`); return }
    await save({ nickname: n }, '昵称已更新；已选择显示昵称的投稿、评论和排行也会显示新昵称。')
  }

  async function toggleRank(next: boolean) {
    setBusy(true); setError(''); setNotice('')
    try {
      const r = await updateProfile({ rankOptIn: next })
      setProfile(r.profile)
      onProfileChanged?.(r.profile)
      if (next) {
        const up = await uploadRank({ force: true, accountKey: accountKeyOf(accountId) })
        if (up.error) { setError(up.error); return }
        setNotice((up.accepted > 0
        ? `已开启排行同步，本次上传 ${up.accepted} 条记录（从开启后开始统计）${up.remaining > 0 ? `；还有 ${up.remaining} 条将在下一轮继续上传` : ''}。`
        : '已开启排行同步，将从现在开始统计；历史数据不会上传。') + (up.incompleteFirstDay ? ' 开启当天的旧记录缺少精确时间，暂不计入排行。' : ''))
      } else {
        setNotice('已关闭排行同步，服务端已删除你上传的排行数据。')
      }
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  if (!profile) {
    return <div className="space-y-2">{error ? <Notice kind="error">{error}</Notice> : <Notice>正在读取设置…</Notice>}</div>
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-13 font-semibold text-ink-100">云端同步资格</h3>
        <p className="text-12 text-ink-300">已有邀请码可在这里开通同步资格。开通后作品不会自动上传或合并；网页版请重新打开应用后按提示选择存储位置。</p>
        <div className="flex gap-2">
          <input aria-label="云端同步邀请码" type="password" autoComplete="off" value={activationCode} onChange={(e) => setActivationCode(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-13 text-ink-100" />
          <Button size="sm" disabled={busy || !activationCode.trim()} onClick={() => void (async () => {
            setBusy(true); setError(''); setNotice('')
            try { const r = await activateSyncCode(activationCode); setActivationCode(''); setNotice(r.alreadyActive ? '账号已有云端同步资格。' : '已开通云端同步资格。请重新打开应用；本机作品不会自动上传。') }
            catch (e) { setError(errorText(e)) } finally { setBusy(false) }
          })()}>开通</Button>
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="text-13 font-semibold text-ink-100">社区昵称</h3>
        <Field label="昵称" hint={`${charCount(nickname)} / ${COMMUNITY_LIMITS.nicknameMax} 个字符。昵称与登录名完全分离，匿名展示时不会输出登录名。`} htmlFor="community-nickname">
          <div className="flex gap-2">
            <input id="community-nickname" value={nickname} maxLength={COMMUNITY_LIMITS.nicknameMax * 2}
              onChange={(e) => setNickname(e.target.value)} placeholder="例如：雨夜写字的人"
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-13 text-ink-100" />
            <Button size="sm" disabled={busy} onClick={() => void saveNickname()}>保存</Button>
          </div>
        </Field>
        {profile.nickname && <p className="text-11 text-ink-400">当前昵称：{profile.nickname}（更新于 {formatTime(profile.updatedAt)}）</p>}
      </section>

      <section className="space-y-2">
        <h3 className="text-13 font-semibold text-ink-100">公开方式</h3>
        <Notice>
          投稿和评论的默认展示方式影响之后的新提交；已发布投稿可在「我的」里直接切换展示方式。
          排行展示方式会更新当前榜单；修改昵称也会影响已选择显示昵称的内容。
          匿名展示不会公开登录账号，但正文内容、写作数量等信息仍可能让他人推测身份。
        </Notice>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ['postDisplay', '投稿展示'],
            ['commentDisplay', '评论展示'],
            ['rankDisplay', '排行展示'],
          ] as const).map(([key, label]) => (
            <label key={key} className="space-y-1 text-12 text-ink-200">{label}
              <select aria-label={label} value={profile[key]} disabled={busy}
                onChange={(e) => void save({ [key]: e.target.value as DisplayMode }, `${label}已更新`)}
                className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100">
                <option value="anonymous">匿名用户（默认）</option>
                <option value="nickname">显示昵称</option>
              </select>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-13 font-semibold text-ink-100">码字排行榜</h3>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={profile.rankOptIn ? 'ok' : 'neutral'}>{profile.rankOptIn ? '已参与' : '未参与（默认关闭）'}</StatusPill>
          {profile.rankOptIn && profile.rankOptInAt > 0 && <span className="text-11 text-ink-400">自 {formatTime(profile.rankOptInAt)} 起统计</span>}
        </div>
        <Notice kind="warn">
          参与后只上传「日期 + 每个项目的含标点净增量」这类最小数据，不上传正文、标题或项目名称。
          它是独立的社区统计能力：不开通云端作品同步也能用，开启排行也不会同步你的作品。
          关闭即撤回已上传数据；重新开启不会恢复旧排行。
        </Notice>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void toggleRank(!profile.rankOptIn)}>
            {profile.rankOptIn ? '关闭并撤回排行数据' : '开启排行同步'}
          </Button>
          {profile.rankOptIn && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
              void (async () => {
                setBusy(true); setError(''); setNotice('')
                try {
                  const r = await uploadRank({ force: true, accountKey: accountKeyOf(accountId) })
                  if (r.error && r.skipped !== 'offline') { setError(r.error); return }
                  setNotice(r.skipped === 'offline'
                    ? `网络不可用，未完成上报${r.error ? `（${r.error}）` : ''}；记录仍保存在本机，稍后会自动重试。`
                    : `本次上报 ${r.sent} 条，服务端接受 ${r.accepted} 条${r.rejected.length ? `，拒绝 ${r.rejected.length} 条` : ''}${r.remaining > 0 ? `，还有 ${r.remaining} 条待下一轮` : ''}。${r.incompleteFirstDay ? '开启当天的旧记录缺少精确时间，暂不计入排行。' : ''}`)
                } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
              })()
            }}>立即同步</Button>
          )}
          {ledger && (
            <span className="text-11 text-ink-400">本机已记录 {ledger.days} 天 / 合计 {ledger.total.toLocaleString('zh-CN')} 字（含标点、仅正文）</span>
          )}
          {pendingRankDeltaCount() > 0 && (
            <span className="text-11 text-amber">有 {pendingRankDeltaCount()} 条本机增量等待补记，下次保存或上报时会自动重试。</span>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-13 font-semibold text-ink-100">隐私说明</h3>
        <ul className="list-disc space-y-1 pl-5 text-11 leading-relaxed text-ink-300">
          <li>公开页面不显示登录账号、内部账号 ID 或可跨内容关联的固定标识；管理员在履职范围内可关联账号用于审核与申诉。</li>
          <li>选择昵称可能让别人把你在不同投稿、评论或排行中的内容关联起来；匿名不能消除正文本身带来的识别风险。</li>
          <li>草稿保存在本机（按账号与设备隔离），不跨设备同步；换设备后看不到旧草稿。</li>
          <li>已公开的内容可能已被他人看到或保存，撤回只能停止继续展示，不能保证从别人的记录里消失。</li>
        </ul>
      </section>

      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}
    </div>
  )
}
