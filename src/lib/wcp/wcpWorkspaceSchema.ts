// ============ WCP 本地 Agent 工作区 · 产物契约（3.7.4 · W0）============
//
// 本文件是本地 Agent 产出的 `.wcp.json` 的**唯一契约真源**：
//   · `WCP_OUTPUT_SCHEMA` —— 写进 `03-schemas/wcp-output.schema.json`（Draft 2020-12）；
//   · `WCP_OUTPUT_EXAMPLE` —— 写进 `03-schemas/wcp-output.example.json`（最小合法样例）；
//   · `validateWcpOutputJson` —— 回流时的结构校验（**不用**第三方校验库，错误逐条可读）。
//
// 🔴 字段口径必须与 `wcpParser.ts` 的归一化一致：
//    entities / statusChanges / resourceTransfers / foreshadows / relations / bioNodes
//    —— 少了任何一类，Agent 按样例写出来的东西就会在回流时被静默丢弃。
// 🔴 纯数据 + 纯函数：零 IO、零依赖，单测可逐字钉住。
import { WCP_OUTPUT_SCHEMA_VERSION, type WcpSceneId } from '@/lib/wcp/wcpTypes'

/** 5 大场景：与 `WCP_SCENARIOS` 同源（这里只落枚举，供 Schema 与校验共用） */
export const WCP_OUTPUT_SCENES: readonly WcpSceneId[] = [
  'chapter-continue',
  'chapter-polish',
  'outline-expand',
  'continuity-audit',
  'bio-organize',
]

const CHANGE_KEYS = [
  'entities',
  'statusChanges',
  'resourceTransfers',
  'foreshadows',
  'relations',
  'bioNodes',
] as const

/**
 * 标准 JSON Schema（Draft 2020-12）。
 * 🔴 只约束**回流入库真正依赖的字段**：多余字段允许存在（Agent 可自行补充说明），
 *    缺失必填字段则在回流时立即拒绝并指出路径。
 */
export const WCP_OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'wcp-output/v1',
  title: 'WCP 本地 Agent 产物',
  type: 'object',
  required: ['schemaVersion', 'projectId', 'scene', 'body'],
  properties: {
    schemaVersion: { const: WCP_OUTPUT_SCHEMA_VERSION },
    projectId: { type: 'string', minLength: 1 },
    projectName: { type: 'string', description: '可选：作品名，仅用于跨书提示时显示' },
    scene: { enum: [...WCP_OUTPUT_SCENES] },
    targetChapterId: { type: 'string' },
    targetChapterNo: { type: 'integer', minimum: 0 },
    targetChapterTitle: { type: 'string' },
    body: { type: 'string', description: '纯净创作结果（正文/润色稿/细纲/审校报告/小传）' },
    changes: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string', minLength: 1 },
              type: { type: 'string', minLength: 1 },
              summary: { type: 'string' },
              evidence: { type: 'string' },
            },
          },
        },
        statusChanges: {
          type: 'array',
          items: {
            type: 'object',
            required: ['character', 'after'],
            properties: {
              character: { type: 'string', minLength: 1 },
              before: { type: 'string' },
              after: { type: 'string', minLength: 1 },
              quote: { type: 'string' },
            },
          },
        },
        resourceTransfers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['item', 'action'],
            properties: {
              item: { type: 'string', minLength: 1 },
              from: { type: 'string' },
              to: { type: 'string' },
              action: { type: 'string', minLength: 1 },
              quote: { type: 'string' },
            },
          },
        },
        foreshadows: {
          type: 'array',
          items: {
            type: 'object',
            required: ['action', 'content'],
            properties: {
              code: { type: 'string' },
              action: { type: 'string', minLength: 1 },
              content: { type: 'string', minLength: 1 },
            },
          },
        },
        relations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['charA', 'charB', 'change'],
            properties: {
              charA: { type: 'string', minLength: 1 },
              charB: { type: 'string', minLength: 1 },
              change: { type: 'string' },
              quote: { type: 'string' },
            },
          },
        },
        bioNodes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['character', 'title', 'summary'],
            properties: {
              character: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              summary: { type: 'string' },
              tag: { type: 'string' },
              evidence: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const

/**
 * 最小合法样例。
 * 🔴 `projectId` 在生成工作区时会被替换成**当前项目 id**（见构建器）——
 *    否则 Agent 照抄样例就会触发跨书拦截，体验像「怎么填都不对」。
 */
export const WCP_OUTPUT_EXAMPLE = {
  schemaVersion: WCP_OUTPUT_SCHEMA_VERSION,
  projectId: 'proj_demo',
  projectName: '示例作品',
  scene: 'chapter-continue',
  targetChapterNo: 21,
  targetChapterTitle: '第21章 剑应碑醒',
  body: '（这里放纯净创作结果：正文 / 润色稿 / 细纲 / 审校报告 / 小传）',
  changes: {
    entities: [{ name: '青锋剑', type: '物品', summary: '林晚新得的佩剑', evidence: '正文原句' }],
    statusChanges: [{ character: '林晚', before: '炼气三层', after: '筑基一层', quote: '正文原句' }],
    resourceTransfers: [{ item: '青锋剑', from: '苏明', to: '林晚', action: '转移', quote: '正文原句' }],
    foreshadows: [{ code: 'F01', action: '埋设', content: '旧玉佩的来路', }],
    relations: [{ charA: '林晚', charB: '苏明', change: '结为同盟', quote: '正文原句' }],
    bioNodes: [{ character: '林晚', title: '筑基', summary: '突破筑基', tag: '成长突破', evidence: '正文原句' }],
  },
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 生成**当前项目**的最小合法样例（替换 projectId / projectName）。
 * 🔴 深拷贝每一层：样例是 `as const`，直接改字段会污染模块级常量。
 */
export function wcpOutputExampleFor(projectId: string, projectName: string): Record<string, unknown> {
  const ex = WCP_OUTPUT_EXAMPLE.changes
  return {
    ...WCP_OUTPUT_EXAMPLE,
    projectId,
    projectName,
    changes: {
      entities: ex.entities.map(x => ({ ...x })),
      statusChanges: ex.statusChanges.map(x => ({ ...x })),
      resourceTransfers: ex.resourceTransfers.map(x => ({ ...x })),
      foreshadows: ex.foreshadows.map(x => ({ ...x })),
      relations: ex.relations.map(x => ({ ...x })),
      bioNodes: ex.bioNodes.map(x => ({ ...x })),
    },
  }
}

/** 逐条校验项目数组：`{ 路径: 要求 }` */
function checkArray(
  value: unknown,
  path: string,
  required: readonly string[],
  errors: string[],
): void {
  if (value === undefined) return // 数组可省略（等价空数组）
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`)
    return
  }
  value.forEach((item, index) => {
    const at = `${path}[${index}]`
    if (!isRecord(item)) {
      errors.push(`${at} 必须是对象`)
      return
    }
    for (const key of required) {
      if (!nonEmptyString(item[key])) errors.push(`${at}.${key} 必须是非空字符串`)
    }
    for (const key of ['summary', 'evidence', 'quote', 'before', 'from', 'to', 'code', 'tag', 'change', 'title'] as const) {
      if (item[key] !== undefined && typeof item[key] !== 'string') errors.push(`${at}.${key} 必须是字符串`)
    }
  })
}

/**
 * 校验一份 `.wcp.json` 产物。
 * @returns 错误清单（空数组 = 合法）；**不抛异常**，调用方负责把错误原样展示给作者。
 */
export function validateWcpOutputJson(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['产物必须是一个 JSON 对象']
  if (value.schemaVersion !== WCP_OUTPUT_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 "${WCP_OUTPUT_SCHEMA_VERSION}"`)
  }
  if (!nonEmptyString(value.projectId)) errors.push('projectId 必须是非空字符串')
  if (value.projectName !== undefined && typeof value.projectName !== 'string') errors.push('projectName 必须是字符串')
  if (!WCP_OUTPUT_SCENES.includes(value.scene as WcpSceneId)) {
    errors.push(`scene 必须是 ${WCP_OUTPUT_SCENES.join(' / ')} 之一`)
  }
  if (typeof value.body !== 'string') errors.push('body 必须是字符串')
  if (value.targetChapterId !== undefined && typeof value.targetChapterId !== 'string') errors.push('targetChapterId 必须是字符串')
  if (value.targetChapterNo !== undefined) {
    const no = value.targetChapterNo
    if (typeof no !== 'number' || !Number.isInteger(no) || no < 0) errors.push('targetChapterNo 必须是大于等于 0 的整数')
  }
  if (value.targetChapterTitle !== undefined && typeof value.targetChapterTitle !== 'string') errors.push('targetChapterTitle 必须是字符串')

  const changes = value.changes
  if (changes !== undefined && !isRecord(changes)) {
    errors.push('changes 必须是对象')
  } else if (isRecord(changes)) {
    checkArray(changes.entities, 'changes.entities', ['name', 'type'], errors)
    checkArray(changes.statusChanges, 'changes.statusChanges', ['character', 'after'], errors)
    checkArray(changes.resourceTransfers, 'changes.resourceTransfers', ['item', 'action'], errors)
    checkArray(changes.foreshadows, 'changes.foreshadows', ['action', 'content'], errors)
    checkArray(changes.relations, 'changes.relations', ['charA', 'charB', 'change'], errors)
    checkArray(changes.bioNodes, 'changes.bioNodes', ['character', 'title', 'summary'], errors)
    // 至少给一个已知键：只有 `{}` / `{"foo":1}` 时说明 Agent 完全没按契约写
    const known = CHANGE_KEYS.some(k => Object.prototype.hasOwnProperty.call(changes, k))
    if (!known) errors.push('changes 至少应包含 entities / statusChanges / resourceTransfers / foreshadows / relations / bioNodes 之一')
  }
  return errors
}