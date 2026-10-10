/**
 * 酒馆模式 · 预设方案（路线图第 4 批 A4）
 *
 * 一套「命名快照」：把**整套设置（含协议全文）**存下来，一键切回去。
 *
 * 【为什么连协议一起存】
 * 协议是可编辑的，而且它决定输出的格式契约。只存参数不存协议的话，
 * 「精修成稿」预设切过去，格式契约还是上一套的 —— 用户以为换了一整套，其实只换了一半。
 *
 * 【数据归属】全局（db meta），与控制面板设置同域：它存的就是那套设置本身。
 *
 * 本文件是纯逻辑 + 存储读写，不含 React；文件读写（Blob / input）由调用方完成。
 */
import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'
import { type TavernSettings } from '@/lib/tavern/settings'

const K_PRESETS = 'tavern.presets'

/** 导出文件的标识，用来在导入时区分「是不是我们的文件」 */
const KIND = 'youth-fantasy-engine.tavern-preset'

export type TavernPreset = {
  id: string
  name: string
  /** 快照：整套设置（通用 / 我的档案 / 协议 / 剧情推演 / 自由对话） */
  data: TavernSettings
  createdAt: number
  updatedAt: number
}

export async function listPresets(): Promise<TavernPreset[]> {
  try {
    const raw = await db.getMeta<TavernPreset[]>(K_PRESETS, [])
    if (!Array.isArray(raw)) return []
    // 缺字段的老数据（理论上不会有）直接过滤掉，别让界面渲染出一堆空行
    return raw.filter(p => p && typeof p.id === 'string' && p.data && typeof p.data === 'object')
  } catch {
    return []
  }
}

/**
 * 存一个预设（有 id 就覆盖那个，没有就新建），返回**新列表**。
 * 返回列表而不是单条：调用方永远需要刷新列表，让调用方自己再查一次容易漏。
 */
export async function savePreset(input: {
  id?: string
  name: string
  data: TavernSettings
}): Promise<TavernPreset[]> {
  const list = await listPresets()
  const now = Date.now()
  const name = input.name.trim() || '未命名预设'
  const hit = input.id ? list.find(p => p.id === input.id) : undefined
  const next: TavernPreset = {
    id: hit?.id ?? input.id ?? uid(),
    name,
    data: input.data,
    createdAt: hit?.createdAt ?? now,
    updatedAt: now,
  }
  const merged = hit ? list.map(p => (p.id === next.id ? next : p)) : [...list, next]
  await db.setMeta(K_PRESETS, merged)
  return merged
}

export async function deletePreset(id: string): Promise<TavernPreset[]> {
  const list = await listPresets()
  const merged = list.filter(p => p.id !== id)
  await db.setMeta(K_PRESETS, merged)
  return merged
}

/** 导出成文件文本（JSON）。带 kind / version，方便日后演进格式 */
export function presetFileText(p: TavernPreset): string {
  return JSON.stringify({
    kind: KIND,
    version: 1,
    name: p.name,
    exportedAt: new Date().toISOString(),
    data: p.data,
  }, null, 2)
}

/** 文件名：预设名 + 日期。名字里的路径/非法字符要洗掉，否则下载会失败或名字很怪 */
export function presetFileName(name: string): string {
  // ⚠️ 洗掉之后还要把首尾的占位下划线去掉再判空：名字若全是非法字符（例「///」），
  //    替换出来是「_」，非空但毫无意义 → 会得到一个「__20260914…」的文件名。
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '')
  const safe = cleaned.slice(0, 40) || '预设'
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${safe}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.tavernpreset.json`
}

/**
 * 解析导入的文件。
 * 🔴 校验要**只认形状、不认字段值**：将来加字段不能让今天的文件变得不可导入，
 *   所以只要求 common / plot / free 三段在位（缺了就是别的文件），具体字段由
 *   saveTavernSettings 的深合并去补默认值。
 */
export function parsePresetFile(text: string, fallbackName = '导入的预设'): { preset?: TavernPreset; error?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: '不是合法的 JSON 文件' }
  }
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return { error: '文件内容不是对象' }
  const data = (o.data ?? o.settings ?? o) as Record<string, unknown>
  const okShape = data && typeof data === 'object'
    && typeof data.common === 'object' && data.common !== null
    && typeof data.plot === 'object' && data.plot !== null
    && typeof data.free === 'object' && data.free !== null
  if (!okShape) return { error: '缺少通用 / 剧情推演 / 自由对话三段，不像是酒馆设置的导出文件' }
  const now = Date.now()
  return {
    preset: {
      id: uid(),
      name: String(o.name ?? fallbackName).trim() || fallbackName,
      data: data as unknown as TavernSettings,
      createdAt: now,
      updatedAt: now,
    },
  }
}

