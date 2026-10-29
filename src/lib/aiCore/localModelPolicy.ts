// P9 · 识别配置中明确指向本机或局域网的模型端点。
// 这是地址分类，不做 DNS 查询、网络请求，也不等同于浏览器连接能力检测。
import type { AIProvider } from '@/lib/aiCore/core'

function localIpv4(host: string): boolean {
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
}

/** 基于浏览器 URL 解析后的规范主机名，不把用户凭据或路径当作主机。 */
export function isLocalModelAddress(raw: string): boolean {
  let host: string
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    host = url.hostname.toLowerCase().replace(/\.$/, '')
  } catch { return false }
  if (host.startsWith('[') && host.endsWith(']')) {
    const ip = host.slice(1, -1)
    if (ip === '::' || ip === '::1' || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)) return true
    // URL 规范化后的 IPv4 映射地址，例如 ::ffff:192.168.1.1 → ::ffff:c0a8:101。
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
    if (mapped) {
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16)
      return localIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return false
  }
  if (localIpv4(host)) return true
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || !host.includes('.')
}

/** 标记为本地的配置即使改成公网主机也保留本地属性；已有配置不在此处修改。 */
export function isLocalModelProvider(provider: Pick<AIProvider, 'type' | 'local' | 'baseUrl'>): boolean {
  return provider.type === 'ollama' || !!provider.local || isLocalModelAddress(provider.baseUrl)
}
