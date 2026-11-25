import { BookOpen, Lightbulb, ListOrdered, Sparkles } from 'lucide-react'
import { TABS, EDITOR_TAB, EDITOR_ID, tabVisible, type VisCtx } from '@/lib/schema'
import HelpPopover from '@/components/common/HelpPopover'
import { PAGE_DESCRIPTION_CLASS, PAGE_HEADER_STICKY_CLASS, PAGE_TITLE_CLASS } from '@/components/common/PageHeader'
import { Button } from '@/components/common/Button'
import HelpCenter from '@/components/help/HelpCenter'
import { GuideSettings } from '@/components/help/GuideSettings'
import CapabilityPanel from '@/components/app/CapabilityPanel'
import { VERSION_ARTICLES } from '@/lib/help/articles/version'

interface Props {
  onNavigate: (id: string) => void
  /** 项目形态：精简/极简项目隐藏对应标记的页签 */
  ctx: VisCtx
}

const FILL_ORDER = [
  'positioning', 'worldbase', 'power', 'char-main', 'char-secondary',
  'history', 'master', 'volume-outline', 'chapter-master', 'chapter-outline'
]

// 全部功能页签按分类分组的展示顺序（对应"从零开书"的递进流程）
// 末尾两项是工具 / 玩法类：正文写作是码字现场，酒馆模式是可选的角色扮演玩法。
// ⚠️ 本清单必须与 schema.ts 的 GROUPS 保持覆盖一致 —— 漏一个组，整组页签就从这一页消失
//    （曾因此漏掉整个酒馆模式：页签、说明、跳转全都没有）。
const GROUP_ORDER = [
  // 🔴 '工作面板' 必须在内（2026-10-10 六维审计）：它装着「模型设置」，漏了整组就从这页消失
  //    —— 而上面那条注释自己就写着「必须与 schema.ts 的 GROUPS 保持覆盖一致」。顺序与 GROUPS 一致（在第一位）。
  '工作面板', '开书定位', '大纲规划', '角色管理', '世界构建', '创作管理', '运营维护', '灵感工具', '正文写作', '酒馆模式'
]

/** 正文编辑不在 TABS 里（是 EDITOR_TAB 常量），故在列表里单独成条 */
const EDITOR_DESC = '真正码字的地方：左侧带设定检索栏，可边写边查。'

const TIPS: { title: string; body: string }[] = [
  { title: '先定位再动笔', body: '开书前先填作品信息：赛道、平台、读者、卖点没想清楚就动笔，多半会切书。' },
  { title: '全书总纲先行', body: '可先记下主线、大结局和分卷计划，写完一卷后再回看修订。' },
  { title: '世界观三层填法', body: '底层法则（定了不改）→社会文明（前十章展开）→细节（随写随补）。世界观是舞台不是字典。' },
  { title: '等级表是宪法', body: '力量体系的等级一旦正文发布尽量不改；定稿前先写三章试水，检验数值是否膨胀。' },
  { title: '角色三档分级', body: '主要角色=核心；次要角色=阶段性宿敌/导师/配角；NPC=功能型。戏份变了及时升降级。' },
  { title: '问答法深挖动机', body: '对着角色卡连问三个「为什么」，问到第三个为什么，动机才立得住。' },
  { title: '随写随登记', body: '正文里每写出一个新设定立刻回表登记，连载百万字后你会感谢这套表。' },
  { title: '伏笔与前置条件', body: '伏笔登记时同步写清「回收前读者需要知道什么」——前置没铺就强行回收，效果大打折扣。' },
  { title: '章末留出下一章的期待', body: '可用悬念、人物抉择或尚未兑现的目标承接下一章。' },
  { title: '改设定先过设定变更', body: '连载中要改设定，先登记旧值新值、影响范围、已发布冲突——冲突未处理前不发布后续章节。' },
  { title: '知情权限随时登记', body: '读者对「谁知道什么」记得比你牢；每当有角色知悉秘密当天登记，防泄密穿帮。' },
  { title: '灵感即时入库', body: '灵感出现的当天就登记；写细纲卡壳先翻素材库再硬编。' },
]

/**
 * 3.2.0 新增能力（本版主题＝「修订与核对」）——**不新增页签**，补的是几个入口的用法。
 * 🔴 只写作者真能看见、真会用到的；不写实现细节（那是 docs 的事）。
 */
const REVISION_TIPS: { title: string; body: string }[] = [
  {
    title: 'AI 产出的稿先审阅再应用',
    body: '「创作轨迹 → 候选审阅」里，AI 改写出的稿子先躺在那里。点应用前会比对正文：你要是自己改过，它会直接拒绝，不会盖掉你的编辑。',
  },
  {
    title: '改写完看「复检」',
    body: '工单里每章标题旁会写：原问题已清 / N 条没解决 / 复检没跑成。「已改写」只代表改过了，复检才回答「改好了没」。',
  },
  {
    title: '检查报告能翻回去看',
    body: '「创作轨迹 → 检查报告」留着过去查到的问题（只有冲突/注意级才留档，全绿不占空间），每条带原文引文与「引文 N/M 可定位」。',
  },
  {
    title: '实体保留自检只提示不判定',
    body: '改写后哪些已登记的人物/势力名没再出现，会列在每章标题旁。少提一个名字常常是正常润色 —— 丢没丢设定，你自己判断。',
  },
  {
    title: '结构化输出：确认了再开',
    body: '「模型设置」里可声明端点支持结构化输出，开了之后 JSON 类任务更稳。不确定端点支不支持就保持关闭（默认关，不会偷偷发）。',
  },
  {
    title: '额度有上限，撞顶会停',
    body: '一次整章改写最多 6 次调用、一次性任务 3 次；到上限会停下来并如实告诉你，不会在后台一直重试把额度烧完。',
  },
  {
    title: '图鉴能按三种顺序看',
    body: '「种族生物 / 物品资源 / 国家势力 / 地理风物」的图鉴视图右上角有「按编号 / 按名称 / 按最近编辑」——只改这一屏的排列，不动任何数据。想真正改顺序就改「编号」列。',
  },
  {
    title: '中文标点会自己配成对',
    body: '打「“」「《」「「」「（」这些左半个，会自动补上右半个、光标停在中间。改用哪家输入法都一样（不用再依赖搜狗/微信自己的设置）；英文引号与粘贴不受影响。',
  },
  {
    title: '图片可以直接拖进来',
    body: '头像、项目封面、图鉴主图、地图底图、看板娘、人物立绘 —— 把图片拖到那块区域里就上传，不必先点按钮。拖错东西会明确告诉你原因（不是图片 / 拖的是文件夹 / 文件是空的）。',
  },
]

/**
 * 3.4.0 新增能力（长篇创作工作台）——**不新增页签**，补的是"规划 → 参考 → 修订 → 导出"的往返。
 * 🔴 只写作者真能看见、真会用到的；失败与边界照实写（失效章节、12 版上限、不是备份）。
 */
const V340_TIPS: { title: string; body: string }[] = [
  {
    title: '规划板能看见每章的细纲绑定',
    body: '写作面板的章节规划板里，每张卡会写「细纲：某卡 · 固定资料 N 条」。它读的是你在正文「本章资料」里亲手做的绑定，不按章节名去猜；没绑定就写「未绑定细纲」，绑定的卡被删了会写「已失效」。',
  },
  {
    title: '收藏集：把跨卷的章收在一起',
    body: '同一章可以进多个收藏集，按原有叙事顺序显示，不改正文顺序、不复制正文。删收藏集只删分组，章节还在；章节被删后成员会标为不可用，可手动移除。',
  },
  {
    title: '导出方案只记选择，不是备份',
    body: '平台粘贴版、Markdown、投稿 DOCX 都能只导选定章节，也能把当前选择存成具名方案。方案只存章节与排版意图；里面有已删章节时会拒绝应用并列出，不会静默漏导。稿件导出不等于作品备份 —— 备份仍走项目导出。',
  },
  {
    title: '随手记与命名快照',
    body: '「随手记灵感」直接存进本作品的灵感夹，可顺带关联一章（之后能从这里打开那一章）；保存失败会保留输入。时光机里可以存带名称/备注的快照，但它和自动快照共用每章 12 版上限，会被新版本挤出，不是永久归档。',
  },
]
const V360_TIPS: { title: string; body: string }[] = [
  {
    title: '分析结果会存成「成果记录」',
    body: '拆书分析、参考卡可以保存为成果，之后在成果列表回看：保留 / 草稿 / 已排除三种状态各自可见。标了「已排除」的成果不会被发给模型 —— 排除是你的否定决定，不是「还没审」。导出项目时成果跟着走；指向已删章节的会标「失效」并降为草稿，不会悄悄丢掉。',
  },
  {
    title: '一键拆书：分清「本次范围」和「全书」',
    body: '拆书结果会写明这次分析覆盖到哪、哪些只是范围结论，不会把局部结果说成全书结论。失败或没跑完会如实标注，不会用空结果冒充「没有变化」。',
  },
  {
    title: '创作参考只发你勾选的那几张',
    body: '参考卡按预算裁剪（最多 12 张、约 2400 字），并明确告诉模型「这是别的作品的写法，不要照搬情节和人名」。来源过期或读不到时一条都不发，界面上会说明原因；你标为「已排除」的参考不会被勾选、也不会被发送。',
  },
  {
    title: '审读记录可以回看',
    body: '审读跑完会留下摘要记录，在创作轨迹里能翻回来看。失败会如实呈现，不会生成一条空记录冒充成功。',
  },
  {
    title: '章后整理：保存和整理是两件事',
    body: '正文保存成功后，整理失败只会显示「整理待恢复」，不会宣称整章已经原子完成。整理页也会标「本次会读」：只把本章正文发给模型，伏笔 / 关系 / 角色卡 / 设定表的比对都在本机做。',
  },
  {
    title: '剧情候选：能应用、能放弃、能追溯',
    body: '候选生成后可应用或放弃；放弃的不会再冒出来。从「检查报告 → 以此发起修订」进来的候选会带上报告编号，之后能回答「这稿是按哪份报告改的」；手填要求改写的候选不带来源，不编造。',
  },
  {
    title: '材料检索带来源章节',
    body: '检索结果会标出命中来自哪一章，空项目给空态而不是报错。',
  },
  {
    title: '图鉴字段：适用范围不能留空',
    body: '自定义字段的「适用类别」如果存成空数组，会变成「图鉴永远不显示」的死配置 —— 现在保存会被拦下，并给一个「改为不限类别」的单条动作。隐藏字段的数量与图鉴卡片、详情用同一个判定，0 个时不占地方。',
  },
]

const V361_TIPS: { title: string; body: string }[] = [
  {
    title: '「未来计划待重审」能看依据了',
    body: '章后整理里每条待重审的章，右侧多了「看依据」：展开是改动处的「改前 → 改后」片段（各最多 300 字，超出会标已截断）。依据只留变化的那一小段，不会把整章正文再存一份；更早打的标记没有依据时会如实说明。核对完点「已处理」只清提示，不改章纲。',
  },
  {
    title: '图鉴详情能「按语义看」',
    body: '详情里字段分组下方多了一个默认收起的「按语义看（身份 / 动机 / 状态）」，按这三个用途重列一遍并标出处（这条值来自哪一栏）。它只是读取：不写回、不另存一份；要改内容仍回表格改原字段。',
  },
  {
    title: '同步冲突：不能恢复时不会再给你按钮',
    body: '冲突面板里「恢复云端章节」只在真的能恢复时出现（章节冲突 + 云端那版还在 + 本机这一章还在 + 属当前项目）；不满足时会写清是哪一条不满足，而不是把按钮藏起来让你去点「删除副本」。删除副本仍要二次确认，并建议先导出。',
  },
]

export default function GuidePage({ onNavigate, ctx }: Props) {
  return (
    <div className="w-full page-enter">
      <header className={`${PAGE_HEADER_STICKY_CLASS} mb-5`}>
        <div className="flex items-center gap-2">
          <h1 className={PAGE_TITLE_CLASS}>使用指南</h1>
          <HelpPopover title="使用指南怎么看" width="22rem" size={14}>
            {'这一页是全软件的地图，卡壳时先回这里。\n\n· 推荐填写顺序：按 1→10 的顺序点进去填，可按作品需要调整顺序，点任意按钮可直达该页签；\n· 全部功能页签：所有页签的一句话说明，点标题直接跳转；\n· 核心创作方法论：12 条网文实操心法，动笔前后各看一遍。\n\n页面有问号图标时，可点开查看当前功能的操作说明。\n\n【两种帮助入口的分工】\n· 页面里的「?」：只讲你正在用的这一块（字段含义、选项影响），随开随关，不动任何数据；\n· 左下角「本页指引」：进本页的分步引导，把主要区域按顺序走一遍；看过的页签不会重复弹，可随时重看，自动弹出也能在设置里关掉。\n\n要找跨页流程（例如怎么从拆书走到创作参考），到本页的「使用手册」里搜关键词。'}
          </HelpPopover>
        </div>
        <p className={PAGE_DESCRIPTION_CLASS}>手册搜索、分步引导与推荐填写顺序，一页看懂怎么用。</p>
      </header>

      {/* 3.3.1 · P1：内置使用手册（本地检索，不需要模型）。放在最上面：卡壳时先搜一句，
          比在页签清单里逐个点进去试更快。 */}
      <div className="mb-6" data-guide="guide-manual">
        <HelpCenter onNavigate={onNavigate} ctx={ctx} currentTabId="guide" />
      </div>

      {/* 3.3.1 · P2：引导的开关与重置（关掉自动引导后，从这里恢复） */}
      <div className="mb-6" data-guide="guide-settings">
        <GuideSettings />
      </div>

      {/* 推荐填写顺序 */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <ListOrdered size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">推荐填写顺序</h2>
          <HelpPopover title="推荐填写顺序" width="21rem">
            {'这是「从零开书」的标准路径：\n\n1-3 先定位与世界底层（赛道/读者/卖点、世界法则、力量体系）；\n4-5 立住主角与核心配角；\n6 用倒推法把历史事件从结局倒推回开篇；\n7-8 写全书总纲与分卷规划；\n9-10 落到章节总表与章节细纲，然后就可以动笔了。\n\n不必一次填满：每卷开写前补一轮，写完一卷回看修订一轮。'}
          </HelpPopover>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap items-center gap-1.5">
            {FILL_ORDER.map((id, i) => {
              const tab = TABS.find(t => t.id === id)
              if (!tab || !tabVisible(tab.id, ctx)) return null
              return (
                <div key={id} className="flex items-center gap-1.5">
                  <Button variant="secondary" onClick={() => onNavigate(id)} className="px-3 py-1.5 rounded-lg text-12 hover:border-amber/50 hover:text-amber transition-colors">
                    {i + 1}. {tab.name}
                  </Button>
                  {i < FILL_ORDER.length - 1 && <span className="text-ink-600 text-10">→</span>}
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-11 text-ink-400">历史事件用倒推法（从大结局倒推到开篇）；写作期间持续维护伏笔、时间脉络与设定变更。</p>
        </div>
      </section>

      {/* 全部页签 */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <BookOpen size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">全部功能页签</h2>
          <HelpPopover title="全部功能页签" width="21rem">
            {'软件里每个页签的职责一览，点任意一项直接跳转。\n\n· 表单型页签（作品信息、世界设定、全书总纲…）：一栏一栏填，Ctrl+S 保存；\n· 表格型页签（伏笔、时间脉络、爽点、设定变更…）：一行一条记录，随写随登记；\n· 卡片型页签（角色卡、分卷大纲、章节细纲）：一张卡一个对象，左侧目录切换；\n· 正文编辑：真正码字的地方，左侧带设定检索栏可边写边查；\n· 颉文姬 · AI 编辑：正文工具栏的「颉文姬」按钮，也可使用已启用的 Q 版精灵——诊室（校对·文字层 / 校对·逻辑层 / 综合诊断）、编辑（选区润色、手动续写）、审读（六维打分 / OOC / 续写方向 / 爽点毒点 / 黄金三章）、简报（开写前的本章写作简报）、补登（抽出本章新设定，勾选后登记进设定表或角色卡）、整理（复核章后变化再写入）。AI 的运行条件见手册「颉文姬」。\n· 自定义项目：本页列出全部页签，未启用的功能以灰色显示且不可跳转；要启用请回到项目管理页编辑项目功能清单。'}
          </HelpPopover>
        </div>
        <div className="p-5 space-y-6">
          {GROUP_ORDER
            .map(g => ({
              group: g,
              items: g === '正文写作'
                ? [{ id: EDITOR_ID, name: EDITOR_TAB.name, description: EDITOR_DESC }]
                : TABS.filter(t => t.type !== 'dashboard' && t.type !== 'guide' && t.group === g),
            }))
            .filter(g => g.items.length > 0)
            .map(({ group, items }) => (
              <div key={group}>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <span className="w-1 h-3 rounded-full bg-amber/70" />
                  <span className="text-12 font-semibold text-ink-200">{group}</span>
                  <span className="text-10 text-ink-600">{items.length} 项</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-x-6 gap-y-1">
                  {items.map(item => {
                    const enabled = tabVisible(item.id, ctx)
                    return (
                      <Button variant="bare"
                        key={item.id}
                        disabled={!enabled}
                        onClick={() => enabled && onNavigate(item.id)}
                        className={`group flex-col items-stretch w-full text-left py-2 border-b border-ink-700/50 transition-colors ${enabled ? 'hover:border-amber/30 cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`flex-1 min-w-0 text-13 font-medium transition-colors ${enabled ? 'text-ink-100 group-hover:text-amber' : 'text-ink-500'}`}>{item.name}</span>
                          {!enabled && <span className="shrink-0 text-9 px-1 py-0.5 rounded bg-ink-700 text-ink-400">未启用</span>}
                        </div>
                        <div className={`text-11 mt-0.5 line-clamp-1 ${enabled ? 'text-ink-400' : 'text-ink-600'}`}>{item.description}</div>
                      </Button>
                    )
                  })}
                </div>
              </div>
            ))}
        </div>
      </section>

      {/* 3.7.x 近期版本更新说明（与内置手册 version.ts 同源，按版本倒序展示） */}
      {[...VERSION_ARTICLES].reverse().map(art => (
        <section key={art.id} className="mb-6 bg-ink-850/95 rounded-xl border border-ink-700/75 overflow-hidden ws-surface">
          <div className="px-5 py-3 bg-ink-800/80 border-b border-ink-700/70 flex items-center gap-2">
            <Sparkles size={14} className="text-amber" />
            <h2 className="text-13 font-semibold text-ink-100">{art.title}</h2>
            <span className="text-10 px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30 ws-num">
              v{art.verifiedAgainst}
            </span>
          </div>
          <div className="p-5 space-y-3">
            <p className="text-12 text-ink-300 leading-relaxed">{art.summary}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {art.sections.map(sec => (
                <div key={sec.id} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-4 py-3 space-y-1.5">
                  <div className="text-12 font-semibold text-amber/90">{sec.heading}</div>
                  {sec.body.map((p, idx) => (
                    <p key={idx} className="text-11 text-ink-300 leading-relaxed">{p}</p>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}

      {/* 3.2.0 新增能力（不新增页签，补的是入口用法） */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <Sparkles size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">3.2.0 · 修订与核对</h2>
          <span className="text-10 px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30">该版新增</span>
          <HelpPopover title="这个版本改了什么" width="22rem">
            {'这个版本没有新页签，改的是「改稿靠不靠得住」：\n\n· 稿子先生成候选、你审阅后才落正文；\n· 落库前会比对正文，改过了就拒绝；\n· 改完自动复检，告诉你问题解决没；\n· 检查结论留档可回看，带原文引文与定位结果；\n· 额度有硬上限，撞到就停。\n\n另有几处顺手改进：图鉴可按编号/名称/最近编辑三种顺序看、中文标点自动配对、图片可直接拖拽上传。\n\n所有结论只如实呈现：没查到就写没查到，做不到就写做不到。'}
          </HelpPopover>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
          {REVISION_TIPS.map(tip => (
            <div key={tip.title} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-4 py-3">
              <div className="text-12 font-semibold text-amber/90">{tip.title}</div>
              <div className="text-11 text-ink-300 leading-relaxed mt-1">{tip.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 3.4.0 新增能力：规划板往返、收藏集、导出方案、随手记与命名快照 */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <Sparkles size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">3.4.0 · 长篇创作工作台</h2>
          <span className="text-10 px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30">该版新增</span>
          <HelpPopover title="这个版本改了什么" width="22rem">
            {'这个版本没有新页签，补的是「规划 → 参考 → 修订 → 导出」的连续工作流：\n\n· 规划板记住你离开时的筛选与位置，回来不用重筛；卡片顺带显示细纲绑定与固定资料条数；\n· 章节收藏集把跨卷章节收在一起，只分组、不动正文顺序；\n· 导出可只导选定章节，并把选择存成具名方案；失效章节会明确列出；\n· 写作面板可直接随手记灵感（可关联章节）；时光机可存带名称/备注的快照。\n\n边界照实写：失效章节不会静默跳过、命名快照仍受 12 版上限、稿件导出不是作品备份。'}
          </HelpPopover>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {V340_TIPS.map(tip => (
            <div key={tip.title} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-4 py-3">
              <div className="text-12 font-semibold text-amber/90">{tip.title}</div>
              <div className="text-11 text-ink-300 leading-relaxed mt-1">{tip.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 3.6.0：拆书分析与创作闭环 */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <Sparkles size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">3.6.0 · 拆书与创作闭环</h2>
          <span className="text-10 px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30">该版新增</span>
          <HelpPopover title="这个版本改了什么" width="22rem">
            {'这个版本把「作品分析 → 创作参考 → 审读 → 章后整理 → 剧情候选」串成一条有记录、可追溯的链：\n\n· 分析产出可以存成成果，标「已排除」的不会被发送；\n· 拆书分清本次范围与全书结论，不拿局部冒充全书；\n· 创作参考只发你勾选的那几张，来源过期就一条都不发；\n· 审读留摘要记录，可在创作轨迹回看；\n· 章后整理与正文保存分开，失败显示「整理待恢复」；\n· 剧情候选可应用 / 放弃 / 追溯来源报告；\n· 图鉴字段的「适用类别」留空会被拦下，不再存成死配置。\n\n边界照实写：未配置模型时相关功能不可用（界面会直说），不会假装完成。'}
          </HelpPopover>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {V360_TIPS.map(tip => (
            <div key={tip.title} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-4 py-3">
              <div className="text-12 font-semibold text-amber/90">{tip.title}</div>
              <div className="text-11 text-ink-300 leading-relaxed mt-1">{tip.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 3.6.1：质量收口（用户可见的三处） */}
      <section className="mb-6 bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <Sparkles size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">3.6.1 · 依据、语义视图与冲突面板</h2>
          <span className="text-10 px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30">该版新增</span>
          <HelpPopover title="这个版本改了什么" width="22rem">
            {'这一版主要是把上一版记下的欠账收口，界面上你能看到三处变化：\n\n· 章后整理的「未来计划待重审」每条可以看依据（改前 → 改后，最多 300 字）；\n· 图鉴详情多了「按语义看」（身份 / 动机 / 状态 + 出处），只读；\n· 同步冲突面板只在真能恢复时给按钮，不能恢复会写清原因。\n\n没有任何数据格式变化，已有项目打开即用。'}
          </HelpPopover>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {V361_TIPS.map(tip => (
            <div key={tip.title} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-4 py-3">
              <div className="text-12 font-semibold text-amber/90">{tip.title}</div>
              <div className="text-11 text-ink-300 leading-relaxed mt-1">{tip.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 3.3.4 · P1：本机运行能力（C4）—— 手册侧消费同一份能力解析，
          与设置页（老板键 / 模型设置）显示的是同一个结论，不各写一版说明。 */}
      <CapabilityPanel />

      {/* 使用建议 */}
      <section className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
          <Lightbulb size={14} className="text-amber" />
          <h2 className="text-13 font-semibold text-ink-100">核心创作方法论</h2>
          <HelpPopover title="核心创作方法论" width="21rem">
            {'12 条从网文实战里提炼的规则，对应软件里的具体动作：\n\n· 开书前：先定位 → 再总纲 → 再世界观三层填法；\n· 连载中：随写随登记（新设定当天回表）、每章结尾留钩子、伏笔写清前置条件；\n· 改设定：必须先过「设定变更」，冲突未处理前不要发布后续章节。\n\n卡文时优先翻「灵感素材」而不是硬编。'}
          </HelpPopover>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
          {TIPS.map(tip => (
            <div key={tip.title} className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-4 py-3">
              <div className="text-12 font-semibold text-amber/90">{tip.title}</div>
              <div className="text-11 text-ink-300 leading-relaxed mt-1">{tip.body}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
