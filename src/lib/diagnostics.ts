/**
 * 诊断信息采集（2026-10-06 补 · 「可观测性」盲区）
 *
 * 为什么要有：作者反馈问题时，「你什么系统 / 多少章 / 哪个版本」往往要来回问好几轮。
 * 一键复制一段可粘贴的「环境 + 数据规模」摘要，沟通成本立刻降下来。
 *
 * 🔴 三条红线（写这个文件时最容易犯，**改前先读**）：
 *   ① **绝不包含作品内容** —— 章节正文 / 设定 / 角色卡 / 对话，一个字都不带（只报「数量」）；
 *   ② **绝不包含密钥** —— AI 配置只报「几个模型、本地/云端各几个」；
 *      不报 `apiKey`、不报 `baseUrl`（URL 里可能带令牌）、不报模型名（作者自定义名可能含隐私）；
 *   ③ **绝不包含绝对路径** —— 数据目录与系统用户名一律不带。
 *   ⇒ 加字段前先问自己：这一行会不会让作者的私密内容随一张截图外流？
 *
 * ⚠️ `DESKTOP` 在 dev（浏览器预览）下恒为 false —— 那一行显示「浏览器预览」是对的，不是 bug。
 */
import * as db from './db'
import { APP_VERSION_LABEL, DESKTOP } from './env'
import { loadProviders } from './ai'
import { countWords } from './textStats'

/** 采集一段可粘贴的诊断信息（失败的部分降级为「未知」，绝不因为一项取不到就整体失败） */
export async function collectDiagnostics(): Promise<string> {
  const L: string[] = []
  const put = (k: string, v: string) => L.push(`${k}：${v}`)
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn() } catch { return fallback }
  }

  // ── 版本与时间 ──
  put('版本', APP_VERSION_LABEL)
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  put('生成时间', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`)

  // ── 运行形态与系统 ──
  put('运行形态', DESKTOP ? '桌面版（本机数据文件）' : '浏览器预览（IndexedDB）')
  put('存储', DESKTOP ? '本机 JSON 整库' : 'IndexedDB')
  if (typeof navigator !== 'undefined') {
    put('系统', navigator.platform || '未知')
    put('语言', navigator.language || '未知')
    // 只取 UA 里的「渲染器 + 主版本」，去掉全部可识别细节
    const m = /(Chrome|Firefox|Edg|Safari)\/(\d+)/.exec(navigator.userAgent || '')
    put('渲染器', m ? `${m[1]} ${m[2]}` : '未知')
  }
  if (typeof window !== 'undefined' && typeof screen !== 'undefined') {
    put('窗口', `${window.innerWidth}×${window.innerHeight}　屏幕 ${screen.width}×${screen.height}　像素比 ${window.devicePixelRatio ?? 1}`)
  }

  // ── 数据规模（只报数量，不报内容） ──
  const projects = await safe(() => db.getAllProjects(), [] as Awaited<ReturnType<typeof db.getAllProjects>>)
  put('项目数', String(projects.length))
  const pid = db.getCurrentProjectId()
  if (pid) {
    const vols = await safe(() => db.getAllVolumes(), [])
    const chs = await safe(() => db.getAllChapters(), [])
    const words = chs.reduce((n, c) => n + (c.wordCount ?? countWords(c.content ?? '')), 0)
    put('当前项目', `${vols.length} 卷 / ${chs.length} 章 / 累计 ${(words / 10000).toFixed(1)} 万字`)
  } else {
    put('当前项目', '未打开（停在项目中心）')
  }

  // ── AI 配置（只报数量与「本地/云端」分布，绝不出现名字/地址/密钥） ──
  const provs = await safe(() => loadProviders(), [])
  if (provs.length === 0) {
    put('AI', '未配置模型（仅本地能力可用）')
  } else {
    const local = provs.filter(p => p.type === 'ollama' || p.local).length
    put('AI', `已配置 ${provs.length} 个模型（本地 ${local} · 云端 ${provs.length - local}）`)
  }

  // ── 语义索引（取不到就跳过这一行，不报错） ──
  try {
    const { vectorIndex } = await import('./semantic/store')
    if (pid) {
      const idx = await vectorIndex(pid)
      const n = Object.keys(idx?.refs ?? {}).length
      if (n > 0) put('语义索引', `${n} 个来源已建索引`)
    }
  } catch { /* 未启用语义检索时不显示，属正常 */ }

  L.push('')
  L.push('（以上不含任何作品内容、密钥与文件路径，可放心粘贴）')
  return L.join('\n')
}
