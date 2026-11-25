/**
 * 示范项目《吞天神脉》人物小传预置纯数据（3.7.1 · W4）
 *
 * 🔴 纯字面量数据（禁止运行时 import 业务模块），供 `charBiographySeed.ts` 装配落库。
 */
export interface SeedBioNodeLiteral {
  phase: 'prequel' | 'story'
  chapterNo: number
  order: number
  storyTime?: string
  title: string
  summary: string
  tag: '前传背景' | '成长突破' | '关系转折' | '高光时刻' | '重大失去' | '身份变化' | '其他'
  evidence?: string
}

export interface SeedBioEntryLiteral {
  name: string
  lastScannedChapterNo: number
  prose: string
  nodes: SeedBioNodeLiteral[]
}

export const DEMO_CHAR_BIOGRAPHIES: SeedBioEntryLiteral[] = [
  {
    name: '陈渊',
    lastScannedChapterNo: 20,
    prose: [
      '云州陈家遗孤。七岁那年腊月初一，陈家遭遇血洗，陈渊左腕暗金胎记失控漏出一道冲天金光，被老瞎子救下后携幼妹陈瑶逃至青岚山，隐姓埋名蛰伏在杂役院。',
      '十六岁测灵大典被判「废脉」，当夜识海中锈迹斑斑的青铜小塔苏醒，由此踏上「以吞为道」的混沌神体修行路。卷一于外门大比击败柳风夺魁、藏经阁拾得第一道无名残简，又在南荒秘境粉碎萧景行借刀杀人之局、夺得第二道残简。',
      '卷二再入南荒，结识洛家嫡女洛清欢并拆毁血魔教九层收割台，吞煞连破至聚灵九重，硬撼血魔教护法枯血并夺其三成本命血。归宗执法堂与萧景行当堂对质后，于后山得掌门青玄子授墨玉牌并背走「不可开」断碑；北上中州望剑城外立碑，解封镇界塔第三层，重新唤醒三千年万剑冢十万剑鸣。',
    ].join('\n\n'),
    nodes: [
      {
        phase: 'prequel', chapterNo: 0, order: 0, storyTime: '灵历3014年腊月初一',
        title: '云州陈家灭门夜·暗金胎记初现',
        summary: '陈家遭灭门，七岁的陈渊左腕胎记爆发冲天金光，惊动青岚后山半碑；老瞎子将其与陈瑶救走安置于杂役院。',
        tag: '重大失去',
      },
      {
        phase: 'story', chapterNo: 1, order: 0, storyTime: '灵历3024年三月',
        title: '测灵判废脉，青铜塔灵苏醒',
        summary: '测灵大典被定为废脉受尽嘲弄，当夜左腕胎记发烫，镇界塔灵苏醒点破混沌神体真相。',
        tag: '成长突破',
        evidence: '识海中传来苍老声音：「三千年了……终于等到你。」',
      },
      {
        phase: 'story', chapterNo: 5, order: 0, storyTime: '灵历3024年六月',
        title: '杂役逆袭外门大比夺魁',
        summary: '徒手接住外门第一人柳风剑气并反掌夺魁，当夜借剑气破境聚灵一重。',
        tag: '高光时刻',
      },
      {
        phase: 'story', chapterNo: 10, order: 0, storyTime: '灵历3024年八月',
        title: '南荒反杀夺第二道残简',
        summary: '识破并逆转顾长风与血魔教杀局，取得「吞灵」残简破聚灵二重，携血河铜牌归宗。',
        tag: '成长突破',
      },
      {
        phase: 'story', chapterNo: 14, order: 0, storyTime: '灵历3024年冬',
        title: '拆毁收割台，连破聚灵九重',
        summary: '鲸吞盆地十里血煞连破数重，斩断枯血脊骨拐杖并抽取其三成本命血。',
        tag: '高光时刻',
      },
      {
        phase: 'story', chapterNo: 20, order: 0, storyTime: '灵历3025年二月',
        title: '万剑冢立碑，解封镇界塔第三层',
        summary: '于望剑城外立「不可开」断碑唤醒十万剑鸣，吞尽血鸦骨铃，初闻「你是那把锁」。',
        tag: '身份变化',
      },
    ],
  },
  {
    name: '洛清欢',
    lastScannedChapterNo: 20,
    prose: [
      '中州守冢世家洛家嫡女，自幼受家族家法束缚，被当作中州格局里的联姻筹码，练就一身清冷克制的「听雪」剑意。',
      '卷二南荒塌陷石谷遭血魔教三名护法围攻时为陈渊所救，二人携手拆毁九层收割台。她看清所谓「守门」背后的血腥真相，遂决意「不守冢、去撬门」，与陈渊定下中州万剑冢之约。归家后当众表态拒守家法，被家主收剑禁足四个月，却仍暗中挣脱约束纵马北上。',
    ].join('\n\n'),
    nodes: [
      {
        phase: 'prequel', chapterNo: 0, order: 0, storyTime: '入南荒前',
        title: '拒认洛家联姻棋子之命',
        summary: '目睹家族以旁支子弟换取资源，立誓掌握自己手中之剑、绝不沦为联姻筹码。',
        tag: '前传背景',
      },
      {
        phase: 'story', chapterNo: 12, order: 0, storyTime: '灵历3024年冬',
        title: '石谷受困遇陈渊',
        summary: '肩中毒矢仍孤身断后，被陈渊救下后互换情报，二人合力直奔血魔教收割台。',
        tag: '关系转折',
      },
      {
        phase: 'story', chapterNo: 15, order: 0,
        title: '一剑碎阵眼，定万剑冢之约',
        summary: '以听雪寒气助陈渊保住左臂，决定不守死门并相约明年春天中州万剑冢相见。',
        tag: '关系转折',
      },
      {
        phase: 'story', chapterNo: 19, order: 0, storyTime: '灵历3024年十一月',
        title: '归家抗命遭收剑禁足',
        summary: '带伤回望剑城公开宣告不再替洛家守门，被家主收剑禁足四个月。',
        tag: '身份变化',
      },
    ],
  },
  {
    name: '萧景行',
    lastScannedChapterNo: 20,
    prose: [
      '中州萧家旁支庶出，少年时曾被嫡兄夺走机缘，养成外温润而内阴鸷的心性。入青岚宗成为内门大师兄后，一直视宗门与同辈为踏脚石，暗中勾连血魔教，企图借「第九脉」破境图谋更大野心。',
      '开篇测灵大典后察觉陈渊异样，先设局外门赌盘、再派墨玉令杀手雨夜行刺；南荒试炼中借试炼令安插顾长风与血魔教暗桩，却屡被陈渊反制。第16章执法堂堂审反咬一口未果，彻底撕破假面成为陈渊中期宿敌。',
    ].join('\n\n'),
    nodes: [
      {
        phase: 'prequel', chapterNo: 0, order: 0,
        title: '萧家庶出遭嫡兄夺缘',
        summary: '早年机缘被嫡兄强夺，从此不信宗族亲情，笃信唯靠算计与实力方能立身。',
        tag: '前传背景',
      },
      {
        phase: 'story', chapterNo: 4, order: 0,
        title: '雨夜截杀失败，墨玉令泄密',
        summary: '暗派聚灵杀手刺杀陈渊反被吞掉半身修为，怀中墨玉令落入陈渊之手。',
        tag: '关系转折',
      },
      {
        phase: 'story', chapterNo: 16, order: 0,
        title: '执法堂对质彻底决裂',
        summary: '被呈上血河铜牌与玉令后强硬甩锅顾长风并试探天上之局，与陈渊正式撕破脸。',
        tag: '关系转折',
      },
    ],
  },
  {
    name: '青玄子',
    lastScannedChapterNo: 20,
    prose: '青岚宗当代掌门，三百年前守碑弟子青尘之徒。三百年前亲眼目睹老瞎子牵瘦驴借走镇界塔，从此独守后山三百年，等待「还塔之人」。十年前陈家灭门夜那道冲天金光令其识海半碑裂开三日，直至第17章方在后山正式将宗门墨玉牌与断碑一并托付给陈渊。',
    nodes: [
      {
        phase: 'prequel', chapterNo: 0, order: 0, storyTime: '三百年前',
        title: '承师命守塔三百年',
        summary: '师父青尘将镇界塔借予老瞎子后病故，青玄子接任掌门独守后山等待还塔与破局之人。',
        tag: '前传背景',
      },
      {
        phase: 'story', chapterNo: 17, order: 0, storyTime: '灵历3024年冬',
        title: '后山传信授牌，托付断碑',
        summary: '向陈渊和盘托出借塔旧账与十年前金光异象，授墨玉牌赐其以青岚使者身份入中州。',
        tag: '身份变化',
      },
    ],
  },
  {
    name: '柳风',
    lastScannedChapterNo: 20,
    prose: '青岚宗外门寒门弟子，连续三年止步外门四强，好胜却磊落。外门大比败给陈渊后坦然认输，随后在南荒前夜赠护身玉符示警、谷口与陈渊并肩截杀血魔教暗桩，逐渐从对手转为可信赖的同门。',
    nodes: [
      {
        phase: 'story', chapterNo: 5, order: 0,
        title: '外门大比惜败陈渊',
        summary: '青锋剑气被陈渊徒手夺下后干脆认输，不屑暗算，成为陈渊初入宗门首个堂堂正正的对手。',
        tag: '关系转折',
      },
      {
        phase: 'story', chapterNo: 9, order: 0,
        title: '赠符示警，南荒谷口并肩破暗桩',
        summary: '暗中示警萧景行不怀好意，并在秘境谷口截杀两名血魔教暗桩协助陈渊搜出实证。',
        tag: '高光时刻',
      },
    ],
  },
  {
    name: '顾长风',
    lastScannedChapterNo: 20,
    prose: '内门寒门弟子，投靠萧景行成为其明面打手。第8章借试炼令随队入南荒欲除陈渊兼吞残简，结果第10章反被陈渊吞掉半截修为制服，第14章又被当众逼出供词，归宗后失势沦为弃子。',
    nodes: [
      {
        phase: 'story', chapterNo: 10, order: 0,
        title: '秘境偷袭反被制伏供出主使',
        summary: '南荒秘境内撕破脸偷袭王铁柱，被陈渊反吞修为生擒，彻底暴露萧景行借刀杀人阴谋。',
        tag: '重大失去',
      },
    ],
  },
]
