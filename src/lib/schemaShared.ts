/**
 * schema 的**共享声明层**（2026-10-03 从 schema.ts 拆出）。
 *
 * 为什么拆：`TABS` 数组体一度把 schema.ts 顶到 1199 行（结构闸硬上限 1200，只差 1 行破闸）。
 * 这里放的是「数组体与门面都要用」的东西 —— 字段构造器、保密等级枚举、卷台账合成、制度页签工厂。
 * 🔴 **段文件（schemaTabs/part1..3）只许依赖本文件，不许回头 import schema.ts** ——
 *    那样会成循环依赖，模块初始化顺序会让 const 在 TDZ 里炸。
 * 🔴 字段构造器（c / cr / ca …）是**列名即存储键**那条纪律的落点：改名字段定义就换了存储位置，
 *    已填数据会读不到。给作者改名请用 `lib/fieldAlias.ts` 的显示名，不要动这里。
 */
import type { TabDef, TableColumn, Volume } from './types'
import { getAllVolumes } from './db'
import { getActivePack, institutionMeta, institutionModules } from './schemaTemplates'

// 工具函数：快速构造字段
/** 🔴 本文件是字段构造器的**唯一定义处**（段文件与门面都从这里 import）—— 别在别处再抄一份 */
export const f = (name: string, desc: string, example: string) => ({ name, desc, example })
export const c = (name: string, opts?: string[], width?: string) => ({
  name,
  type: opts ? ('select' as const) : ('text' as const),
  options: opts,
  width
})
/**
 * **固定选项列**：选项由 schema 定义，不允许作者在下拉里增 / 改 / 删 / 移除。
 *
 * 🔴 为什么要有它：「保密等级」不是普通的分类标签，它同时被**两套机器逻辑**读 ——
 *    AI 上下文预算排序（`aiContext.rankOf`）与角色视角可见性。作者随手加一个自定义值
 *    （或把 S 改名、把某档移除），这两套逻辑就认不出来：排序静默失效、该档数据在
 *    角色视角下也不再被排除。所以这类列必须是**封闭枚举**，界面上也不给出增改入口
 *    （见 components/CustomSelect 的 fixedOptions）。
 */
export const cFixed = (name: string, opts: string[], width?: string) => ({
  name,
  type: 'select' as const,
  options: opts,
  width,
  fixedOptions: true
})
/** 严格"故事内时间"列：某年某月某日（结构化日期输入，防止时间轴排序出错） */
export const cd = (name: string, width?: string) => ({
  name,
  type: 'date' as const,
  options: undefined,
  width
})
/** 真实日历日期列：弹出月历选择（写作进度日期、设定变更日期等真实日期） */
export const cc = (name: string, width?: string) => ({
  name,
  type: 'calendar' as const,
  options: undefined,
  width
})
/** 角色选择列：选项来自已创建角色卡，禁止手动输入（人物关系 人物A / 人物B） */
export const ch = (name: string) => ({ name, type: 'character' as const, options: undefined })
/** 角色多选列：从已创建角色卡中多选，禁止手动输入（知情权限 知情者） */
export const chs = (name: string) => ({ name, type: 'characters' as const, options: undefined })
/** 历法列：选项来自项目级历法配置（多历法数值体系：名称 + 数值，数值用于跨历法先后顺序判断）。
 *  🔴 2.7.2 起本列**只选不建** —— 新增 / 改名 / 删除 / 改数值全部在页头「历法规则」弹窗里统一管理
 *     （改名会连带更新已引用旧名的行）。别再把它改回「就地可新增」。 */
export const ca = (name: string) => ({ name, type: 'select' as const, options: undefined, calendar: true })
/** 跨表引用列：选项来自另一张设定表的指定列（禁止手动输入，根治"同名异写"导致的归属错乱）。refTab=来源表，refCol=取名列 */
export const cr = (name: string, refTab: string, refCol: string) => ({ name, type: 'tableRef' as const, options: undefined, refTab, refCol })
/** 隐藏列：表格视图不显示，但数据保留（如 地图格子 仅由地图编辑绘制维护） */
export const cH = (name: string, opts?: string[], width?: string) => ({ name, type: opts ? ('select' as const) : ('text' as const), options: opts, width, hidden: true })

/** 角色卡中「从其他设定表取值、禁止手动输入」的字段 → 来源表与列（用于势力 / 世界联动，与 CharacterSheet / SettingSearch 共用）
 *  `multi: true` ＝ 该字段支持**多选**（值以「，」连接存储，与 CharacterSelect multi 同格式）。
 *  ⚠️ 多选是 2.4.4 社区反馈（人物可同时属于多个势力）；AI 关联判断的风险提示写在各卡字段的 desc 里。 */
export const CARD_TABLE_REF_FIELDS: Record<string, { tabId: string; col: string; multi?: boolean }> = {
  '所属势力': { tabId: 'nations', col: '名称', multi: true },
  '种族': { tabId: 'races', col: '名称' },
  '地理位置': { tabId: 'geography', col: '名称' },
}

/**
 * 「保密等级」= 信息档位 的统一说明：9 个页签共用这一份，改定义只改这里（避免各写一份后漂移）。
 *
 * 2.2.0 起语义升维 —— 它不再只是"保密"，而是**同时**决定三件事：
 *   ① 谁看得到：S 级在角色视角（剧情推演/扮演）下按 `isSecretRow` 整行剔除（作者 / 导演视角照常带上）；**D 级谁也不给**；
 *   ② 谁先占 AI 上下文预算：S 最先带入 → A → B → C 超预算时最先让位（`rankOf` 另给一个大数当第二道保险）；
 *   ③ **D 级（终结 / 弃用）任何情况下都不进 AI** —— 不是"排最后"，是压根不带：它的定义就是"已经用完或不再使用的数据"，
 *      再塞给模型只是拿过时的结论污染新判断。硬保证在 `lib/aiContext.ts` 的 `isPrunedForAI`（三处都过滤）。
 */
export const SABC_DESC = '信息档位：决定「谁看得到」与「谁先占上下文预算」。S=绝密（角色视角看不到）／D=终结（弃用）：已用完或不再使用的数据，任何情况下都不提供给 AI'

/**
 * 保密等级的**五个档位**（单一源）。
 *
 * ⚠️ 别再在别处硬编码 ['S','A','B','C'] —— 2.2.0 加 D 档时发现设定检索里就藏着一份副本
 *    （`SettingSearch` 的 `CARD_SELECT_FIELDS`），漏改的后果是"表格里能选 D、检索面板选不到"
 *    这种静默不一致。
 */
export const SABC = ['S', 'A', 'B', 'C', 'D']

/** 保密等级的展示文案：存储值保持单字母，展示时附含义（剧透 / 主线 / 支线 / 日常 / 弃用） */
export const SABC_LABELS: Record<string, string> = {
  S: 'S · 绝密（剧透）',
  A: 'A · 重要（主线）',
  B: 'B · 次要（支线）',
  C: 'C · 琐碎（日常）',
  D: 'D · 终结（弃用）',
}

/**
 * 卷台账（按卷建表）共用的列定义：去掉了「所属卷」——卷身份由所在表本身表达。
 * 章节总表（只读汇总）与各卷子表共用这套列。
 */
export const CHAPTER_LEDGER_COLUMNS: TableColumn[] = [
  c('章节号'), c('章节标题'), c('一句话事件'),
  c('出场人物'), c('埋设伏笔编号'), c('回收伏笔编号'),
  c('细纲状态', ['无', '已排', '已核对']), c('字数'), cc('发布日期'),
  c('备注'),
]

// ============ 卷台账（按卷建表）的 tabId 约定与合成 ============
const VOLUME_LEDGER_PREFIX = 'chapter-vol-'
export function getVolumeLedgerTabId(volumeId: string) { return `${VOLUME_LEDGER_PREFIX}${volumeId}` }
export function isVolumeLedgerTab(id: string) { return id.startsWith(VOLUME_LEDGER_PREFIX) }
/** 从卷台账 tabId 反解出真实的卷库 id（去掉 `chapter-vol-` 前缀）；若传入的本身就是卷 id 则原样返回 */
export function getVolumeIdFromLedgerTab(tabId: string): string {
  return isVolumeLedgerTab(tabId) ? tabId.slice(VOLUME_LEDGER_PREFIX.length) : tabId
}

/** 运行期由 volumes 库合成的卷台账 TabDef 缓存：getTab 据此解析 chapter-vol-<id> */
let _volumeTabs: TabDef[] = []
export function setVolumeTabs(vols: Volume[]) {
  _volumeTabs = vols.map<TabDef>(v => ({
    id: getVolumeLedgerTabId(v.id),
    name: v.title || '未命名卷',
    group: '大纲规划',
    type: 'table',
    description: `「${v.title}」的章节台账（按卷建表）：本卷每章一行，串联伏笔/时间脉络/爽点。`,
    columns: CHAPTER_LEDGER_COLUMNS,
    displayCol: '章节标题',
    subtitleCol: '细纲状态',
    newestFirst: true,
  }))
}
export function getVolumeTabs(): TabDef[] { return _volumeTabs }

/** 从 volumes 库刷新卷台账缓存（项目打开 / 卷增删改后调用） */
export async function refreshVolumeTabs(): Promise<void> {
  try {
    const vols = await getAllVolumes()
    setVolumeTabs(vols)
  } catch { /* 无项目或库未就绪时静默 */ }
}

/** 制度页签的四个 id（🔴 顺序＝侧栏显示顺序） */
export const INSTITUTION_TABS = ['politics', 'economy', 'belief', 'justice'] as const

/**
 * 构造一个制度页签（政治架构 / 经济基础 / 宗教信仰 / 司法制度，2.7.1 建 · 2.7.2 改并列结构）。
 *
 * 四个页签除 id 外结构完全一致 ⇒ 走工厂，避免四份几乎相同的字面量各自漂移。
 * 🔴 **模块与 id 均与题材无关**（一套定义，见 schemaTemplates/institutions.ts）；
 *    题材只影响各字段的 desc/example（文案随题材变）。
 *    显隐判据在 `tabVisible`：**完整项目一律显示**（2.7.2 起不再按题材隐藏）。
 */
export function institutionTab(id: (typeof INSTITUTION_TABS)[number]): TabDef {
  const meta = institutionMeta(id)
  return {
    id, group: '开书定位', type: 'form',
    get name() { return institutionMeta(id)?.name ?? id },
    description: meta?.description ?? '',
    // 🔴 2.7.2：改成 getter 读当前题材 —— 制度四页签的**示例**也随题材走了
    //    （原先是一套古史 defaults 写死，写科幻的作者看到「笞杖徒流死」会一头雾水）。
    //    与 worldbase / power 同一范式：字段名与 desc 不变，只换 example。
    get modules() { return institutionModules(id, getActivePack()) },
    tips: meta?.tips,
  }
}
