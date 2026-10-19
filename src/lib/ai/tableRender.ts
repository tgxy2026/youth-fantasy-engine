/**
 * 设定表 / 表格段的渲染（3.1.3 从 `aiContext.ts` 抽出：那里贴着 1200 行结构闸）。
 *
 * 三件事都在这儿，因为它们总是要一起改：
 *   · **哪些列能给模型看**（`AUTHOR_SIDE_FIELDS` / `SYSTEM_META_FIELDS` / 隐藏列）
 *   · **带多少条**（`ROW_CAP`，按页签给）
 *   · **单表压到多小**（`DEFAULT_TABLE_MAX_CHARS` → `ai/tableDigest.ts` 先减列再减行）
 *
 * 🔴 角色视角的两道过滤（作者侧字段 / S 级行）必须对**所有来源**生效 ——
 *    3.1.3 给图鉴页签加字段时漏过一次，被 contextRank / tavernFlow 当场抓出来。
 */
import type { TabDef } from '@/lib/types'
import type { TableFieldProjection } from '@/lib/templates/consumers'
import { formatCustomValue } from '@/lib/atlas/values'
import { cellCap } from '@/lib/ai/fieldCap'
import { digestTable } from '@/lib/ai/tableDigest'
import { isPrunedForAI, isSecretRow, sortBySecrecy } from '@/lib/ai/secrecy'
import { clipText } from '@/lib/editor/textClip'

/** 截断（压空白 + 省略号），与 aiContext 里的同名工具同口径 */
function clip(s: string, n: number): string {
  return clipText(s, n, true)
}

/**
 * 🔴 导出给 `semantic/indexer` 复用：索引文本会经〖语义召回〗注回提示词，
 *    所以「不往提示词里写」的列在索引阶段同样要挡（见 indexer 的 renderRow）。
 */
export const SYSTEM_META_FIELDS = new Set(['保密等级'])

/**
 * 作者侧**字段**（卡片字段名 / 表格列名）：写的是「故事将如何发展」或「作者的设计意图」，
 * 不是角色此刻知道什么。
 *
 * 🔴 为什么段落级排除不够（2026-09-14 端到端测试实测）：
 *   像「次要角色」这类**表本身属于角色常识**（萧景行当然知道自己的性格、功法），
 *   但表内混着「结局归宿：卷六雨夜再战，兵解」「隐藏设定：第14章败走时…」这类**未来向**列。
 *   只排除页签的话，这些列会照原样喂给模型 —— 演员提前知道了自己的结局，
 *   「测角色真实反应」同样失效。故角色视角下需再过滤一层。
 *
 * 口径刻意保守：只列**明确指向尚未发生之事 / 作者底牌**的字段；
 * 中性字段（如「备注」「知情度」「关系现状」）一律保留，避免误伤角色常识。
 * 清单可增删 —— 新增页签若带未来向字段，请一并登记到这里。
 */
export const AUTHOR_SIDE_FIELDS = new Set([
  // 角色卡：未来命运与作者规划
  '结局归宿', '死亡/退场规划', '角色弧光', '主角弧光', '高光名场面', '活跃卷与出场频率',
  // 角色卡 / 势力表：作者眼中的「作用」，不是角色认知
  '剧情功能', '剧情作用', '戏剧功能', '功能定位', '本章功能',
  // 人物关系表：关系的**走向**
  '演变轨迹（按卷）', '演变触发事件', '关系终点',
  // 角色卡：作者底牌
  '隐藏设定', '世界终极真相', '体系背后的世界观真相', '体系的隐藏层级', '事件经过（真相）',
  // 结局与揭晓计划
  '计划揭晓章节', '大结局', '各主要角色结局',
  // 伏笔台账（表本身已整体排除，此处兜住散落在其它表里的伏笔列）
  '计划回收位置', '回收前置条件', '回收方式与效果', '对应伏笔编号', '回收伏笔编号', '埋设伏笔编号',
  '可埋伏笔点', '贯穿伏笔推进', '本卷回收伏笔', '本卷新埋伏笔',
  // 世界设定表（worldbase）里的未来向字段 —— 与已登记的「世界终极真相」「可埋伏笔点」同口径。
  // 审计 2026-09-17（P2-12）：原先只登记了同表的一部分，这三个漏网 → 角色视角下照样带进去，
  // 演员会提前知道终局舞台 / 界外真相 / 留白谜题。
  '最终圈', '界外威胁', '世界级悬念',
  // 力量体系 / 物品 / 种族（审计 2026-09-18 P1-1）：同样是「指向尚未发生之事」的列。
  //   漏登记的后果与上面「最终圈」那批一模一样 —— 沉浸档下演员会提前拿到
  //   自己的成长路线（分卷解锁计划）与终局悬念；物品的「流转轨迹」其实是分配计划。
  '金手指的成长路线', '顶端模糊地带',   // 力量体系：分段解锁计划 / 最高境界之上的悬念
  '流转轨迹',                          // 物品资源：谁给谁、怎么给、何时给
  '与主线关系',                        // 种族生物：指向未来的主线关联
  // 制度页签（2026-10-02 · 2.7.1）：新题材模板里的未来向 / 作者底牌字段。
  // 老字段名（如「世界终极真相」「体系的隐藏层级」）在各题材模板里**同名保留** ⇒
  // 上面已登记的条目自动覆盖它们，这里只补**新出现**的字段名。
  '信仰与真相的落差',                  // 宗教信仰：官方教义与真相之间的落差，是作者底牌
])

/** 渲染选项：角色视角下隐藏作者侧字段 */
export type RenderOpts = {
  /** 角色视角：整列剔除「作者侧字段」（见 AUTHOR_SIDE_FIELDS） */
  hideAuthorFields?: boolean
  /**
   * 角色视角：整行剔除「保密等级 = S」的条目（S 是绝密 / 剧透，演员不该看到结局）。
   *
   * 🔴 2026-10-02 六维审计 P0：SABC_DESC 一直写着「S=绝密（角色视角看不到）」，
   *    但实现只做了「按页签 / 字段名排除作者侧资料」——**从没有按 S 级剔行**，
   *    等于文案长期在承诺一件没做的事（作者给条目标了 S，演员照样看得到结局）。
   *    本字段把承诺落地：与 D 级同层的**行级**过滤，且同样不进「另有 N 条未列出」的计数。
   */
  hideSecretRows?: boolean
  /**
   * 单张设定表的字符上限（3.1.3 · R3 摘要化）。
   * 表超过它就**先减列、再减行**（见 `ai/tableDigest.ts`），而不是整段塞进装配器再被裁/被丢。
   * 不传 ⇒ 用 `DEFAULT_TABLE_MAX_CHARS`（够小表原样通过）。
   */
  tableMaxChars?: number
}

/** 各表最多带入的条目数（防止长篇几百行表格直接吃满预算） */
export const ROW_CAP: Record<string, number> = {
  'char-main': 30,
  'char-secondary': 24,
  'char-npc': 20,
  relations: 60,
  terms: 60,
  'chapter-master': 60,
  'chapter-outline': 40,
}
export const DEFAULT_ROW_CAP = 40

/**
 * 单张设定表默认字符上限（装配器未指定时用）。
 * 取 1600：约等于「表头 + 10~15 条摘要」，够模型知道"有这些条目、各是什么来路"，
 * 又不会一张表吃光预算。实测八张表同时进来约 1.1 万字符，16000 预算装得下。
 */
export const DEFAULT_TABLE_MAX_CHARS = 1600

/** 表格型：首行列名，之后每行用 ｜ 分隔（比 JSON 省 token 得多） */
export function renderTable(
  tab: TabDef,
  rows: { data: Record<string, string> }[],
  o: RenderOpts = {},
  /**
   * 3.2.0 · WT0-4：图鉴/自定义页签的**有效字段投影**（不传 ⇒ 走 tab.columns，其他表行为不变）。
   * 🔴 形状刻意收窄成 `{key,label,kind,unit}`：渲染层不需要权限/类别，给多了会被顺手用成第二套口径。
   *    `ResolvedAtlasField` 结构上满足它，老调用方零改动。
   */
  atlasFields?: readonly TableFieldProjection[] | null,
): string {
  // 角色视角：作者侧列整列不渲染（连列名都不出现，避免模型去追问）；
  // 系统元数据列（保密等级）两个视角都不渲染 —— 它已完成使命，对模型只是噪音。
  // 🔴 隐藏列（`cH()` 构造，如《地理风物》的「地图格子」坐标串 `gx,gy;…`）是**给程序用的内部数据**，
  //    表格视图本就不显示 —— 它同样不该进提示词（对模型纯噪声，还白占 token）。
  //    `!c.hidden` 是全项目既有写法（tableIO / TableImportDialog / TableSheet / useTableSheetModel …），
  //    这里与 organizeRows 此前漏了（2026-10-08 补齐，三处口径统一）。
  // 🔴 两道过滤对两种来源都生效（加图鉴字段时漏过一次，被 contextRank / tavernFlow 抓出来）：
  //    SYSTEM_META_FIELDS＝保密等级（纯调度元数据）；AUTHOR_SIDE_FIELDS＝沉浸档整列不能出现。
  const cols = (atlasFields
    ? atlasFields.map(f => f.key)
    : (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name))
    .filter(c => !SYSTEM_META_FIELDS.has(c))
    .filter(c => !(o.hideAuthorFields && AUTHOR_SIDE_FIELDS.has(c)))
  if (cols.length === 0) return ''
  const cap = ROW_CAP[tab.id] ?? DEFAULT_ROW_CAP
  // 🔴 D 级（任何视角）与 S 级（仅角色视角）都先剔除（同 renderCards：正文与「另有 N 行未列出」的计数都不算它）
  const usable = rows.filter(r => !isPrunedForAI(r.data) && !(o.hideSecretRows && isSecretRow(r.data)))
  // 2.2.0：先按「保密等级」排预算优先级（同等级保持录入序）
  // 🔴 2026-10-02 六维审计 P1：**空行过滤必须在 slice 之前**。
  //    原来先 slice(cap) 再滤「本行可见列全空」⇒ 排在那样的行之后的有效行**不递补**，
  //    明明 60 行有效数据只输出 25 行；且计数 `usable.length - cap` 系统性偏小，
  //    模型会以为「剩下的都读过了」（renderCards 没这问题，两份复制品已漂移）。
  const filled = sortBySecrecy(usable).filter(r => cols.some(c => (r.data[c] ?? '').trim()))
  const use = filled.slice(0, cap)
  if (use.length === 0) return ''
  // 表头用字段名（cf_ 键不给模型看），值按类型格式化（多选 JSON → 顿号），否则模型会照抄 JSON 碎片
  const labelOf = (key: string) => atlasFields?.find(f => f.key === key)?.label ?? key
  /**
   * 取字段的自定义类型。
   * 🔴 兼容窗口：`kind` 是 WT0-4 的投影名，`customType` 是旧 `ResolvedAtlasField` 的名字。
   *    两个都认是为了「还没迁移完的调用方不会突然丢掉格式化」——
   *    **等所有调用方都传投影后删掉 `customType` 这一支**（届时本函数只剩 `f?.kind`）。
   */
  const kindOf = (f?: TableFieldProjection) =>
    f?.kind ?? (f as { customType?: TableFieldProjection['kind'] } | undefined)?.customType
  const cellOf = (key: string, raw: string) => {
    const kind = kindOf(atlasFields?.find(x => x.key === key))
    return kind ? formatCustomValue(kind, raw, atlasFields?.find(x => x.key === key)?.unit) : raw
  }
  /** 单元格上限：自定义长文本也给 600（不能只认内置列名，见 cellCap 的注释） */
  const capOf = (key: string) => cellCap(key, kindOf(atlasFields?.find(x => x.key === key)))
  /**
   * 摘要化（3.1.3 · R3）：单表先压到预算内，再交给装配器。
   * 🔴 压缩顺序是「先减列、再减行」，且**只在超限时动手** —— 放得下的小表输出与改造前逐字一致。
   *    这一步解决的是"装配器改不了的胖"：一张 6804 字符的表，靠装配器只能整段丢或整段裁，
   *    而按填充率减列后它能在 1400 字符里保留全部 22 个条目。
   */
  const dig = digestTable({
    columns: cols.map(c => ({ key: c, label: labelOf(c) })),
    rows: use.map(r => cols.map(c => clip(cellOf(c, r.data[c] ?? ''), capOf(c)))),
    maxChars: o.tableMaxChars ?? DEFAULT_TABLE_MAX_CHARS,
    // 名称列是"这条是什么"的唯一锚点，先保它
    preferKeys: [tab.displayCol ?? '名称'],
    totalRows: filled.length,
  })
  return dig.text
}
