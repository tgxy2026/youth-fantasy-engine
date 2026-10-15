import { useEffect, useRef, useState } from 'react'
import { Cloud, FolderOpen, LogOut, History, Server, HardDrive } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import HelpPopover from '@/components/common/HelpPopover'
import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import { enableDesktopCloudSync, disableDesktopCloudSync } from '@/lib/db'
import { getDesktopDataFilePath } from '@/lib/app/desktop'
import { STATUS_META } from '@/lib/sync/syncStatusMeta'
import {
  chooseDesktopCloudDir,
  getDesktopCloudStatus,
  getDesktopCloudBackupMeta,
  restoreDesktopFromCloudBackup,
  isDesktopCloudEnabled,
  getDesktopCloudTargetName,
  getDesktopCloudMode,
  getWebdavConfig,
  saveWebdavConfig,
  getS3Config,
  saveS3Config,
  type SyncStatus, type SyncDirHandle, type SyncMode,
} from '@/lib/sync/desktopCloudSync'
import { testWebdav } from '@/lib/sync/webdavTransport'
import { testS3 } from '@/lib/sync/s3Transport'
import SyncConflictCenter from '@/components/app/SyncConflictCenter'

/** 行内按钮基线样式（主组件与子表单共用）。 */
const rowBtn =
  'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 text-12 transition-colors disabled:opacity-60 '

/**
 * 「云盘文件同步」操作条（#032：改为选目录即用；3.0.2：新增私有网盘 / NAS 直连）。
 *
 * 三档传输模式（全程**不依赖我们的服务器**）：
 *  ① 目录中转：加密文件落在本地网盘同步目录，由 OneDrive / WPS / 百度网盘 客户端搬运
 *  ② WebDAV 直连：直接读写私人网盘 / NAS（坚果云 / Nextcloud / 群晖 / 极空间 …）
 *  ③ S3 兼容直连：MinIO / Cloudflare R2 / 阿里云 OSS / 腾讯云 COS …
 *
 * 两种形态：
 * - variant='panel'：用于左下角「数据坞」DataDock 内，等宽铺满、行距宽松。
 * - variant='sidebar'：用于侧栏底部内嵌，紧凑排版、不铺满宽度（避免撑破侧栏）。
 */
export default function CloudFileSyncBar({ variant = 'panel' }: { variant?: 'panel' | 'sidebar' }) {
  const [busy, setBusy] = useState(false)

  // 冲突告知：冲突副本由 db/core.ts 的 saveConflictCopy 落到**当前平台本地存储**的 meta
  // （key 以 syncConflict: 开头，受 isExcludedMetaKey 保护、永不上云）。
  useEffect(() => {
    const onConflict = () =>
      showToast('检测到同步冲突：云端那一版已另存为本地副本，你的本地修改未被覆盖', 'error', 6000)
    const onSaveError = () =>
      showToast('同步冲突副本保存失败：请立即导出项目备份并检查本机存储空间', 'error', 10000)
    window.addEventListener('yfe:sync-conflict', onConflict)
    window.addEventListener('yfe:sync-conflict-save-error', onSaveError)
    return () => {
      window.removeEventListener('yfe:sync-conflict', onConflict)
      window.removeEventListener('yfe:sync-conflict-save-error', onSaveError)
    }
  }, [])
  const [connected, setConnected] = useState(() => isDesktopCloudEnabled())
  const [mode, setMode] = useState<SyncMode>(() => getDesktopCloudMode())
  const [status, setStatus] = useState<SyncStatus>(getDesktopCloudStatus())
  const [targetName, setTargetName] = useState<string | null>(null)
  const [backupDay, setBackupDay] = useState<string | null>(null)
  const handleRef = useRef<SyncDirHandle | null>(null)
  const inSidebar = variant === 'sidebar'

  // 未开启时：展示哪一种配置表单（三选一）
  const [form, setForm] = useState<SyncMode>(() => getDesktopCloudMode())
  // 🔴 2026-10-14 主人反馈：窗口模式下侧栏窄且不可滚，WebDAV / S3 表单塞在侧栏里底部被裁掉。
  //    ⇒ 配置表单改为**弹窗**（Modal 自带 85vh 滚动 + Esc 关闭 + foldVh 缩放适配），
  //      侧栏只留三档选择与入口按钮。目录中转无表单，不受影响。
  const [configOpen, setConfigOpen] = useState(false)

  useEffect(() => {
    const onStatus = () => setStatus(getDesktopCloudStatus())
    window.addEventListener('yfe:sync-status', onStatus)
    getDesktopCloudTargetName()
      .then((n) => n && setTargetName(n))
      .catch(() => {})
    const tick = () => setBackupDay(getDesktopCloudBackupMeta()?.day ?? null)
    tick()
    const id = setInterval(tick, 3000)
    return () => {
      window.removeEventListener('yfe:sync-status', onStatus)
      clearInterval(id)
    }
  }, [])

  const meta = STATUS_META[status]

  /** 开启成功后统一收尾：刷新状态 + reload（同步层切换后必须整页重载）。 */
  const finishEnable = (msg: string) => {
    setConnected(true)
    setMode(getDesktopCloudMode())
    showToast(msg, 'success', 6000)
    setTimeout(() => location.reload(), 800)
  }

  /** 目录中转：选择目录并直接开启（无需任何凭据）。 */
  const pickDir = async () => {
    if (busy) return
    let reloading = false
    try {
      const res = await chooseDesktopCloudDir()
      if (!res) return // 用户取消
      // 🔴 两套同步别指同一个目录：①「改数据文件位置」＝明文 JSON（含 AI apiKey 明文）
      //    ②「云盘文件同步」＝加密 .yfe。指到同一目录时，明文库会被网盘客户端一起传上云，
      //    而且两边会互相覆盖（详见 docs/2.1.1-审计修复记录.md §四）。
      {
        const dataFilePath = await getDesktopDataFilePath()
        const BS = String.fromCharCode(92) // 反斜杠：不用正则，免得转义满天飞
        const norm = (p: string) => p.split(BS).join('/').replace(/\/+$/, '').toLowerCase()
        const dirOf = (p: string) => norm(p).split('/').slice(0, -1).join('/')
        if (dataFilePath && typeof res.handle === 'string' && dirOf(dataFilePath) === norm(res.handle)) {
          const go = await confirmDialog({
            title: '这个目录里放着你本机的数据文件',
            message:
              '该目录正是数据文件（youth-fantasy-engine-data.json，含 AI 接口密钥的明文）所在的位置。\n\n' +
              '云盘客户端会把整个目录上传，明文库也会跟着上云；而且「数据文件位置」与「云盘文件同步」' +
              '指向同一目录会互相覆盖。\n\n建议另选一个空目录专门放同步文件。确定仍要用这个目录吗？',
            confirmText: '仍要使用',
            danger: true,
          })
          if (!go) return
        }
      }
      handleRef.current = res.handle
      setTargetName(res.name)
      setBusy(true)
      await enableDesktopCloudSync(res.handle, 'dir')
      reloading = true
      finishEnable('云盘文件同步已开启：' + res.name + '\n此后数据会自动保存到该目录，把目录放进网盘同步即可跨设备继续。')
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string } | null
      if (err && err.name === 'AbortError') showToast('已取消选择同步目录', 'info')
      else showToast('开启失败：' + (err?.message ?? String(e)), 'error')
    } finally {
      if (!reloading) setBusy(false)
    }
  }

  /** 私有网盘（WebDAV / S3）：填好配置后开启。 */
  const enableRemote = async (m: 'webdav' | 's3', cfgReady: boolean, label: string) => {
    if (busy) return
    if (!cfgReady) {
      showToast('请先填好并测试连接', 'error')
      return
    }
    setBusy(true)
    try {
      await enableDesktopCloudSync(null, m)
      setTargetName(await getDesktopCloudTargetName())
      finishEnable(label + ' 同步已开启：数据会自动读写你所填的网盘，跨设备登录同一账号即可继续。')
    } catch (e: unknown) {
      const err = e as { message?: string } | null
      showToast('开启失败：' + (err?.message ?? String(e)), 'error')
      setBusy(false)
    }
  }

  const onDisable = async () => {
    const ok = await confirmDialog({
      title: '关闭同步',
      message: '将停止跨设备同步并切回本机存储。\n远端 / 目录里的同步数据会保留，重新开启可继续使用。确定吗？',
      confirmText: '关闭',
      danger: true,
    })
    if (!ok) return
    await disableDesktopCloudSync() // 先 flush + 镜像进本地，再切回（见 db/core.ts 的说明）
    showToast('已关闭同步，切回本机存储', 'success')
    setTimeout(() => location.reload(), 400)
  }

  const onRestore = async () => {
    const ok = await confirmDialog({
      title: '从同步备份恢复',
      message: `将把当前数据回滚到每日备份（${backupDay || '未知日期'}）并重新同步。\n此操作会丢弃该备份时间点之后的本机改动，确定继续吗？`,
      confirmText: '恢复',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const done = await restoreDesktopFromCloudBackup()
      if (done) {
        showToast('已从备份恢复，正在重新同步…', 'success')
        setTimeout(() => location.reload(), 600)
      } else {
        showToast('暂无可用的同步备份', 'error')
        setBusy(false)
      }
    } catch {
      showToast('恢复失败，请稍后重试', 'error')
      setBusy(false)
    }
  }

  const headCls = inSidebar
    ? 'flex items-center gap-1.5 pt-1 text-12 text-ink-300'
    : 'flex items-center gap-1.5 text-xs text-ink-300'

  return (
    <div className={inSidebar ? 'flex flex-col gap-1.5' : 'flex flex-col gap-1.5'}>
      {/* 标题行 */}
      <div className={headCls}>
        <Cloud size={13} className="text-info/90" />
        <span className="font-medium">云盘文件同步</span>
        {connected && (
          <span className="ml-auto flex items-center gap-1.5 text-11 text-ink-300">
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.text || '待命'}
          </span>
        )}
        <SyncConflictCenter compact />
        <HelpPopover title="云盘文件同步说明" side="right" width="24rem">
          {`支持三档同步方式，本软件全程不经过自建服务器：

① 目录中转：把数据实时保存为加密文件（青春幻想引擎-同步数据.yfe）落到你选定的同步文件夹，
由 OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等客户端负责跨设备搬运。

② WebDAV 直连：直接读写你的私人网盘 / NAS（坚果云 / Nextcloud / 群晖 Synology / 极空间 等），
需要填服务器地址、账号密码。

③ S3 兼容直连：直接读写对象存储（MinIO / Cloudflare R2 / 阿里云 OSS / 腾讯云 COS 等），
需要填端点、桶名、AccessKey、SecretKey。

怎么用：在两台设备上填同一套配置即可自动同步。
断网或网盘未同步时自动回退本机存储、编辑不丢；远端更新后会自动拉取合并。
每日保留一份滚动备份，可点「从同步备份恢复」回退到当天/昨日的检查点。

安全提示：文件使用内置密钥加密，可防止被明文浏览或误看，但密钥是公开的（源码常量），
不足以对抗蓄意破解。密码 / SecretKey 只存本机（不会随同步文件上传）。请勿把同步目录设为公开共享文件夹。`}
        </HelpPopover>
      </div>

      {!connected ? (
        /* —— 未开启：先选方式；WebDAV / S3 点按钮开**弹窗**填写（侧栏窄且不可滚，表单放不下） —— */
        <>
          <ModeTabs value={form} onChange={(m) => { setForm(m); setConfigOpen(false) }} />
          {form === 'dir' && (
            <>
              <Button
                variant="bare"
                onClick={pickDir}
                disabled={busy}
                title="选择一个网盘同步目录来开启跨设备同步（如 OneDrive / WPS 云盘 / 坚果云的文件夹）"
                className={rowBtn + 'border-success/40 bg-success/10 text-success hover:bg-success/20 disabled:opacity-60'}
              >
                <FolderOpen size={14} />
                {busy ? '开启中…' : '选择同步目录'}
              </Button>
              <p className="text-11 leading-snug text-ink-500">
                选一个网盘文件夹即可开启；两台设备选同一个目录，就会互相同步
              </p>
            </>
          )}
          {form === 'webdav' && (
            <>
              <Button
                variant="bare"
                onClick={() => setConfigOpen(true)}
                disabled={busy}
                title="打开 WebDAV 配置窗口（可滚动，窗口模式下也能完整填写）"
                className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-amber/50'}
              >
                <Server size={14} />
                配置 WebDAV 连接
              </Button>
              <p className="text-11 leading-snug text-ink-500">坚果云 / Nextcloud / 群晖 等 · 点击打开配置窗口</p>
            </>
          )}
          {form === 's3' && (
            <>
              <Button
                variant="bare"
                onClick={() => setConfigOpen(true)}
                disabled={busy}
                title="打开 S3 兼容配置窗口（可滚动，窗口模式下也能完整填写）"
                className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-amber/50'}
              >
                <HardDrive size={14} />
                配置 S3 兼容连接
              </Button>
              <p className="text-11 leading-snug text-ink-500">MinIO / Cloudflare R2 / 阿里云 OSS / 腾讯云 COS 等 · 点击打开配置窗口</p>
            </>
          )}
          <Modal
            open={!connected && configOpen && (form === 'webdav' || form === 's3')}
            onClose={() => setConfigOpen(false)}
            title={form === 'webdav' ? '配置 WebDAV 直连' : '配置 S3 兼容直连'}
            icon={form === 'webdav' ? <Server size={15} /> : <HardDrive size={15} />}
            width="md"
          >
            {form === 'webdav'
              ? <WebdavForm busy={busy} onEnable={(ready) => enableRemote('webdav', ready, 'WebDAV')} />
              : <S3Form busy={busy} onEnable={(ready) => enableRemote('s3', ready, 'S3')} />}
          </Modal>
        </>
      ) : (
        /* —— 已开启：状态 + 目标名 + 操作 —— */
        <>
          <div className="flex items-center gap-1.5 text-11 text-ink-400" title={targetName ? '当前同步目标' : undefined}>
            {mode === 'dir' ? <FolderOpen size={12} className="shrink-0 text-ink-500" />
              : mode === 'webdav' ? <Server size={12} className="shrink-0 text-ink-500" />
              : <HardDrive size={12} className="shrink-0 text-ink-500" />}
            <span className="truncate">{targetName || (mode === 'dir' ? '未选择目录' : '未配置')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="bare"
              onClick={onDisable}
              disabled={busy}
              title="关闭同步并切回本机存储"
              className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-rose-400/60 hover:text-rose-300'}
            >
              <LogOut size={13} />
              关闭
            </Button>
          </div>
          {backupDay && (
            <Button
              variant="bare"
              onClick={onRestore}
              disabled={busy}
              title={`每日备份（${backupDay}）· 点击回滚到该检查点`}
              className={rowBtn + 'border-success/30 bg-success/10 text-success hover:bg-success/20'}
            >
              <History size={13} />
              从备份恢复（{backupDay}）
            </Button>
          )}
        </>
      )}
    </div>
  )
}

/** 三档方式选择（未开启时）。 */
function ModeTabs({ value, onChange }: { value: SyncMode; onChange: (m: SyncMode) => void }) {
  const items: { key: SyncMode; label: string }[] = [
    { key: 'dir', label: '目录中转' },
    { key: 'webdav', label: 'WebDAV' },
    { key: 's3', label: 'S3 兼容' },
  ]
  return (
    <div className="flex gap-1 rounded-lg border border-ink-700/70 bg-ink-900/40 p-0.5">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={
            'h-7 flex-1 rounded-md text-11 transition-colors ' +
            (value === it.key
              ? 'bg-amber/20 text-amber'
              : 'text-ink-400 hover:bg-ink-800/60 hover:text-ink-200')
          }
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

/** 简单输入行（受控）。 */
function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <label className="flex flex-col gap-0.5 text-11 text-ink-400">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border border-ink-700/80 bg-ink-900/60 px-2 text-12 text-ink-100 outline-none placeholder:text-ink-600 focus:border-amber/60"
      />
    </label>
  )
}

/** WebDAV 配置表单（渲染在配置弹窗内 —— Modal 自带滚动，无需折叠）。 */
function WebdavForm({ busy, onEnable }: { busy: boolean; onEnable: (ready: boolean) => void }) {
  const [baseUrl, setBaseUrl] = useState('')
  const [remotePath, setRemotePath] = useState('youth-fantasy-engine/青春幻想引擎-同步数据.yfe')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [trustSelfSigned, setTrustSelfSigned] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)

  useEffect(() => {
    getWebdavConfig().then((c) => {
      if (c) {
        setBaseUrl(c.baseUrl); setRemotePath(c.remotePath); setUsername(c.username); setPassword(c.password)
        setTrustSelfSigned(c.trustSelfSigned === true); setTested(true)
      }
    }).catch(() => {})
  }, [])

  const ready = !!(baseUrl.trim() && remotePath.trim())
  const cfg = () => ({ baseUrl, remotePath, username, password, trustSelfSigned })
  const onTest = async () => {
    if (!ready) { showToast('请先填写服务器地址与远端路径', 'error'); return }
    setTesting(true)
    const r = await testWebdav(cfg())
    setTesting(false)
    setTested(r.ok)
    showToast(r.message, r.ok ? 'success' : 'error', 6000)
    if (r.ok) await saveWebdavConfig(cfg()).catch(() => {})
  }
  const onGo = async () => {
    if (!tested) { showToast('请先点「测试连接」确认可用', 'error'); return }
    await saveWebdavConfig(cfg()).catch(() => {})
    onEnable(true)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Field label="服务器地址" value={baseUrl} onChange={(v) => { setBaseUrl(v); setTested(false) }} placeholder="https://dav.jianguoyun.com/dav/" />
      <Field label="远端路径（相对地址）" value={remotePath} onChange={(v) => { setRemotePath(v); setTested(false) }} placeholder="yfe/青春幻想引擎-同步数据.yfe" />
      <Field label="用户名" value={username} onChange={(v) => { setUsername(v); setTested(false) }} placeholder="账号邮箱" />
      <Field label="密码 / 应用密码" value={password} onChange={(v) => { setPassword(v); setTested(false) }} placeholder="应用专用密码" type="password" />
      <TrustSelfSignedToggle
        checked={trustSelfSigned}
        onChange={(v) => { setTrustSelfSigned(v); setTested(false) }}
        tip="自建 NAS / 群晖 用自签证书时勾选；公共网盘（坚果云 / Nextcloud 官方托管）无需勾选"
      />
      <div className="flex gap-1.5">
        <Button variant="bare" onClick={onTest} disabled={testing || busy} className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-amber/50'}>
          {testing ? '测试中…' : tested ? '重新测试' : '测试连接'}
        </Button>
        <Button variant="bare" onClick={onGo} disabled={busy || !tested} className={rowBtn + 'border-success/40 bg-success/10 text-success hover:bg-success/20'}>
          开启同步
        </Button>
      </div>
      <p className="text-11 leading-snug text-ink-500">密码仅存本机、不会随同步文件上传。建议用「应用专用密码」而非主密码。</p>
    </div>
  )
}

/**
 * 「信任自签证书」开关（WebDAV / S3 共用）。
 * 🔴 这是**安全取舍**：文案必须同时讲清「什么时候要勾」与「勾了意味着什么」，不能只写开关名。
 */
function TrustSelfSignedToggle({ checked, onChange, tip }: { checked: boolean; onChange: (v: boolean) => void; tip: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex items-center gap-1.5 text-11 text-ink-400">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        信任自签证书（自建 NAS / MinIO 常用）
      </label>
      <p className={checked ? 'text-11 leading-snug text-amber/90' : 'text-11 leading-snug text-ink-600'}>
        {checked
          ? '⚠️ 已开启：将放行「证书链不受信（自签）」的连接。仅对本同步通道生效，AI / 检索等其他流量不受影响；主机名不符、证书过期或已吊销仍会被拒绝。若同步地址是公网服务器，请勿勾选。'
          : tip}
      </p>
    </div>
  )
}

/** S3 兼容配置表单（渲染在配置弹窗内 —— Modal 自带滚动，无需折叠）。 */
function S3Form({ busy, onEnable }: { busy: boolean; onEnable: (ready: boolean) => void }) {
  const [endpoint, setEndpoint] = useState('')
  const [bucket, setBucket] = useState('')
  const [objectKey, setObjectKey] = useState('youth-fantasy-engine/青春幻想引擎-同步数据.yfe')
  const [region, setRegion] = useState('us-east-1')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [style, setStyle] = useState<'path' | 'virtual'>('path')
  const [trustSelfSigned, setTrustSelfSigned] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)

  useEffect(() => {
    getS3Config().then((c) => {
      if (c) {
        setEndpoint(c.endpoint); setBucket(c.bucket); setObjectKey(c.objectKey)
        setRegion(c.region); setAccessKey(c.accessKey); setSecretKey(c.secretKey)
        setStyle(c.style || 'path'); setTrustSelfSigned(c.trustSelfSigned === true); setTested(true)
      }
    }).catch(() => {})
  }, [])

  const ready = !!(endpoint.trim() && bucket.trim() && accessKey.trim() && secretKey.trim())
  const cfg = () => ({ endpoint, bucket, objectKey, region, accessKey, secretKey, style, trustSelfSigned })
  const onTest = async () => {
    if (!ready) { showToast('请先填写端点、桶名、AccessKey、SecretKey', 'error'); return }
    setTesting(true)
    const r = await testS3(cfg())
    setTesting(false)
    setTested(r.ok)
    showToast(r.message, r.ok ? 'success' : 'error', 6000)
    if (r.ok) await saveS3Config(cfg()).catch(() => {})
  }
  const onGo = async () => {
    if (!tested) { showToast('请先点「测试连接」确认可用', 'error'); return }
    await saveS3Config(cfg()).catch(() => {})
    onEnable(true)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Field label="端点" value={endpoint} onChange={(v) => { setEndpoint(v); setTested(false) }} placeholder="https://xxx.r2.cloudflarestorage.com 或 http://192.168.1.10:9000" />
      <Field label="桶名" value={bucket} onChange={(v) => { setBucket(v); setTested(false) }} placeholder="my-bucket" />
      <Field label="对象键（含前缀）" value={objectKey} onChange={(v) => { setObjectKey(v); setTested(false) }} placeholder="yfe/青春幻想引擎-同步数据.yfe" />
      <Field label="区域 Region" value={region} onChange={(v) => { setRegion(v); setTested(false) }} placeholder="us-east-1" />
      <Field label="AccessKey" value={accessKey} onChange={(v) => { setAccessKey(v); setTested(false) }} placeholder="AKIA…" />
      <Field label="SecretKey" value={secretKey} onChange={(v) => { setSecretKey(v); setTested(false) }} placeholder="…" type="password" />
      <label className="flex items-center gap-1.5 text-11 text-ink-400">
        <input type="checkbox" checked={style === 'virtual'} onChange={(e) => { setStyle(e.target.checked ? 'virtual' : 'path'); setTested(false) }} />
        虚拟主机风格（AWS 默认；MinIO 通常用 path 风格）
      </label>
      <TrustSelfSignedToggle
        checked={trustSelfSigned}
        onChange={(v) => { setTrustSelfSigned(v); setTested(false) }}
        tip="自建 MinIO / NAS 用自签证书时勾选；Cloudflare R2 / 阿里云 OSS / 腾讯云 COS 等公网对象存储无需勾选"
      />
      <div className="flex gap-1.5">
        <Button variant="bare" onClick={onTest} disabled={testing || busy} className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-amber/50'}>
          {testing ? '测试中…' : tested ? '重新测试' : '测试连接'}
        </Button>
        <Button variant="bare" onClick={onGo} disabled={busy || !tested} className={rowBtn + 'border-success/40 bg-success/10 text-success hover:bg-success/20'}>
          开启同步
        </Button>
      </div>
      <p className="text-11 leading-snug text-ink-500">SecretKey 仅存本机、不会随同步文件上传。</p>
    </div>
  )
}
