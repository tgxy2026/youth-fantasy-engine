// ============ 诊断包（diagnostics pack）· 白名单生成 + 两种视图 ============
//
// 【它解决什么】"复制诊断信息"能贴一段话，但贴不下结构化数据；用户描述"它报错了"时，
// 作者要来回问环境、规模、错误、体检结果。诊断包把这些**同一份数据**同时给两种出口：
//   · 文本视图（复制）：给群聊/私聊直接粘；
//   · 文件视图（保存 .json）：给 issue / 邮件当附件。
//
// 🔴 本文件最重要的设计是**白名单**，不是"排除敏感字段"：
//    `buildDiagnosticsPack` 只从 `DiagnosticsInputs` 里挑写明的字段，**不做任何字段穿透**。
//    排除式过滤（"把 apiKey 删掉"）在新增字段时会静默漏；白名单在新增字段时**默认不出现**，
//    必须有人主动加一行才会进包。方向正好相反，这才是可维护的那一侧。
//
// 🔴 三条红线（与 diagnostics.ts 同源，改前先读）：
//   ① 不含作品内容（章节正文 / 设定 / 角色卡 / 对话）—— 只报数量；
//   ② 不含密钥与地址 —— 不报 `apiKey` / `baseUrl` / 模型名（作者自定义名可能含隐私）；
//   ③ 不含绝对路径 —— 存储段只报"默认/自定义位置"这个**类别**，不报路径字符串。
//
// ⚠️ 一个刻意的例外，别当成 bug：红条那条文本（`lockBannerCopy.writeLockDiagnostics`）
//    **仍然会带数据文件路径**。理由：判断"是不是放进了云盘同步目录"必须看路径，
//    而那段文本是用户**主动**复制给作者的。诊断包（可能被上传到公开页面）不带路径。
//    两者共用同一份采集输入，但**渲染口径不同** —— 这是有意的，不是漏改。
import type { ErrorRecord } from '@/lib/app/errorLog'

/** 包格式版本。结构不兼容地变一次就加一（消费方据此判断能不能读）。 */
export const PACK_SCHEMA = 1

/** 运行形态（四态：桌面 / 便携 / 网页 / 开发预览） */
export type AppForm = 'desktop' | 'portable' | 'web' | 'dev'

/** 数据位置类别（**只报类别，不报路径**） */
export type PathKind = 'default' | 'custom' | 'unknown'

export interface DiagnosticsPack {
  schema: number
  /** 生成时刻（ISO，带本地偏移） */
  generatedAt: string
  app: {
    version: string
    buildTime: string
    buildId: string
    form: AppForm
    dev: boolean
  }
  runtime: {
    /** 操作系统平台（`navigator.platform` 原值，不含版本细节） */
    os: string
    language: string
    /** 渲染器 + 主版本，如 `Chrome 130`（去掉完整 UA） */
    renderer: string
    window: { width: number; height: number } | null
    screen: { width: number; height: number } | null
    /** 像素比 */
    dpr: number
    /** 界面缩放（1 = 100%）；取不到为 null */
    uiZoom: number | null
  }
  storage: {
    /** 存储介质的人类可读名，如「本机 JSON 整库」「IndexedDB」「云端」 */
    kind: string
    /** 位置类别（**不是路径**） */
    pathKind: PathKind
    /** 数据文件字节数；拿不到为 null（null ≠ 0，别当空库） */
    dataSizeBytes: number | null
    /** 数据文件最近修改时间（ISO）；拿不到为 null */
    dataModifiedAt: string | null
    /** 当前是否处于「写锁」状态（读失败暂停写盘） */
    writeLocked: boolean
  }
  project: {
    /** 项目总数 */
    count: number
    /** 当前项目规模；未打开为 null */
    current: { volumes: number; chapters: number; words: number } | null
    /** 语义索引来源数（0 = 未建索引） */
    semanticSources: number
  }
  health: {
    /** 体检是否真的跑完（false 时下面三个计数都无意义） */
    ok: boolean
    /** 不可用的原因（可读短句，不含路径与条目名） */
    reason: string
    /** 按严重度计数 */
    bySeverity: { error: number; warn: number; info: number }
    /** 按类别计数（类别名来自固定清单，不含用户内容） */
    byCategory: Record<string, number>
  }
  ai: {
    /** 已配置模型数 */
    models: number
    local: number
    cloud: number
    /** 协议分布（协议名是固定枚举，不是模型名） */
    protocols: Record<string, number>
  }
  /** 最近错误（沿用 errorLog 口径：≤10 条、消息 ≤200 字、来源只留 basename） */
  errors: Array<{
    at: string
    kind: string
    message: string
    source: string
    /** 仅"详细错误"开关打开时存在，已去路径的前 3 帧 */
    frames?: string[]
  }>
  /** 显式列出被排除的类别（给用户看，建立信任） */
  redaction: string[]
}

/**
 * 采集输入（**白名单**：只有这里写明的字段会被包收下）。
 * 每一项都由调用方（diagnostics.ts）自己取好；本模块不认识 db / ai / 文件系统。
 */
export interface DiagnosticsInputs {
  version: string
  buildTime: string
  buildId: string
  form: AppForm
  dev: boolean
  runtime: {
    os: string
    language: string
    renderer: string
    window: { width: number; height: number } | null
    screen: { width: number; height: number } | null
    dpr: number
    uiZoom: number | null
  }
  storage: {
    kind: string
    pathKind: PathKind
    dataSizeBytes: number | null
    dataModifiedAt: string | null
    writeLocked: boolean
  }
  project: {
    count: number
    current: { volumes: number; chapters: number; words: number } | null
    semanticSources: number
  }
  health: {
    ok: boolean
    reason?: string
    bySeverity: { error: number; warn: number; info: number }
    byCategory: Record<string, number>
  }
  ai: {
    models: number
    local: number
    cloud: number
    protocols: Record<string, number>
  }
  /** 原始错误记录（只取白名单字段，frames 是否保留由调用方决定） */
  errors: ErrorRecord[]
  /** 注入"现在"，便于单测固定时间 */
  now?: Date
}

/** 固定写死的"被排除了什么"，让用户打开文件就能确认这是安全的 */
export const REDACTION_NOTES: readonly string[] = [
  '作品正文、章节名、设定与角色卡内容',
  '章节 / 设定 / 角色 / 条目的名称与标题',
  'AI 密钥、接口地址、模型名称',
  '数据文件与安装目录的绝对路径、系统用户名',
  '账号 ID、昵称、登录名',
]

/** 本地时区的 ISO 串（带偏移），比裸 UTC 更像"这台机器上的时刻" */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = p(Math.floor(Math.abs(off) / 60))
  const om = p(Math.abs(off) % 60)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`
}

/** 非负整数兜底（负数 / NaN / 小数一律归 0，避免把脏值写进包） */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * 生成诊断包。**纯函数**：不读存储、不联网、不看全局状态。
 *
 * 白名单体现在每一处显式赋值上 —— 想加字段必须在这里加一行，而不是"少删一个"。
 */
export function buildDiagnosticsPack(inputs: DiagnosticsInputs): DiagnosticsPack {
  const now = inputs.now ?? new Date()
  const errors = inputs.errors.slice(0, 10).map(e => {
    const item: DiagnosticsPack['errors'][number] = {
      at: localIso(new Date(e.at)),
      kind: e.kind,
      // 消息已在 errorLog 侧截断到 200 字；这里再兜一次，防有人绕过去直接喂长串
      message: e.message.slice(0, 200),
      source: e.source,
    }
    // 🔴 只保留调用方给了的帧；本函数**不生成**堆栈（生成堆栈属于"采集"，不是"组装"）
    if (e.frames?.length) item.frames = e.frames.slice(0, 3).map(f => f.slice(0, 160))
    return item
  })

  return {
    schema: PACK_SCHEMA,
    generatedAt: localIso(now),
    app: {
      version: inputs.version,
      buildTime: inputs.buildTime,
      buildId: inputs.buildId,
      form: inputs.form,
      dev: inputs.dev,
    },
    runtime: {
      os: inputs.runtime.os,
      language: inputs.runtime.language,
      renderer: inputs.runtime.renderer,
      window: inputs.runtime.window,
      screen: inputs.runtime.screen,
      dpr: inputs.runtime.dpr,
      uiZoom: inputs.runtime.uiZoom,
    },
    storage: {
      kind: inputs.storage.kind,
      pathKind: inputs.storage.pathKind,
      dataSizeBytes: inputs.storage.dataSizeBytes,
      dataModifiedAt: inputs.storage.dataModifiedAt,
      writeLocked: inputs.storage.writeLocked,
    },
    project: {
      count: count(inputs.project.count),
      current: inputs.project.current
        ? {
            volumes: count(inputs.project.current.volumes),
            chapters: count(inputs.project.current.chapters),
            words: count(inputs.project.current.words),
          }
        : null,
      semanticSources: count(inputs.project.semanticSources),
    },
    health: {
      ok: inputs.health.ok,
      reason: inputs.health.ok ? '' : (inputs.health.reason || '未知原因'),
      bySeverity: {
        error: count(inputs.health.bySeverity.error),
        warn: count(inputs.health.bySeverity.warn),
        info: count(inputs.health.bySeverity.info),
      },
      byCategory: Object.fromEntries(
        Object.entries(inputs.health.byCategory)
          .filter(([k]) => k.trim().length > 0)
          .map(([k, v]) => [k, count(v)]),
      ),
    },
    ai: {
      models: count(inputs.ai.models),
      local: count(inputs.ai.local),
      cloud: count(inputs.ai.cloud),
      protocols: Object.fromEntries(
        Object.entries(inputs.ai.protocols)
          .filter(([k]) => k.trim().length > 0)
          .map(([k, v]) => [k, count(v)]),
      ),
    },
    errors,
    redaction: [...REDACTION_NOTES],
  }
}

/* ---------------- 两种视图 ---------------- */

const FORM_TEXT: Record<AppForm, string> = {
  desktop: '桌面版（本机数据文件）',
  portable: '便携版（浏览器 + 本地服务）',
  web: '网页版',
  dev: '浏览器预览（IndexedDB）',
}

const PATH_KIND_TEXT: Record<PathKind, string> = {
  default: '默认位置',
  custom: '自定义位置',
  unknown: '未知',
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * 文本视图（"复制诊断信息"用）。
 *
 * 🔴 **格式与 3.6.1 保持一致**：既有 `tests/diagnostics.test.ts` 用正则逐行校验，
 *    也已有用户习惯了这套字段名。新增内容只许"加行"，不许改名或改顺序。
 */
export function renderDiagnosticsText(pack: DiagnosticsPack): string {
  const L: string[] = []
  const put = (k: string, v: string) => L.push(`${k}：${v}`)

  put('版本', pack.app.version)
  const at = new Date(pack.generatedAt)
  put('生成时间', `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`)

  put('运行形态', FORM_TEXT[pack.app.form])
  put('存储', pack.storage.kind)
  put('系统', pack.runtime.os || '未知')
  put('语言', pack.runtime.language || '未知')
  put('渲染器', pack.runtime.renderer || '未知')
  if (pack.runtime.window && pack.runtime.screen) {
    put('窗口', `${pack.runtime.window.width}×${pack.runtime.window.height}　屏幕 ${pack.runtime.screen.width}×${pack.runtime.screen.height}　像素比 ${pack.runtime.dpr}`)
  }

  put('项目数', String(pack.project.count))
  if (pack.project.current) {
    const c = pack.project.current
    put('当前项目', `${c.volumes} 卷 / ${c.chapters} 章 / 累计 ${(c.words / 10000).toFixed(1)} 万字`)
  } else {
    put('当前项目', '未打开（停在项目中心）')
  }

  if (pack.ai.models === 0) {
    put('AI', '未配置模型（仅本地能力可用）')
  } else {
    put('AI', `已配置 ${pack.ai.models} 个模型（本地 ${pack.ai.local} · 云端 ${pack.ai.cloud}）`)
    const byProto = Object.entries(pack.ai.protocols).map(([k, n]) => `${k} ${n}`).join(' · ')
    if (byProto) put('AI 协议', byProto)
  }

  if (pack.project.semanticSources > 0) put('语义索引', `${pack.project.semanticSources} 个来源已建索引`)

  // 数据体检：失败也要说"不可用"，不能因为没跑成就不出现（那会被读成"一切正常"）
  if (!pack.health.ok) {
    put('数据体检', `不可用（${pack.health.reason}）`)
  } else {
    const { error: e, warn: w, info: i } = pack.health.bySeverity
    const total = e + w + i
    put('数据体检', total === 0 ? '未发现问题' : `发现 ${total} 项（错误 ${e} / 提示 ${w} / 参考 ${i}）`)
  }

  if (pack.storage.pathKind !== 'unknown') put('数据位置', PATH_KIND_TEXT[pack.storage.pathKind])
  if (pack.storage.writeLocked) put('写锁', '已暂停写入（数据文件读取失败，本次不会覆盖原文件）')

  if (pack.errors.length > 0) {
    L.push('')
    L.push(`最近错误（${pack.errors.length} 条 · 仅本次运行，重启即清）：`)
    for (const e of pack.errors.slice(0, 5)) {
      const t = new Date(e.at)
      L.push(`  · [${e.kind}] ${pad2(t.getHours())}:${pad2(t.getMinutes())} ${e.message}${e.source ? `（${e.source}）` : ''}`)
      for (const f of e.frames ?? []) L.push(`      ${f}`)
    }
    L.push('（错误消息可能含少量原文片段，粘贴前可自行删掉这一段）')
  }

  L.push('')
  L.push('（以上不含任何作品内容、密钥与文件路径，可放心粘贴）')
  return L.join('\n')
}

/** 文件视图：格式化成可以发出去的 JSON（2 空格缩进，便于人工逐段核对） */
export function renderDiagnosticsJson(pack: DiagnosticsPack): string {
  return JSON.stringify(pack, null, 2) + '\n'
}

/** 建议的文件名：`yfe-diagnostics-20261121-0830.json`（取自包内生成时刻，不含主机名/用户名） */
export function diagnosticsFileName(pack: DiagnosticsPack): string {
  const at = new Date(pack.generatedAt)
  const d = Number.isNaN(at.getTime()) ? new Date() : at
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return `yfe-diagnostics-${stamp}.json`
}
