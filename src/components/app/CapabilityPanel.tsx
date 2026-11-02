/**
 * 本机运行能力（C4 · 3.3.4 · P1）
 *
 * 【它在哪】使用指南页「本机运行能力」一段（手册侧；设置侧见 `BossKeySettings` 与模型设置）。
 * 【它管什么】把**当前这台设备、当前打开方式**下九项能力的状态、原因与回退如实摆出来。
 *
 * 🔴 三件事必须分清（规划 §6，`capabilities.ts` 已按这个口径解析）：
 *    ① 支持 / 有条件支持 / 不支持 / 待确认（四态，不是"行 / 不行"两分）；
 *    ② **产品策略暂不提供**（网页版本机模型）与**当前运行环境不支持**（浏览器没有窗口桥）
 *       是两个原因 —— 前者换浏览器也没用，后者换个环境可能就有；
 *    ③ 文案一律取解析结果里的 `detail`，本组件不自己写第二版说明。
 *
 * ⚠️ 这里只显示探测结果，不做任何请求、不触发权限询问（规划 §6「矩阵解析不发网络」）。
 */
import { Ban, Check, HelpCircle, Minus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import {
  CAPABILITY_LABEL, REASON_LABEL, STATUS_LABEL,
  type CapabilityId, type CapabilityStatus,
} from '@/lib/app/capabilities'
import { useCapabilities } from '@/lib/app/useCapabilities'

/** 展示顺序按作者关心的顺序：能做什么（全屏/导出/下载）→ 数据安全（保存/离线/同步）→ 特殊入口 */
const ORDER: CapabilityId[] = [
  'fullscreen', 'pdf-export', 'file-download', 'boss-key',
  'durable-save', 'offline-edit', 'offline-cold-start', 'cloud-sync', 'local-model',
]

const TONE: Record<CapabilityStatus, string> = {
  supported: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  conditional: 'bg-amber/15 text-amber border border-amber/30',
  unsupported: 'bg-ink-700 text-ink-300 border border-ink-500',
  unknown: 'bg-sky-500/15 text-sky-300 border border-sky-500/30',
}

const ICON: Record<CapabilityStatus, typeof Check> = {
  supported: Check,
  conditional: HelpCircle,
  unsupported: Minus,
  unknown: Ban,
}

export default function CapabilityPanel() {
  const { caps, refresh } = useCapabilities()

  return (
    <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden" data-guide="guide-capabilities">
      <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
        <HelpCircle size={14} className="text-amber" />
        <h2 className="text-13 font-semibold text-ink-100">本机运行能力</h2>
        <span className="text-10 text-ink-600">当前设备 + 当前打开方式</span>
        <div className="ml-auto">
          <Button variant="secondary" size="xs" onClick={refresh} title="重新探测一次（登录状态、联网与全屏会变化）">
            <RefreshCw size={11} /> 重新检测
          </Button>
        </div>
      </div>
      <div className="p-5 space-y-2">
        {ORDER.map(id => {
          const cap = caps[id]
          const Icon = ICON[cap.status]
          const reason = REASON_LABEL[cap.reason]
          return (
            <div key={id} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-12 font-medium text-ink-200">{CAPABILITY_LABEL[id]}</span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-10 ${TONE[cap.status]}`}>
                  <Icon size={10} /> {STATUS_LABEL[cap.status]}
                </span>
                {/* 原因码紧跟着状态：把「策略不给」与「环境没有」分开写，作者才知道该不该换环境 */}
                {reason && <span className="text-10 text-ink-500">{reason}</span>}
                {cap.fallback && <span className="text-10 text-ink-600">回退：{cap.fallback}</span>}
              </div>
              <p className="mt-1 text-11 leading-relaxed text-ink-400">{cap.detail}</p>
            </div>
          )
        })}
      </div>
      <p className="px-5 pb-4 text-10 leading-relaxed text-ink-600">
        这一栏只说明「探测得到的结论」，不等于真机验收：全屏被拒、软键盘、下载目的地等还要在目标设备上实测（S-05～S-11）。
        换设备、换浏览器或登录 / 退出账号后，点「重新检测」看最新结果。
      </p>
    </section>
  )
}