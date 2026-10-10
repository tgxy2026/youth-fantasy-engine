/**
 * 跑团互动 · 引用世界版本的读入（3.0 · W4-3e）
 *
 * 【D4=A】跑团局引用某一份世界包的**某一封存版**（§10.3 #11 原文「引用冻结的世界版本」）。
 *   本文件负责把那份冻结版本**渲染成文本**喂给 KP —— 引用是「知道用了哪一版」，
 *   **不是**把世界搬进本项目（要改内容走 W4-1c 的显式引入，那是派生、会留溯源）。
 *
 * 🔴 只读**冻结版本**，不读项目的实时内容 —— 这正是 #11 的边界：
 *   原作品后续改动**不会**影响这一局引用到的世界。
 */
import * as db from '../db'
import type { WorldPackTable } from '../worldTypes'
import type { RunWorldRef } from './runTypes'

/** 渲染上限（字符）：世界资料可能很长，超了就截断 —— 界面上标注被截断，别让模型以为「世界就这么大」 */
export const DEFAULT_WORLD_TEXT_CAP = 4000

function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return '' }
}

/**
 * 把世界表渲染成文本（纯函数，便于测试）。
 * 结构：每张表一段 `【tabId】`，行内 `键=值` 以 `；` 相连；空行跳过。
 * 超过 `cap` 就整体截断并**显式标注** —— 静默截断会让模型以为世界很小。
 */
export function renderWorldTables(tables: WorldPackTable[], cap = DEFAULT_WORLD_TEXT_CAP): string {
  const parts: string[] = []
  for (const t of tables) {
    const lines = (t.rows ?? [])
      .map(r => Object.entries(r.data ?? {})
        .map(([k, v]) => `${k}=${cellText(v)}`)
        .filter(s => !s.endsWith('='))
        .join('；'))
      .filter(Boolean)
    if (!lines.length) continue
    parts.push(`【${t.tabId}】\n${lines.map(l => `· ${l}`).join('\n')}`)
  }
  const text = parts.join('\n')
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n…（世界资料过长已截断，仅带入前 ${cap} 字）`
}

/**
 * 读入某份世界包的某一版并渲染成文本。
 * `version = 0` ⇒ 取**草稿**；≥1 ⇒ 取对应封存版。取不到（世界被删 / 版本不存在）返回空串
 * —— 调用方据此不注入这一层，**不报错**（引用失效不该让整局跑不动）。
 */
export async function resolveRunWorldText(ref: RunWorldRef | undefined, cap = DEFAULT_WORLD_TEXT_CAP): Promise<string> {
  if (!ref?.worldId) return ''
  let rec
  try { rec = await db.getWorld(ref.worldId) } catch { return '' }
  if (!rec) return ''
  const pack = ref.version >= 1
    ? rec.versions.find(v => v.v === ref.version)
    : // 草稿：版本 0（或无版本可选）都取草稿
      { tables: rec.tables, activeSubs: rec.activeSubs }
  if (!pack) return ''
  return renderWorldTables(pack.tables ?? [], cap)
}
