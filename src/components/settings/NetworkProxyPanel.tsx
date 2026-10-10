/**
 * 网络代理设置（2026-09-28 · 社区需求）—— 挂在「模型设置」页，模型配置下方、AI 额度上方。
 *
 * 【合规口径 · 动文案前必读】
 * 本面板的能力边界：用户**自填**出口地址，软件只负责把 AI 请求导到该出口；
 * 软件不内置、不分发任何代理节点或订阅。文案定位「网络环境自定义」（内网网关 /
 * 自建中转 / 本地统一代理），**不出现「绕过限制」「访问国外模型」等措辞**。
 *
 * 存储：localStorage（仅本机、不进云盘同步，与密钥同性质）；生效：主进程 session.setProxy，
 * 渲染层 fetch 与主进程 net.fetch 两条链路同时覆盖；配置每次启动由渲染层重推。
 * 无主进程桥（便携版 / 浏览器 dev）时设置仍可保存（桌面版启动后自动生效），界面如实提示。
 */
import { useEffect, useState } from 'react'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import { Globe } from 'lucide-react'
import HelpPopover from '@/components/common/HelpPopover'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { HAS_NET_BRIDGE } from '@/lib/app/desktop'
import { UNSAVED_CHANGES_HINT } from '@/lib/constants'
import {
  DEFAULT_BYPASS, getStoredNetProxy, storeNetProxy, applyNetProxy, normalizeProxyInput, sanitizeBypassList,
  type NetProxyPrefs,
} from '@/lib/settings/netPrefs'

export default function NetworkProxyPanel() {
  const [draft, setDraft] = useState<NetProxyPrefs>(getStoredNetProxy())
  /** 有未保存的改动时保存键点亮 */
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(getStoredNetProxy()) }, [])

  /** 改动后与已存值比对：改回原值时 dirty 自动熄灭（否则保存键常亮失真） */
  const patch = (p: Partial<NetProxyPrefs>) => {
    setDraft(prev => {
      const next = { ...prev, ...p }
      setDirty(JSON.stringify(next) !== JSON.stringify(getStoredNetProxy()))
      return next
    })
  }

  const save = async () => {
    if (draft.enabled && !normalizeProxyInput(draft.rules)) {
      showToast('代理地址格式不对：请填写如 http://127.0.0.1:7890 的地址', 'error')
      return
    }
    setSaving(true)
    try {
      const next: NetProxyPrefs = { ...draft, rules: draft.enabled ? normalizeProxyInput(draft.rules) : draft.rules, bypass: sanitizeBypassList(draft.bypass) || DEFAULT_BYPASS }
      storeNetProxy(next)
      const r = await applyNetProxy(next)
      setDirty(false)
      if (r.ok) {
        showToast(next.enabled ? '网络代理已生效' : '已恢复默认：跟随系统网络设置', 'success')
      } else {
        showToast(`设置已保存，但当前环境暂不生效：${r.error}`, 'info')
      }
    } finally {
      // 🔴 复位放 finally：applyNetProxy 链路任何未预期异常都不能让按钮停在「应用中…」
      setSaving(false)
    }
  }

  // Ctrl/Cmd+S 保存代理设置（2.7.3 补：本页是「改完点保存」，此前没挂快捷键）
  useSaveHotkey(() => void save(), dirty && !saving)

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-850/30">
      <div className="shrink-0 px-4 py-3 border-b border-ink-700">
        <div className="flex items-center gap-1.5">
          <Globe size={13} className="text-amber" />
          <h2 className="text-13 text-amber">网络代理</h2>
          <HelpPopover title="网络代理怎么用" width="24rem" size={14}>
            <p>软件默认跟随操作系统的网络设置。如果你的电脑需要经由指定的网络出口访问接口（例如公司内网的统一网关、自建的中转服务、本机运行的代理客户端），可以在这里填写出口地址，让 AI 请求经它发出。</p>
            <p className="mt-1.5">· 地址格式：http://127.0.0.1:7890（也支持 https / socks5）；</p>
            <p className="mt-1">· 直连名单：这些地址不经过出口 —— 本地模型（Ollama 默认 127.0.0.1:11434）请保持在名单里，否则启用后本地模型会连不上；</p>
            <p className="mt-1">· 设置只保存在本机，不上传、也不随云盘同步；</p>
            <p className="mt-1">· 经由该出口能否访问某个服务，取决于出口与目标服务各自的网络策略。</p>
          </HelpPopover>
        </div>
        <p className="mt-0.5 text-11 text-ink-500 leading-relaxed">
          默认关闭（跟随系统设置）。适用于需要统一网络出口的环境，按需开启。
        </p>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Button variant="toggle" size="xs" selected={draft.enabled}
            onClick={() => patch({ enabled: !draft.enabled })}
            title={draft.enabled ? '点击停用，恢复跟随系统网络设置' : '点击启用自定义出口地址'}>
            {draft.enabled ? '已启用' : '未启用'}
          </Button>
          <span className="text-11 text-ink-400">
            {draft.enabled ? `请求将经由 ${draft.rules || '（待填写地址）'} 发出` : '跟随系统网络设置（默认）'}
          </span>
          {dirty && <span className="text-11 text-amber">{UNSAVED_CHANGES_HINT}</span>}
        </div>

        {draft.enabled && (
          <>
            <div>
              <div className="text-12 text-ink-300 mb-1">出口地址</div>
              <input
                type="text"
                value={draft.rules}
                onChange={e => patch({ rules: e.target.value })}
                placeholder="如 http://127.0.0.1:7890"
                className="w-full rounded border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-12 text-ink-100 outline-none focus:border-amber font-mono"
                aria-label="代理出口地址"
              />
            </div>
            <div>
              <div className="text-12 text-ink-300 mb-1">直连名单（逗号分隔，这些地址不经过出口）</div>
              <input
                type="text"
                value={draft.bypass}
                onChange={e => patch({ bypass: e.target.value })}
                placeholder={DEFAULT_BYPASS}
                className="w-full rounded border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-12 text-ink-100 outline-none focus:border-amber font-mono"
                aria-label="直连名单"
              />
              <p className="mt-1 text-11 text-ink-500">
                请保持本地模型地址（127.0.0.1）在名单内，避免启用代理后本地模型连不上。
              </p>
            </div>
          </>
        )}

        {!HAS_NET_BRIDGE && (
          <p className="text-11 text-ink-500 leading-relaxed">
            当前运行在浏览器 / 便携版环境：设置可以保存，但只在桌面版中生效。
          </p>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => void save()} disabled={saving || !dirty}
            title={dirty ? '保存设置并立即生效' : '当前没有需要保存的改动'}>
            {saving ? '应用中…' : '保存并应用'}
          </Button>
        </div>
      </div>
    </section>
  )
}
