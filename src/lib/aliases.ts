/**
 * 别称工具（v1.6）
 * 角色卡 / 世界构建设定条目新增「别称」字段后：
 * 系统在引用高亮、AI 上下文、连续性校验等处把别称解析回「原本名称」所指实体。
 */
import { TABS } from './schema'

/** 把「别称」字段值拆成多个别名：顿号 / 逗号 / 分号 / 空白 均视为分隔符 */
export function splitAliases(v: string | undefined | null): string[] {
  if (!v) return []
  return v
    .split(/[，,、;；\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 读取某页签条目数据里的「别称」列表。
 * 卡片型（表单型）字段键为 `${模块名}::别称`；表格型列名即键 `别称`。
 * 找不到别称字段的页签返回空数组（如名词术语）。
 */
export function readAliases(tabId: string, data: Record<string, string>): string[] {
  const tab = TABS.find(t => t.id === tabId)
  if (tab?.modules) {
    for (const m of tab.modules) {
      if (m.fields.some(f => f.name === '别称')) return splitAliases(data[`${m.name}::别称`])
    }
    return []
  }
  return splitAliases(data['别称'])
}
