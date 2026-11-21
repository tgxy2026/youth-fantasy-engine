/**
 * 诊断信息采集（2026-10-06 补 · 「可观测性」盲区；3.6.2 拆成「采集 → 组包 → 渲染」）
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
 * 【3.6.2 的结构】本文件只负责**采集**（读 db / 读环境 / 跑体检），
 * 组包与渲染在 `diagnosticsPack.ts`（纯函数，可逐条单测）。
 * 这样同一份数据能同时出「粘贴文本」与「保存文件」两种视图，且负向断言只需对纯函数写一遍。
 *
 * ⚠️ `DESKTOP` 在 dev（浏览器预览）下恒为 false —— 那一行显示「浏览器预览」是对的，不是 bug。
 */
import * as db from '@/lib/db'
import { APP_BUILD_ID, APP_BUILD_TIME, APP_VERSION_LABEL, DESKTOP } from '@/lib/app/env'
import { loadProviders, protocolOf, WIRE_PROTOCOL_LABELS } from '@/lib/ai'
import { countWords } from '@/lib/editor/textStats'
import { recentErrors } from '@/lib/app/errorLog'
import { getDesktopState } from '@/lib/app/desktop'
import { getPortableState, PORTABLE } from '@/lib/storage/fileBackend'
import { WEB, WEB_GUEST } from '@/lib/app/platform'
import {
  buildDiagnosticsPack,
  renderDiagnosticsText,
  type AppForm,
  type DiagnosticsInputs,
  type DiagnosticsPack,
  type PathKind,
} from '@/lib/app/diagnosticsPack'

/** 采集一段可粘贴的诊断信息（失败的部分降级为「未知」，绝不因为一项取不到就整体失败） */
export async function collectDiagnostics(): Promise<string> {
  return renderDiagnosticsText(await collectDiagnosticsPack())
}

/** 运行形态：四面旗显式判断，**不用取反猜**（见 `lib/app/env.ts` 顶部那段历史教训） */
function detectForm(): AppForm {
  if (DESKTOP) return 'desktop'
  if (PORTABLE) return 'portable'
  if (WEB) return 'web'
  return 'dev'
}

/**
 * 采集并组包。**永不抛**：每个子系统单独兜，取不到就降级（诊断包本身不能因为
 * "有一项读不到"而整体失败 —— 那正是最需要它的时候）。
 *
 * @param opts.uiZoom 界面缩放（1 = 100%）。由 UI 层传（`currentUiZoom()`），
 *   这里不 import theme —— 采集器不该依赖界面模块，也便于单测注入。
 */
export async function collectDiagnosticsPack(opts?: { uiZoom?: number }): Promise<DiagnosticsPack> {
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn() } catch { return fallback }
  }

  // ── 运行形态与存储 ──
  const form = detectForm()
  const ds = DESKTOP ? (() => { try { return getDesktopState() } catch { return null } })() : null
  const portableState = PORTABLE ? (() => { try { return getPortableState() } catch { return null } })() : null
  const pathKind: PathKind = ds ? (ds.isCustomPath ? 'custom' : 'default') : 'unknown'
  const storageKind = DESKTOP
    ? '本机 JSON 整库'
    : PORTABLE
      ? '本机 JSON 整库（应用目录）'
      : WEB
        ? (WEB_GUEST ? 'IndexedDB（游客）' : '云端 / 本机账号库')
        : 'IndexedDB'

  // ── 数据规模（只报数量，不报内容） ──
  const projects = await safe(() => db.getAllProjects(), [] as Awaited<ReturnType<typeof db.getAllProjects>>)
  const pid = db.getCurrentProjectId()
  let current: DiagnosticsInputs['project']['current'] = null
  if (pid) {
    const vols = await safe(() => db.getAllVolumes(), [])
    const chs = await safe(() => db.getAllChapters(), [])
    const words = chs.reduce((n, c) => n + (c.wordCount ?? countWords(c.content ?? '')), 0)
    current = { volumes: vols.length, chapters: chs.length, words }
  }

  // ── AI 配置（只报数量与「本地/云端」分布，绝不出现名字/地址/密钥） ──
  const provs = await safe(() => loadProviders(), [])
  const local = provs.filter(p => protocolOf(p) === 'ollama' || p.local).length
  const protocols: Record<string, number> = {}
  for (const p of provs) {
    const label = WIRE_PROTOCOL_LABELS[protocolOf(p)]
    protocols[label] = (protocols[label] ?? 0) + 1
  }

  // ── 语义索引（取不到就当 0，不报错） ──
  let semanticSources = 0
  try {
    const { vectorIndex } = await import('@/lib/semantic/store')
    if (pid) {
      const idx = await vectorIndex(pid)
      semanticSources = Object.keys(idx?.refs ?? {}).length
    }
  } catch { /* 未启用语义检索时视为未建索引，属正常 */ }

  // ── 数据体检（确定性结构扫描） ──
  //   🔴 动态 import：`dataHealth` 会拉进 schema 与全部表格读取，而本模块位于**主包**路径上
  //      （WriteLockBanner 引它）。诊断不需要每次启动都付出这份代价。
  //   🔴 失败时只报"失败"与错误类型名，**不报消息**：异常消息可能带路径或片段。
  //   🔴 写锁状态下**必须先中止**：那时内存里是空库，体检扫空表会得出"未发现问题"，
  //      而真实情况是"数据没读出来" —— 这两句对用户是天壤之别（验收 W2 第 8 条就卡这一处）。
  let health: DiagnosticsInputs['health'] = {
    ok: false,
    reason: pid ? '未执行' : '未打开项目',
    bySeverity: { error: 0, warn: 0, info: 0 },
    byCategory: {},
  }
  const writeLocked = ds?.writeLocked === true || (PORTABLE && portableState?.writeLocked === true)
  if (writeLocked) {
    health = {
      ok: false,
      reason: '数据文件读取失败（写锁中），本次体检结果不可用',
      bySeverity: { error: 0, warn: 0, info: 0 },
      byCategory: {},
    }
  } else if (pid) {
    try {
      const { runDataHealthCheck } = await import('@/lib/storage/dataHealth')
      const r = await runDataHealthCheck()
      const bySeverity = { error: 0, warn: 0, info: 0 }
      const byCategory: Record<string, number> = {}
      for (const issue of r.issues) {
        byCategory[issue.category] = (byCategory[issue.category] ?? 0) + 1
        if (issue.severity === 'error') bySeverity.error++
        else if (issue.severity === 'warn') bySeverity.warn++
        else bySeverity.info++
      }
      health = { ok: true, bySeverity, byCategory }
    } catch (e) {
      health = {
        ok: false,
        reason: `体检执行失败（${e instanceof Error ? e.name : '未知错误'}）`,
        bySeverity: { error: 0, warn: 0, info: 0 },
        byCategory: {},
      }
    }
  }

  const nav = typeof navigator !== 'undefined' ? navigator : null
  const ua = /(Chrome|Firefox|Edg|Safari)\/(\d+)/.exec(nav?.userAgent ?? '')

  return buildDiagnosticsPack({
    version: APP_VERSION_LABEL,
    buildTime: APP_BUILD_TIME,
    buildId: APP_BUILD_ID,
    form,
    dev: form === 'dev',
    runtime: {
      os: nav?.platform || '未知',
      language: nav?.language || '未知',
      renderer: ua ? `${ua[1]} ${ua[2]}` : '未知',
      window: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : null,
      screen: typeof screen !== 'undefined' ? { width: screen.width, height: screen.height } : null,
      dpr: typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1,
      uiZoom: opts?.uiZoom ?? null,
    },
    storage: {
      kind: storageKind,
      pathKind,
      /**
       * 🔴 本版**不采集**数据文件字节数：主进程没有 stat 接口，而 `desktop.ts` 已贴着
       *    单文件 1200 行硬线，不为一个排障字段去破它。null = 没采到，与 0 字节是两回事。
       *    「最近修改时间」用桌面桥已有的 `lastSavedAt`（本应用自己写盘的时刻，比 mtime 更可信）。
       */
      dataSizeBytes: null,
      dataModifiedAt: (() => {
        const at = ds?.lastSavedAt || portableState?.lastSavedAt || 0
        return at > 0 ? new Date(at).toISOString() : null
      })(),
      writeLocked: ds?.writeLocked === true || portableState?.writeLocked === true,
    },
    project: {
      count: projects.length,
      current,
      semanticSources,
    },
    health,
    ai: {
      models: provs.length,
      local,
      cloud: provs.length - local,
      protocols,
    },
    errors: recentErrors(),
  })
}
