/**
 * 随机取名生成器（参考橙瓜码字 / 大神码字「随机取名」）
 * 支持 8 种类型（人名/门派/功法/地名/法宝/技能/组织/怪物）
 * 人名支持 16 种题材风格：仙侠/古风/现代/西幻/都市/科幻/军事/历史/悬疑/言情/奇幻/蒸汽朋克/末日/竞技/二次元/架空
 */

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// =================== 人名姓氏 ===================
// 东方单字姓（现代/都市/军事/历史/悬疑/末日/科幻等现实向风格使用）
const SURNAMES_CN = [
  '陈', '林', '萧', '叶', '楚', '沈', '顾', '苏', '洛', '云', '秦', '宋', '陆', '江', '何', '柳', '白', '谢', '唐', '温',
  '容', '傅', '卫', '韩', '杨', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '罗', '高', '黄', '梁', '邓', '阎', '程',
]
// 东方复姓（仅仙侠/古风/架空/言情等古风向风格使用，避免出现"慕容+现代名"的违和组合）
const SURNAMES_COMPOUND = [
  '慕容', '司马', '上官', '欧阳', '南宫', '东方', '独孤', '轩辕', '纳兰', '长孙', '皇甫', '令狐', '尉迟', '宇文', '公孙', '诸葛', '夏侯', '赫连',
]
// 古风向可用姓 = 单字姓 + 复姓
const SURNAMES_CN_ALL = [...SURNAMES_CN, ...SURNAMES_COMPOUND]

// 西幻姓
const SURNAMES_XI = [
  '艾尔德里奇', '布莱克伍德', '克劳福德', '德拉克罗瓦', '埃斯特雷', '费尔南德斯', '格雷厄姆', '霍华德',
  '伊格莱西亚斯', '约翰逊', '肯尼迪', '林德伯格', '蒙特罗斯', '诺瓦克', '奥布莱恩', '佩特罗夫', '奎因',
  '雷诺兹', '斯特恩', '汤普森', '厄普顿', '万斯', '沃辛顿', '泽维尔', '亚伯拉罕', '巴恩斯', '科尔宾',
]

// 日本姓（二次元专用）
const SURNAMES_JP = [
  '佐藤', '铃木', '高桥', '田中', '渡边', '伊藤', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐佐木', '山口',
  '松本', '井上', '木村', '林', '清水', '山崎', '森', '阿部', '池田', '石川', '桥本', '山下', '中岛', '藤田',
  '如月', '镜音', '巡音', '水濑', '四条', '秋月', '萩原', '绫濑', '筱原', '结城', '樱井', '东云', '白咲', '星野',
]

// =================== 人名 Given 库（按风格） ===================

// 仙侠
const GIVEN_XIANXIA = ['渊', '尘', '玄', '清', '寒', '冥', '霄', '鸿', '真', '阳', '虚', '尘子', '无涯', '青云', '紫霞', '若虚', '望舒', '凌霄', '惊鸿', '皓宇', '星河', '太一', '忘尘', '渡劫', '归元']
// 古风/架空
const GIVEN_GUFENG = ['砚', '卿', '辞', '晏', '黎', '苏', '莞', '衿', '珩', '翎', '惊蛰', '锦书', '怀瑾', '枕月', '折柳', '拂衣', '阑珊', '未央', '声声', '南絮', '青梧', '知晚', '听雪', '沉璧', '疏影']
// 现代
const GIVEN_MODERN = ['子轩', '雨桐', '浩然', '欣怡', '俊杰', '思远', '可欣', '一鸣', '梓涵', '睿', '婷', '嘉禾', '晨曦', '若楠', '正阳', '小满', '安然', '之恒', '乐瑶', '承宇']
// 西幻
const GIVEN_XIHUAN = ['艾莉丝', '莱昂', '塞西莉亚', '加雷斯', '薇拉', '罗兰', '伊莎贝拉', '德里克', '菲奥娜', '阿尔文', '格温', '露西亚', '埃德蒙', '薇薇安', '奥兰多', '梅莉丝', '雷欧尼斯', '泰瑞莎', '艾瑞克', '奥利维亚']
// 都市
const GIVEN_DUSHI = ['逸凡', '安然', '思琪', '宇轩', '若曦', '佳豪', '梓萱', '凯', '欣妍', '梓豪', '心怡', '泽', '亦凡', '可馨', '博文', '嘉怡', '俊杰', '佳怡', '子墨', '晚晴']
// 科幻
const GIVEN_KEHUAN = ['卡', '琳', '凯', '艾', '泽', '宇', '岚', '海', '诺', '璇', '曦', '珩', '睿', '铮', '骁', '曜', '翀', '宇航', '明远', '知行']
// 军事
const GIVEN_JUNSHI = ['卫国', '国梁', '建国', '振华', '少华', '建斌', '少杰', '晓斌', '永胜', '国强', '海鹏', '远征', '一鸣', '海强', '晓鹏', '卫东', '刚', '锐', '峰', '宁']
// 历史
const GIVEN_LISHI = ['伯仁', '子敬', '玄德', '仲谋', '云长', '翼德', '元让', '文若', '奉孝', '仲达', '子元', '文和', '安国', '怀英', '德武', '辅之', '景元', '伯约', '季舒', '公瑾']
// 悬疑
const GIVEN_XUANYI = ['离', '澈', '寒', '墨', '渊', '冷', '夜', '隐', '谜', '噬', '青', '蛇', '鸦', '影', '罗', '刹', '瞳', '梦', '咒', '烬']
// 言情
const GIVEN_YANQING = ['若晴', '暖暖', '安安', '糖糖', '念念', '思思', '慕橙', '柒柒', '南笙', '北城', '初晴', '知夏', '予曦', '霁川', '砚秋', '清漪', '婉清', '若颜', '可昕', '绾绾']
// 奇幻
const GIVEN_QIHUAN = ['赛勒涅', '凯尔萨斯', '索拉丁', '伊利丹', '阿尔萨斯', '吉安娜', '希尔瓦娜斯', '瓦里安', '萨尔', '萨尔加斯', '莱恩', '麦迪文', '卡德加', '图拉扬', '艾泽拉', '艾露恩', '玛法里奥', '泰兰德', '珊蒂斯', '艾萨拉']
// 蒸汽朋克
const GIVEN_STEAMPUNK = ['维克多', '阿瑟', '伊莎贝拉', '塞巴斯蒂安', '奥古斯塔', '赫克托', '阿洛伊修斯', '埃德温娜', '莱昂内尔', '玛格丽特', '沃尔特', '比阿特丽斯', '康拉德', '尤金妮娅', '菲利克斯']
// 末日
const GIVEN_MORI = ['岩', '洛', '燃', '砚', '骁', '凛', '拓', '猎', '荒', '墟', '曜', '刃', '渡', '渊', '灭', '棘', '烬', '莽', '铮', '铁']
// 竞技/电竞
const GIVEN_JINGJI = ['One', 'Zero', 'Ace', 'Blaze', 'Kite', 'Rex', 'Echo', 'Frost', 'Kael', 'Riven', 'Zephyr', 'Onyx', 'Vex', 'Lyric', 'Pixel', 'Quill', 'Halo', 'Sable', 'Vibe', 'Rift']
// 二次元（纯日式名，不含完整姓名，避免与姓氏拼接后出现"如月千早X"式的怪名）
const GIVEN_JP = ['千早', '雪步', '律子', '伊织', '真美', '亚美', '美希', '春香', '音也', '澪', '奏', '初音', '未来', '凛', '花音', '雏田', '希美', '绘里', '穗乃果', '香织', '渚', '雫', '栞', '汐', '葵', '菫', '小鸟', '空', '光', '翼']
// 架空（中式）
const GIVEN_JIAKONG = ['长卿', '子期', '明琰', '昭宁', '怀瑾', '君辞', '砚之', '霁川', '元朗', '怀珩', '承衍', '景渊', '砚白', '清辞', '知许', '怀澈', '砚秋', '明珩', '亦珩', '观澜']

// =================== 人名生成（按风格分发） ===================
// 古风向风格：可用复姓；现实向风格：仅单字姓；域外风格：固定用对应文化的姓+名
const ANCIENT_STYLES = ['仙侠', '古风', '架空', '言情']

function pickGiven(style: string): string {
  switch (style) {
    case '仙侠': return pick(GIVEN_XIANXIA)
    case '古风': return pick(GIVEN_GUFENG)
    case '现代': return pick(GIVEN_MODERN)
    case '都市': return pick(GIVEN_DUSHI)
    case '科幻': return pick(GIVEN_KEHUAN)
    case '军事': return pick(GIVEN_JUNSHI)
    case '历史': return pick(GIVEN_LISHI)
    case '悬疑': return pick(GIVEN_XUANYI)
    case '言情': return pick(GIVEN_YANQING)
    case '末日': return pick(GIVEN_MORI)
    case '二次元': return pick(GIVEN_JP)
    case '架空': return pick(GIVEN_JIAKONG)
    default: return pick(GIVEN_XIANXIA)
  }
}

export function genPersonName(style: string): string {
  switch (style) {
    // 西幻：双段式 "姓·名"
    case '西幻':
      return pick(SURNAMES_XI) + '·' + pick(GIVEN_XIHUAN)
    // 奇幻：库内均为完整音译名，直接使用或拼"名·姓"
    case '奇幻':
      return Math.random() < 0.6 ? pick(GIVEN_QIHUAN) : pick(GIVEN_QIHUAN) + '·' + pick(SURNAMES_XI)
    // 蒸汽朋克：英伦风 "名·姓"
    case '蒸汽朋克':
      return pick(GIVEN_STEAMPUNK) + '·' + pick(SURNAMES_XI)
    // 二次元：日式姓 + 日式名（严格同文化，杜绝"慕容千早"式混搭）
    case '二次元':
      return pick(SURNAMES_JP) + pick(GIVEN_JP)
    // 竞技：直接给 ID 风格
    case '竞技':
      return pick(GIVEN_JINGJI) + pick(['_' + Math.floor(Math.random() * 99), '', '_X', '.K', ''])
    // 科幻：中式姓名（姓+单/双字名）
    case '科幻':
      return pick(SURNAMES_CN) + pick(GIVEN_KEHUAN)
    // 仙侠/古风/架空/言情：单字姓+复姓混用；其余现实向：仅单字姓
    default:
      return pick(ANCIENT_STYLES.includes(style) ? SURNAMES_CN_ALL : SURNAMES_CN) + pickGiven(style)
  }
}

// =================== 门派/组织 ===================
// 仙侠/古风门派
const SECT_PREFIX_XIANXIA = ['青云', '玄天', '太虚', '紫霄', '凌霄', '苍澜', '万剑', '天机', '幽冥', '焚天', '御兽', '丹霞', '星辰', '无极', '九幽', '流云', '镇岳', '听涛']
const SECT_SUFFIX_XIANXIA = ['宗', '门', '阁', '殿', '山庄', '剑派', '道统', '圣地', '学院', '盟']
// 都市公司
const SECT_PREFIX_DUSHI = ['星河', '万象', '鸿鹄', '凌云', '锐途', '先锋', '凯旋', '腾瑞', '新势力', '云海', '蓝海', '潮汐', '极光', '追光', '荣耀', '铁狮', '雄狮', '银河']
const SECT_SUFFIX_DUSHI = ['集团', '科技', '资本', '实业', '传媒', '工作室', '事务所', '联盟', '中心', '商行']
// 科幻组织
const SECT_PREFIX_KEHUAN = ['星环', '深空', '黎明', '曙光', '方舟', '普罗米修斯', '盖亚', '天枢', '量子', '星际', '银河', '深蓝', '苍穹', '苍穹之眼', '泰坦', '赫利俄斯', '新伊甸']
const SECT_SUFFIX_KEHUAN = ['舰队', '联盟', '议会', '总署', '局', '公司', '集团', '站', '殖民团', '卫队']
// 西幻组织
const SECT_PREFIX_XIHUAN = ['圣光', '暗影', '银月', '黑铁', '荆棘', '烈焰', '寒霜', '翡翠', '黄金', '白银', '紫水晶', '红龙', '苍鹰', '狮心', '双刃', '破晓', '黄昏']
const SECT_SUFFIX_XIHUAN = ['骑士团', '兄弟会', '圣殿', '议会', '商会', '佣兵团', '教团', '守护者', '审判庭', '远征军']

export function genSectName(style = '仙侠'): string {
  switch (style) {
    case '都市': return pick(SECT_PREFIX_DUSHI) + pick(SECT_SUFFIX_DUSHI)
    case '科幻': return pick(SECT_PREFIX_KEHUAN) + pick(SECT_SUFFIX_KEHUAN)
    case '西幻':
    case '奇幻': return pick(SECT_PREFIX_XIHUAN) + pick(SECT_SUFFIX_XIHUAN)
    case '军事': return pick(['战狼', '雄鹰', '铁血', '利剑', '暗夜', '黎明', '雷霆', '猎隼', '潜龙', '玄武']) + pick(['特种大队', '特战队', '突击队', '侦察营', '指挥部', '司令部'])
    case '末日': return pick(['废土', '荒原', '遗民', '残阳', '铁穹', '灰烬', '破晓', '曙光']) + pick(['避难所', '聚落', '据点', '前哨', '联盟', '议会', '商队', '民兵'])
    default: return pick(SECT_PREFIX_XIANXIA) + pick(SECT_SUFFIX_XIANXIA)
  }
}

// =================== 功法/技能 ===================
const SKILL_PREFIX_XIANXIA = ['御剑', '焚天', '玄冥', '九转', '太上', '紫微', '周天', '星辰', '无量', '噬魂', '金刚', '清心', '天罡', '碎虚', '归一', '苍龙']
const SKILL_SUFFIX_XIANXIA = ['诀', '神功', '心法', '真经', '剑典', '秘术', '大法', '图录', '篇', '术']
const SKILL_PREFIX_KEHUAN = ['量子', '时空', '维度', '引力', '反物质', '暗能量', '曲速', '光棱', '电磁', '高频', '粒子', '次声', '等离子', '光能', '热能']
const SKILL_SUFFIX_KEHUAN = ['飞弹', '炮', '护盾', '立场', '场', '矩阵', '波', '反应堆', '引擎', '核心']
const SKILL_PREFIX_JUNSHI = ['霹雳', '雷霆', '猎鹰', '暗夜', '潜龙', '铁拳', '尖兵', '铁血', '疾风', '破甲']
const SKILL_SUFFIX_JUNSHI = ['战术', '战法', '行动', '演习', '方案', '部署', '编队', '突击']
const SKILL_PREFIX_XUANYI = ['夜枭', '影刃', '暗影', '深瞳', '碎影', '残像', '幽冥', '噬魂', '断罪', '寂灭']
const SKILL_SUFFIX_XUANYI = ['七式', '九斩', '十三刺', '百解', '杀招', '禁术', '绝技', '残卷']
const SKILL_PREFIX_DUSHI = ['博弈', '运筹', '商战', '翻云', '覆雨', '纵横', '破局', '逆袭', '点金', '腾挪']
const SKILL_SUFFIX_DUSHI = ['三十六计', '心法', '手札', '商道', '博弈论', '实战录']

export function genSkillName(style = '仙侠'): string {
  switch (style) {
    case '科幻': return pick(SKILL_PREFIX_KEHUAN) + pick(SKILL_SUFFIX_KEHUAN)
    case '军事': return pick(SKILL_PREFIX_JUNSHI) + pick(SKILL_SUFFIX_JUNSHI)
    case '悬疑': return pick(SKILL_PREFIX_XUANYI) + pick(SKILL_SUFFIX_XUANYI)
    case '都市': return pick(SKILL_PREFIX_DUSHI) + pick(SKILL_SUFFIX_DUSHI)
    case '竞技': return pick(['幻影', '雷霆', '破晓', '黑夜行者', '风暴之眼', '极限', '狂澜', '疾风', '疾雷', '破甲']) + pick(['斩', '击', '冲拳', '冲击', '闪光', '轰鸣'])
    default: return pick(SKILL_PREFIX_XIANXIA) + pick(SKILL_SUFFIX_XIANXIA)
  }
}

// =================== 地名 ===================
const PLACE_PREFIX_XIANXIA = ['落霞', '青岚', '赤炎', '寒渊', '幽篁', '断魂', '万妖', '焚天', '听雨', '沧澜', '白帝', '孤鸿', '流沙', '陨星', '昆仑', '蓬莱']
const PLACE_SUFFIX_XIANXIA = ['城', '谷', '山', '泽', '林', '渊', '原', '关', '岛', '秘境', '禁地', '湖']
const PLACE_PREFIX_DUSHI = ['朝阳', '滨江', '海珠', '福田', '南山', '浦东', '静安', '海淀', '江北', '光谷', '高新', '经开', '临港', '前海', '西部', '北部']
const PLACE_SUFFIX_DUSHI = ['新区', 'CBD', '科技园', '商务区', '产业园', '新城', '街道', '商圈']
const PLACE_PREFIX_KEHUAN = ['天狼', '半人马', '猎户', '仙女', '武仙', '飞马', '天龙', '北极', '开普勒', '比邻', '鲸鱼', '创生', '波江', '麦哲伦']
const PLACE_SUFFIX_KEHUAN = ['星系', '星云', '空间站', '殖民地', '基地', '中转站', '前哨', '轨道城']
const PLACE_PREFIX_XIHUAN = ['银月', '烈焰', '寒霜', '翡翠', '黄金', '暮光', '黎明', '黑铁', '紫晶', '龙脊']
const PLACE_SUFFIX_XIHUAN = ['堡', '城', '王国', '公国', '领', '郡', '要塞', '港', '塔']

export function genPlaceName(style = '仙侠'): string {
  switch (style) {
    case '都市': return pick(PLACE_PREFIX_DUSHI) + pick(PLACE_SUFFIX_DUSHI)
    case '科幻': return pick(PLACE_PREFIX_KEHUAN) + pick(PLACE_SUFFIX_KEHUAN)
    case '西幻':
    case '奇幻': return pick(PLACE_PREFIX_XIHUAN) + pick(PLACE_SUFFIX_XIHUAN)
    case '军事': return pick(['北疆', '南境', '东线', '西陲', '铁马', '黑水', '苍狼', '烈风']) + pick(['要塞', '前哨', '防线', '基地', '哨所', '阵地'])
    case '末日': return pick(['废土', '灰烬', '残阳', '锈带', '黑潮', '死寂', '破碎']) + pick(['地带', '区域', '荒原', '废墟', '隔离区', '死城'])
    case '历史': return pick(['长安', '洛阳', '汴京', '金陵', '临安', '大都', '建康', '邺城', '邯郸', '咸阳']) + pick(['府', '城', '县', '郡', '关', '渡'])
    default: return pick(PLACE_PREFIX_XIANXIA) + pick(PLACE_SUFFIX_XIANXIA)
  }
}

// =================== 法宝/物品 ===================
const ITEM_PREFIX_XIANXIA = ['诛仙', '焚寂', '镇魂', '混元', '九幽', '天问', '噬灵', '破军', '绕指', '山河', '日月', '星辰']
const ITEM_SUFFIX_XIANXIA = ['剑', '刀', '钟', '镜', '鼎', '塔', '印', '珠', '琴', '幡', '甲', '梭']
const ITEM_PREFIX_KEHUAN = ['深空', '破晓', '量子', '光棱', '苍穹', '天枢', '黎明', '星火', '极光', '暗影']
const ITEM_SUFFIX_KEHUAN = ['之刃', '核心', '护盾', '协议', '引擎', '光剑', '发生器', '矩阵', '终端', '驱动器']
const ITEM_PREFIX_XIHUAN = ['圣光', '暗影', '龙息', '狮心', '鹰眼', '霜寒', '烈焰', '破晓', '银月', '紫晶']
const ITEM_SUFFIX_XIHUAN = ['长剑', '重剑', '法杖', '盾牌', '战甲', '头盔', '披风', '指环', '项链', '弓']
const ITEM_PREFIX_DUSHI = ['黑卡', '御风', '星耀', '尊享', '量子', '极光', '云端', '凌霄']
const ITEM_SUFFIX_DUSHI = ['座驾', '腕表', '套装', '手札', '酒', '雪茄', '典藏版']

export function genItemName(style = '仙侠'): string {
  switch (style) {
    case '科幻': return pick(ITEM_PREFIX_KEHUAN) + pick(ITEM_SUFFIX_KEHUAN)
    case '西幻':
    case '奇幻': return pick(ITEM_PREFIX_XIHUAN) + pick(ITEM_SUFFIX_XIHUAN)
    case '都市': return pick(ITEM_PREFIX_DUSHI) + pick(ITEM_SUFFIX_DUSHI)
    case '悬疑': return pick(['血色', '暗夜', '失踪的', '沉默的', '半页', '永夜', '尘封的']) + pick(['日记', '信', '磁带', '照片', '档案', '手稿'])
    case '末日': return pick(['铁锈', '废土', '遗民', '残阳', '灰烬', '破晓']) + pick(['扳手', '改装枪', '滤毒罐', '信号器', '弹药包', '口粮'])
    case '军事': return pick(['铁鹰', '猎隼', '雷霆', '霹雳', '暗夜', '潜龙']) + pick(['突击步枪', '狙击镜', '匕首', '战术背心', '通讯器', '夜视仪'])
    default: return pick(ITEM_PREFIX_XIANXIA) + pick(ITEM_SUFFIX_XIANXIA)
  }
}

// =================== 怪物/生物（敌人/反派/异兽） ===================
const MONSTER_PREFIX = ['噬', '玄', '幽', '冥', '九幽', '天', '苍', '玄冥', '紫', '炼狱', '荒', '梦魇', '血', '死', '黑']
const MONSTER_INFIX = ['渊', '渊魔', '蟒', '蛟', '虎', '熊', '凰', '凤', '麒麟', '犼', '貔貅', '饕餮', '穷奇', '梼杌', '毕方', '朱厌']
const MONSTER_SUFFIX = ['兽', '蛟', '龙', '蟒', '凤', '凰', '鹰', '狼', '麒麟', '犼', '魔', '魅', '妖', '鬼', '夜叉', '修罗']
const MONSTER_XI = ['深渊', '虚空', '影界', '灰烬', '暮光', '黑曜', '裂空', '霜寒', '黑焰', '噬魂']
const MONSTER_XI_SUFFIX = ['巨龙', '巨魔', '骨龙', '暗影狼', '虚空行者', '深渊领主', '诅咒骑士', '邪灵', '骸骨王', '星界魔']

function genMonsterName(style = '仙侠'): string {
  if (style === '西幻' || style === '奇幻') {
    return pick(MONSTER_XI) + pick(MONSTER_XI_SUFFIX)
  }
  if (style === '科幻') {
    return pick(['异形', '深空', '虚空', '异种', '基因']) + pick(['猎手', '变异体', '异虫', '感染者', '异化兽'])
  }
  if (style === '末日') {
    return pick(['锈蚀', '残骸', '感染', '异变']) + pick(['体', '兽', '者', '巨兽', '者'])
  }
  if (style === '都市') {
    return pick(['暗网', '黑市', '幽灵', '雨夜']) + pick(['杀手', '黑客', '掮客', '庄家', '幽灵'])
  }
  return pick(MONSTER_PREFIX) + pick(MONSTER_INFIX) + pick(MONSTER_SUFFIX)
}

// =================== 总入口 ===================
export type NameType = '人名' | '门派' | '功法' | '地名' | '法宝' | '技能' | '组织' | '怪物'

export function genName(type: NameType, style = '仙侠'): string {
  switch (type) {
    case '门派': return genSectName(style)
    case '组织': return genSectName(style)
    case '功法': return genSkillName(style)
    case '技能': return genSkillName(style)
    case '地名': return genPlaceName(style)
    case '法宝': return genItemName(style)
    case '怪物': return genMonsterName(style)
    case '人名':
    default: return genPersonName(style)
  }
}

// 题材列表（供 UI 渲染）
export const STYLES = [
  '仙侠', '古风', '现代', '西幻', '都市', '科幻', '军事', '历史',
  '悬疑', '言情', '奇幻', '蒸汽朋克', '末日', '竞技', '二次元', '架空',
]
