/**
 * 看板娘设置（2.6.1 · R1）—— 项目管理首页右下角那位（古风立绘）的开关与自定义图片。
 *
 * 【两套资源别搞混】
 *   本弹窗只管 ProjectHub 的首页看板娘（`src/assets/jiewenji-gufeng.png`）；
 *   正文页右侧的颉文姬 Q 版精灵是另一套（JieWenJiSprite.tsx，开关在颉文姬面板底部），
 *   2.6.1 拍板**不做**它的自定义。
 *
 * 【存储】走 uiPrefs 的 `yfe-ui:` 命名空间（本机偏好，不进项目数据、不随云同步走）——
 *   看板娘是界面偏好不是作品数据；200KB 级 dataURL 也不该进整库 JSON 去跟网盘同步。
 *   键：`home-mascot-custom`（dataURL，空 = 用内置默认）。
 *
 * 【压缩】复用角色立绘管线 `imagePortrait.readPortraitFile`（等比缩放 512×910 + WebP 阶梯降质
 *   ≤200KB）—— 🔴 「图片先压缩再入库」是项目红线，这里不走 raw base64。
 */
import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import jiewenjiGufeng from '../assets/jiewenji-gufeng.png'
import { readPortraitFile, PORTRAIT_ACCEPT, PORTRAIT_MAX_INPUT_BYTES } from '../lib/imagePortrait'
import { usePersistedBool, readStringPref, writeStringPref } from '../lib/uiPrefs'

const CUSTOM_KEY = 'home-mascot-custom'
const DEFAULT_SRC = jiewenjiGufeng

export default function MascotSettingsDialog({ onClose, onSaved }: {
  onClose: () => void
  /** 保存后回调（ProjectHub 重读 localStorage 刷新立绘） */
  onSaved: () => void
}) {
  const [mascotHidden, setMascotHidden] = usePersistedBool('home-mascot-hidden', false)
  const [custom, setCustom] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setCustom(readStringPref(CUSTOM_KEY)) }, [])

  const save = (dataUrl: string | null) => {
    if (dataUrl) writeStringPref(CUSTOM_KEY, dataUrl)
    else { try { localStorage.removeItem('yfe-ui:' + CUSTOM_KEY) } catch { /* 同上：写失败不影响本会话 */ } }
    setCustom(dataUrl)
    onSaved()
  }

  const onFile = async (f: File) => {
    setErr('')
    setBusy(true)
    try {
      // 体积预检（imagePortrait 的口径：超限原图直接拒，避免读进内存才失败）
      if (f.size > PORTRAIT_MAX_INPUT_BYTES) {
        setErr(`原图请控制在 ${PORTRAIT_MAX_INPUT_BYTES / 1024 / 1024}MB 以内（会自动等比缩放）`)
        return
      }
      const res = await readPortraitFile(f)
      save(res.dataUrl)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '图片读取失败，换一张试试')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="看板娘设置"
      icon={<span className="text-amber">娘</span>}
      width={448}
      footerAlign="end"
      footer={
        <Button onClick={onClose} variant="secondary" size="md">完成</Button>
      }
    >
      <div className="space-y-4">
        {/* ① 显示开关 —— 沿用 home-mascot-hidden 的键与语义（默认显示），行为与旧 toggle 完全一致 */}
        <div className="flex items-center gap-2">
          <span className="text-12 text-ink-100">显示看板娘</span>
          <HelpPopover title="看板娘设置怎么用" width="22rem">
            {'项目管理首页右下角的那位古风立绘。关掉后首页不再显示；重新打开立即恢复。\n\n· 想换成自己的图：点「上传图片」，推荐透明背景的 PNG 竖幅立绘；\n· 图片会等比缩放并压缩到 200KB 以内存本机（不进项目数据、不随云盘同步）；\n· 「恢复默认」一键回到内置立绘。'}
          </HelpPopover>
          <div className="ml-auto">
            <Button
              variant="toggle"
              selected={!mascotHidden}
              onClick={() => { setMascotHidden(!mascotHidden); onSaved() }}
              size="sm"
            >
              {!mascotHidden ? '显示中' : '已隐藏'}
            </Button>
          </div>
        </div>

        {/* ② 预览（当前生效图：自定义优先，否则内置默认）—— 由 ProjectHub 传下来的当前生效图渲染 */}
        <PreviewBox custom={custom} />

        {/* ③ 上传 / 恢复默认 */}
        <div className="flex items-center gap-2">
          <input
            ref={fileRef} type="file"
            accept={PORTRAIT_ACCEPT}
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f) }}
          />
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? '处理中…' : '上传图片'}
          </Button>
          <Button size="sm" variant="ghost" disabled={!custom || busy} onClick={() => save(null)}>
            恢复默认
          </Button>
          {custom && <span className="text-10 text-success">已使用自定义图片</span>}
        </div>
        {err && <div className="text-11 text-danger">{err}</div>}

        {/* ④ 图片要求说明（社区反馈点：要说清透明背景 / 规格比例） */}
        <div className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2.5 text-11 leading-relaxed text-ink-400">
          <div className="mb-1 font-medium text-ink-300">图片要求</div>
          · 推荐透明背景的 <b className="text-ink-200">PNG</b> —— 非透明图会带着底色压在页面上；<br />
          · 竖幅立绘效果最好（内置图约 1:2.2），展示宽度上限 380px、高度不超过屏幕 82%；<br />
          · 原图 ≤10MB，上传后自动等比缩放（长边 910）并压到 200KB 以内；<br />
          · 支持 PNG / JPG / WebP；图片只存本机浏览器，不上传任何服务器。
        </div>
      </div>
    </Modal>
  )
}

/** 预览框：无自定义 → 内置默认图（与 ProjectHub 同一资源）；有 → 自定义 dataURL */
function PreviewBox({ custom }: { custom: string | null }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-ink-700 bg-ink-900/60 p-3" style={{ minHeight: 160 }}>
      <img
        src={custom ?? DEFAULT_SRC}
        alt="看板娘预览"
        draggable={false}
        className="h-40 w-auto select-none object-contain"
      />
    </div>
  )
}
