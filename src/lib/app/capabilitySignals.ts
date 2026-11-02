// ============ C4 · 能力契约的运行时取值层 ============
//
// 只有这一层碰 window / 既有平台判定；`capabilities.ts` 保持纯解析，便于伪造输入做单测
// （规划 §6：矩阵解析不发网络、不含 UI 依赖；测试各消费者使用同一解析结果）。
//
// 🔴 这里的每一个布尔值都必须来自**已有**判定：
//   · WEB / WEB_GUEST / WEB_CLOUD ← `platform.ts`（服务端注入的标志）
//   · DESKTOP ← `desktop.ts`（preload 注入探测）
//   · PORTABLE ← `fileBackend.ts`
//   · 老板键三态 ← `bossKey.ts` 的 `bossKeyMode()`
//   不许在这里再写一张「浏览器就没有 X」的平台判断表 —— 那正是规划要消灭的东西。
import { WEB, WEB_GUEST, WEB_CLOUD } from '@/lib/app/platform'
import { DESKTOP } from '@/lib/app/desktop'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { bossKeyMode } from '@/lib/app/bossKey'
import type { CapabilitySignals } from '@/lib/app/capabilities'

type BridgeWindow = Window & {
  electronStore?: { exportPdf?: unknown }
  electronNet?: unknown
}

/**
 * 读当前形态的信号。`overrides` 供已知更多信息的调用点补充
 * （例：同步面板知道用户选的是云盘目录、WebDAV 还是 S3）。
 */
export function readCapabilitySignals(overrides: Partial<CapabilitySignals> = {}): CapabilitySignals {
  const win = (typeof window === 'undefined' ? undefined : window) as BridgeWindow | undefined
  const doc = typeof document === 'undefined' ? undefined : document
  const store = win?.electronStore

  const signals: CapabilitySignals = {
    web: WEB,
    guest: WEB_GUEST,
    cloud: WEB_CLOUD,
    desktop: DESKTOP,
    portable: PORTABLE,
    bossMode: bossKeyMode(),
    bridgeStore: !!store,
    bridgeNet: !!win?.electronNet,
    // PDF 通道必须单独探：有的旧 preload 有 store 但没有 exportPdf
    bridgePdf: typeof store?.exportPdf === 'function',
    fullscreenApi: !!doc && doc.fullscreenEnabled === true,
    downloadApi: !!doc && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      && 'download' in doc.createElement('a'),
    // 打印页（C2）：网页 / 便携 / 桌面 dev 都有；用来判定 pdf-export 的条件支持
    printApi: typeof win?.print === 'function',
    online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    // 云端账号模式的同步走服务器；其余形态要等用户选目录/填 WebDAV 才知道，默认按「未配置」
    syncChannel: WEB_CLOUD ? 'server' : 'none',
    ...overrides,
  }
  return signals
}
