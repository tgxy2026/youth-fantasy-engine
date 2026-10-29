// ============ 手册内容 · 角色与世界 ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs/part1.ts` 的角色与图鉴定义、`GuidePage` 的图鉴说明、
// 3.3.1 P8 的方向键实现（网格四向 / 详情四键 / 编辑时避让）。
// 🔴 方向键只写已接入的范围（四类图鉴、角色与其他设定目录、分卷与细纲目录），不承诺全软件通用。
import type { HelpArticle } from '@/lib/help/types'

export const WORLD_ARTICLES: HelpArticle[] = [
  {
    id: 'char-main-guide',
    revision: 1,
    title: '主要角色：一张卡填住一个人',
    summary: '先填主角与 3~5 个核心配角、再加终极反派；左侧目录可切换，立绘可拖进来。',
    aliases: ['角色卡', '人物卡', '主角', '反派'],
    keywords: ['角色', '主要角色', '档案', '立绘', '分组', '目录', '方向键'],
    group: '角色与世界',
    tabIds: ['char-main', 'char-secondary', 'char-npc'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'structure',
        heading: '一张卡的结构',
        body: [
          '左侧是角色目录（一张卡一个人），右侧是这张卡的字段分组：基础信息、外貌与身份、性格与动机、关系与经历等，按组的顺序填即可，不必一次填满。',
          '「主要角色」放主角团、贯穿全书的角色与终极反派；阶段性宿敌、导师、配角放「次要角色」；功能型人物放「NPC 角色」。戏份变了就升降级。',
        ],
      },
      {
        id: 'navigation',
        heading: '用键盘换人',
        body: [
          '把焦点放在左侧目录上，按 ↑ / ↓ 在角色之间切换（会沿用当前搜索与筛选后的顺序），右侧详情跟着换。',
          '在输入框里打字时方向键归光标，不会换人；正在保存或有未处理草稿时会拒绝切换并提示，先保存再换。',
          '立绘可以直接把图片拖到立绘区域上传；立绘正在处理时也不会被切走。',
        ],
      },
    ],
    related: ['atlas-guide', 'relations-guide'],
    actions: [{ label: '打开主要角色', tabId: 'char-main' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'atlas-guide',
    revision: 1,
    title: '图鉴：卡片看、表格改、方向键连着翻',
    summary: '种族生物 / 物品资源 / 国家势力 / 地理风物四类共用一套浏览规则。',
    aliases: ['图鉴', '卡片视图', '表格视图', '种族', '物品', '势力', '地理'],
    keywords: ['图鉴', '卡片', '表格', '排序', '方向键', '详情', '编号', '名称'],
    group: '角色与世界',
    tabIds: ['races', 'items', 'nations', 'geography'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'views',
        heading: '两种视图、三种排序',
        body: [
          '右上角可在「图鉴」（卡片）与「表格」之间切换：卡片用来浏览与看大图，表格用来批量改字段。',
          '图鉴视图的排序有「按编号 / 按名称 / 按最近编辑」，只改这一屏的排列，不动任何数据；想真正改顺序就改「编号」列。',
          '卡片密度（紧凑 / 标准 / 宽松）与界面缩放都会改变一屏能放几张卡。',
        ],
      },
      {
        id: 'keys',
        heading: '方向键：网格与详情是两套规则',
        body: [
          '在卡片网格上：↑ / ↓ 上下换行（同列），← / → 在当前行左右移动，不跨行绕回；最后一行不满、或者已经在边缘，就停在原处。',
          '打开详情后：↑ 与 ← 都是上一条、↓ 与 → 都是下一条，按当前筛选排序连续翻，到首尾停住。详情里也有可点击的「上一条 / 下一条」，触摸设备同样能用。',
          '正在编辑字段、有未保存草稿、保存中或图片处理中时，方向键不会换条目（避免把改了一半的内容丢掉）；表格单元格、下拉、日期选择里的方向键仍是它们自己的行为。',
        ],
      },
    ],
    related: ['char-main-guide'],
    actions: [{ label: '打开物品资源', tabId: 'items' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'relations-guide',
    revision: 1,
    title: '人物关系：把「谁跟谁」画成网',
    summary: '关系不是备注，是能反查的条目；角色改名或删档后要跟着维护。',
    aliases: ['关系图', '人物关系'],
    keywords: ['关系', '人物关系', '势力关系', '反查'],
    group: '角色与世界',
    tabIds: ['relations', 'faction-rels'],
    availability: 'all',
    aiRequirement: 'none',
    prerequisites: ['先有角色卡 / 势力记录，关系才有对象可选'],
    sections: [
      {
        id: 'how',
        heading: '怎么登记',
        body: [
          '一行一条关系：从谁、到谁、什么关系、当前状态。角色表的记录会自动出现在选择项里，不用手打名字。',
          '「势力关系」是同一套做法，对象换成国家势力。',
          '角色改过名或删过档，关系里的旧引用不会自动跟着变 —— 改完角色回来检查一遍这张表。',
        ],
      },
    ],
    related: ['char-main-guide'],
    actions: [{ label: '打开人物关系', tabId: 'relations' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
