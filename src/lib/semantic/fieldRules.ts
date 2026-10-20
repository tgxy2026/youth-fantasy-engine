// ============ 语义索引 · 字段规则（模板治理来源的唯一入口）============
//
// 索引侧（`indexer`）与召回侧（`gate`）必须读**同一份**规则，否则又会变成
// 「建索引时按一套口径、召回时按另一套」—— 那正是 R04 与 Q2 要堵的绕行通道。
//
// 🔴 三种结果必须分开（Q2-6）：
//   · `none`        —— 非模板治理来源（章节台账等）。没有字段权限这回事。
//   · `rules`       —— 有效配置解析成功。`rules` 为空是**权威空集**（全部禁读/归档）。
//   · `unavailable` —— 读不到配置。此时**无法证明**自定义字段的授权 ⇒ 索引侧跳过所有
//                      `cf_*`，召回侧直接丢弃含 `cf_*` 的旧块。内置字段是公开结构，
//                      可以继续使用（配置坏了不该让整张表失忆）。
//
// 🔴 配置读取失败的判定看 `loadAtlasSchema` 的 `error` 字段：那个函数为了界面展示
//    会把异常吞成空配置，若这里不复检，索引就会把「读失败」当成「作者删光了字段」。
import type { TabDef } from '@/lib/types'
import { isAtlasTab } from '@/lib/atlas/schema'
import { loadAtlasSchema } from '@/lib/atlas/persistence'
import { resolveTemplateCached } from '@/lib/templates/cache'
import { indexRulesOf, type IndexFieldRule } from '@/lib/templates/consumers'
import { loadTemplateDef } from '@/lib/templates/store'
import { loadFieldDefinitions, type FieldDefinitionDoc } from '@/lib/templates/fieldDefinition'
import type { TemplateDef } from '@/lib/templates/definition'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'

/** 字段规则解析结果（三种状态见文件头） */
export type FieldRules =
  | { kind: 'none' }
  | {
    kind: 'rules'
    rules: Record<string, IndexFieldRule>
    /** 建规则时的模板语义摘要（块上存一份，召回时用来快速判断依据变没变） */
    templateDigest: string
    /**
     * 内置字段是否也受这份规则约束。
     * 🔴 生产路径恒为 true（模板解析已给出完整字段集）；只有测试/旧调用传
     *    裸 `fieldRules` 时为 false —— 那时只知道自定义字段规则，不能拿它裁内置列。
     */
    authoritative: boolean
  }
  | { kind: 'unavailable'; reason: string }

export interface FieldRulesDeps {
  loadDef?: (pid: string, tabId: string) => Promise<TemplateDef | null>
  loadConfig?: (pid: string, tabId: string) => Promise<{ config: AtlasSchemaConfig; error?: string }>
  /** 轻量字段定义（T3）；测试注入用，生产走 `loadFieldDefinitions` */
  loadDefs?: (pid: string, tabId: string) => Promise<FieldDefinitionDoc | null>
}

function rulesOfTemplate(template: ReturnType<typeof resolveTemplateCached>): FieldRules {
  return {
    kind: 'rules',
    rules: indexRulesOf(template),
    templateDigest: template.semanticDigest,
    authoritative: true,
  }
}

/** 轻量定义里是否有作者动过的字段（名称 / 说明 / 确认状态） */
function hasDefinitionOverrides(doc: FieldDefinitionDoc | null): boolean {
  return !!doc && Object.keys(doc.fields).length > 0
}

/**
 * 卡片 / 表单页签（非图鉴）的规则：为 T3 的字段定义服务。
 *
 * 🔴 没有轻量定义 ⇒ 仍返回 `none`，老项目一个字节都不动。
 * 🔴 有定义 ⇒ 返回**非权威**规则（`authoritative: false`）：只用来把待确认字段标成
 *    不可读、把改名后的 label 带进索引文本；其余未知键照旧放行 ——
 *    卡片字段是 `模块::字段`，索引侧本来就不按模板裁剪。
 */
async function loadNonAtlasRules(
  pid: string,
  tab: TabDef,
  deps: FieldRulesDeps,
): Promise<FieldRules> {
  let doc: FieldDefinitionDoc | null
  try {
    doc = await (deps.loadDefs ?? loadFieldDefinitions)(pid, tab.id)
  } catch (e) {
    return { kind: 'unavailable', reason: `读取字段定义失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!hasDefinitionOverrides(doc)) return { kind: 'none' }
  try {
    const tpl = resolveTemplateCached(tab, {
      purpose: 'index',
      ignoreAppliesTo: true,
      ...(doc ? { fieldDefinitions: doc } : {}),
    }, pid)
    return {
      kind: 'rules',
      rules: indexRulesOf(tpl),
      templateDigest: tpl.semanticDigest,
      authoritative: false,
    }
  } catch (e) {
    return { kind: 'unavailable', reason: `解析字段定义失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 读一个页签的字段规则。
 *
 * 优先级与页面/AI 完全一致：**项目采用快照 → 图鉴配置 → 内置**。
 * 只要有快照就不再读图鉴配置（快照才是作者当下采用的结构）。
 */
export async function loadFieldRules(
  pid: string,
  tab: TabDef,
  deps: FieldRulesDeps = {},
): Promise<FieldRules> {
  if (!pid) return { kind: 'none' }
  if (!isAtlasTab(tab.id)) return loadNonAtlasRules(pid, tab, deps)

  let def: TemplateDef | null
  try {
    def = await (deps.loadDef ?? loadTemplateDef)(pid, tab.id)
  } catch (e) {
    return { kind: 'unavailable', reason: `读取模板快照失败：${e instanceof Error ? e.message : String(e)}` }
  }

  try {
    if (def) {
      // 快照自带含义确认状态，轻量定义不再叠加（采用后结构由作者接管）
      return rulesOfTemplate(resolveTemplateCached(tab, { def, purpose: 'index', ignoreAppliesTo: true }, pid))
    }
    const loaded = await (deps.loadConfig ?? loadAtlasSchema)(pid, tab.id as Parameters<typeof loadAtlasSchema>[1])
    if (loaded.error) {
      return { kind: 'unavailable', reason: `读取字段配置失败：${loaded.error}` }
    }
    // 🔴 T3：未采用模板的页签，含义确认状态在轻量定义里。读不到定义 ⇒ 无法证明哪些字段
    //    待确认，按 Q2-4 的口径直接判 `unavailable`（宁可不给资料，也不放行未确认内容）。
    let doc: FieldDefinitionDoc | null
    try {
      doc = await (deps.loadDefs ?? loadFieldDefinitions)(pid, tab.id)
    } catch (e) {
      return { kind: 'unavailable', reason: `读取字段定义失败：${e instanceof Error ? e.message : String(e)}` }
    }
    return rulesOfTemplate(resolveTemplateCached(
      tab,
      {
        config: loaded.config,
        purpose: 'index',
        ignoreAppliesTo: true,
        ...(doc ? { fieldDefinitions: doc } : {}),
      },
      pid,
    ))
  } catch (e) {
    return { kind: 'unavailable', reason: `解析字段配置失败：${e instanceof Error ? e.message : String(e)}` }
  }
}
