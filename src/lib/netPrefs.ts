// ============ 网络代理偏好（2026-09-28 · 社区需求）============
//
// 定位（合规口径）：网络环境自定义 —— 企业内网统一网关 / 自建中转服务 / 本地代理统一管理。
// 用户在「模型设置 → 网络代理」**自填**出口地址，软件只负责把请求导到该出口；
// **软件不内置、不分发任何代理节点或订阅**（合规红线，见评估记录）。
//
// 存储：localStorage `yfe-net-proxy`（应用级、仅本机）—— 与主题/字体同族；
// 🔴 不进云盘同步，也不落主进程数据文件（代理地址属本机网络环境，与密钥同性质）。
// 生效：主进程 `session.setProxy`（渲染层 fetch 与主进程 net.fetch 两条链路同时覆盖）；
// 配置每次启动由渲染层重推（主进程不落盘，单源在渲染层）。

import { HAS_NET_BRIDGE, setNetProxy } from './desktop'

export interface NetProxyPrefs {
  /** 是否启用自定义代理（默认 false = 跟随系统代理） */
  enabled: boolean
  /** 代理规则串（如 http://127.0.0.1:7890） */
  rules: string
  /** 直连名单（逗号分隔；本地模型服务务必在内） */
  bypass: string
}

export const DEFAULT_BYPASS = 'localhost,127.0.0.1,<local>'

export const DEFAULT_NET_PROXY: NetProxyPrefs = { enabled: false, rules: '', bypass: DEFAULT_BYPASS }

const NET_KEY = 'yfe-net-proxy'

/**
 * 清洗代理地址输入。合法形态：`http://host:port` / `https://…` / `socks5://…` / 裸 `host:port`。
 * 🔴 返回 '' 表示非法（空 / 语法不通 / 含注入字符）——调用方按「未启用」处理并提示。
 */
export function normalizeProxyInput(input: string): string {
  let s = (input ?? '').trim()
  if (!s) return ''
  // 字符白名单：scheme://host:port 与尾部路径不给（代理规则串不需要路径）
  if (!/^[a-zA-Z0-9.\-_:]+$/.test(s.replace(/^(https?|socks5?):\/\//i, ''))) return ''
  // scheme 可省（Electron proxyRules 允许裸 host:port）；有 scheme 必须是这几种之一（忽略大小写）
  if (s.includes('://') && !/^(https?|socks5?):\/\/./i.test(s)) return ''
  // host:port 形态校验（scheme 已剥）：host 段 + 可选 :port
  const rest = s.replace(/^(https?|socks5?):\/\//i, '')
  const hostPort = rest.match(/^([a-zA-Z0-9.\-]+)(?::(\d{1,5}))?$/)
  if (!hostPort) return ''
  if (hostPort[2] != null && (Number(hostPort[2]) < 1 || Number(hostPort[2]) > 65535)) return ''
  return s
}

/** 清洗直连名单：逐段过 normalize 的宽松版（允许 `<local>` 标记），非法段丢弃 */
export function sanitizeBypassList(input: string): string {
  return (input ?? '')
    .split(/[;，\s]+/)          // 容错：分号 / 全角逗号 / 空白都能当分隔符
    .map(seg => seg.trim())
    .filter(seg => seg === '<local>' || /^[a-zA-Z0-9.\-:*\s]+$/.test(seg))
    .join(',')
}

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** 读已存代理偏好；脏数据逐字段收窄（非法地址一律回默认） */
export function getStoredNetProxy(): NetProxyPrefs {
  const raw = safeGet(NET_KEY)
  if (!raw) return { ...DEFAULT_NET_PROXY }
  try {
    const p = JSON.parse(raw) as { enabled?: unknown; rules?: unknown; bypass?: unknown }
    const rules = typeof p.rules === 'string' ? normalizeProxyInput(p.rules) : ''
    const bypass = typeof p.bypass === 'string' ? sanitizeBypassList(p.bypass) : DEFAULT_BYPASS
    return { enabled: p.enabled === true && rules !== '', rules, bypass }
  } catch { return { ...DEFAULT_NET_PROXY } }
}

/** 落盘偏好（「保存」按钮用；写失败静默——隐私模式不挡写作主流程） */
export function storeNetProxy(p: NetProxyPrefs): void {
  try { localStorage.setItem(NET_KEY, JSON.stringify(p)) } catch { /* 忽略隐私模式写失败 */ }
}

/**
 * 推送代理配置到主进程（生效面：渲染层 fetch + 主进程 net.fetch）。
 * 未启用 → mode:'direct'（恢复直连，等价于「跟随系统代理」的默认行为）。
 * 永不抛：无桥（便携版 / 浏览器 dev）返回 ok:false，由调用方如实提示。
 */
export async function applyNetProxy(p: NetProxyPrefs): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!p.enabled) return setNetProxy({ enabled: false })
  const rules = normalizeProxyInput(p.rules)
  if (!rules) return { ok: false, error: '代理地址无效' }
  return setNetProxy({ enabled: true, rules, bypass: sanitizeBypassList(p.bypass) })
}

/** 启动时应用已存配置（App 启动链调用；无桥环境静默跳过） */
export async function applyStoredNetProxy(): Promise<void> {
  if (!HAS_NET_BRIDGE) return
  await applyNetProxy(getStoredNetProxy())
}
