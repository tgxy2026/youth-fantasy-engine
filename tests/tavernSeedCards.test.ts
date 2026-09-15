// ============ 酒馆模式 · 示范角色卡（楚楠 / 洛汐 / 苏念 / 云婉 / 琚瑶 / 琚琪）============
//
// 这批卡来自老大 2026-09-15 用《角色卡批量填写模板》录入的「奉阳大学」世界观
// （A 共享世界观 + B 角色表；苏念不走模板，是在旧卡基础上按新关系做的细微调整）。
// 所以最要紧的断言不是「结构对不对」，而是这两条：
//   ① **他在模板里填过的每一格，都要在卡里找得到**（漏一格就等于没写）；
//   ② 未成年角色（洛汐 / 琚瑶 / 琚琪）与兄妹线不许松动 —— 这两条是写卡时的硬约束。
import {
  SEED_FREE_CHARACTERS, seedFreeChars, upgradeSeedCards, cardSig,
  LEGACY_SEED_EXAMPLES, LEGACY_SEED_CARD_SIGS,
  isSeedCardName, isSeedCard, findSeedFor, resetCardToSeed,
} from '../src/lib/tavern/seedCards'
import { toCardFile } from '../src/lib/tavern/cardFile'
import { renderFreeCharacter, buildFreeSystem } from '../src/lib/tavern/engine'
import { PROTOCOL_CORE } from '../src/lib/tavern/protocol'
import * as store from '../src/lib/tavern/store'
import { createDemoProject } from '../src/lib/seedData'
import { __resetMockStores } from './mock-memory'
import type { FreeCharacter } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type SeedCard = Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'>

/** 把一张卡的全文拼起来，便于做「内容有没有丢」的全量检索 */
function allText(c: SeedCard): string {
  return [
    c.name, c.world,
    ...Object.values(c.profile),
    ...Object.values(c.conduct),
    c.examples,
  ].join('\n')
}

function find(name: string): SeedCard {
  const c = SEED_FREE_CHARACTERS.find(x => x.name === name)
  if (!c) throw new Error(`示范卡里没有「${name}」`)
  return c
}

/** 逐格对账：返回值＝没落地的格子 */
function missing(c: SeedCard, cells: [string, string][]): string[] {
  const t = allText(c)
  return cells.filter(([, s]) => !t.includes(s)).map(([k, s]) => `${k}:${s}`)
}

async function main() {
  // ---------- 1) 结构完整性 ----------
  {
    ok('示范卡共六张', SEED_FREE_CHARACTERS.length === 6, `实际=${SEED_FREE_CHARACTERS.length}`)
    ok('名单与顺序：楚楠 / 洛汐 / 苏念 / 云婉 / 琚瑶 / 琚琪',
      SEED_FREE_CHARACTERS.map(c => c.name).join(',') === '楚楠,洛汐,苏念,云婉,琚瑶,琚琪',
      SEED_FREE_CHARACTERS.map(c => c.name).join(','))

    for (const c of SEED_FREE_CHARACTERS) {
      const t = allText(c)
      const lack: string[] = []
      if (!c.name.trim()) lack.push('name')
      if (!c.world.trim()) lack.push('world')
      for (const [k, v] of Object.entries(c.profile)) if (!String(v).trim()) lack.push(`profile.${k}`)
      for (const [k, v] of Object.entries(c.conduct)) if (!String(v).trim()) lack.push(`conduct.${k}`)
      if (!c.examples.trim()) lack.push('examples')
      ok(`${c.name}：四章无空栏`, lack.length === 0, lack.join('、'))
      // 这批全部是**从模板的骨架扩写**出来的完整卡，门槛按「撑得起来」定
      ok(`${c.name}：字数足够撑起一张卡（>3200）`, t.length > 3200, String(t.length))
    }
  }

  // ---------- 2) 共享世界观：六张卡必须在同一个时空里 ----------
  {
    for (const c of SEED_FREE_CHARACTERS) {
      const t = allText(c)
      ok(`${c.name}：落在「奉阳」（华夏·东北）`, t.includes('奉阳'))
      ok(`${c.name}：故事起点＝2026 年 6 月初`, /2026 年 6 月/.test(t))
    }
    const chu = allText(find('楚楠'))
    ok('世界观第一条规则（超自然力量不受既有规则限制）写进了男主卡',
      chu.includes('不受这套规则管'))
    ok('共享设定「被魅魔附身 → 符合审美的异性会不自觉地被吸引」写在男主卡里',
      chu.includes('魅魔') && chu.includes('不自觉地被他吸引'))
  }

  // ---------- 3) 模板逐格对账（这是本轮最重要的一组） ----------
  {
    const cells: Record<string, [string, string][]> = {
      楚楠: [
        ['性别年龄', '19（大一'],
        ['身份', '奉阳大学金融专业'],
        ['性格·阳光开朗', '阳光开朗'],
        ['性格·面对异性风流', '风流'],
        ['性格·遇难题稳重', '稳重'],
        ['说话风格·小+末字', '小 + 名字最后一个字'],
        ['关系·洛汐是妹妹', '无血缘妹妹'],
        ['关系·云婉学弟兼老板', '学弟'],
        ['绝对不做·不违背约定', '答应过的事就一定要做到'],
        ['绝对不做·不让喜欢的女孩子伤心', '会让喜欢的女孩子伤心'],
        ['不知道·不了解魅魔', '全靠试'],
        ['补充·被附身后改写人生', '他的确定感'],
      ],
      洛汐: [
        ['性别年龄', '17（未成年'],
        ['身份', '第二十中学'],
        ['身份·准高三', '准高三'],
        ['身份·学霸', '年级前十'],
        ['性格·温婉文艺', '温婉'],
        ['性格·古灵精怪', '古灵精怪'],
        ['说话风格·哥哥', '哥哥大人'],
        ['说话风格·笨蛋哥哥', '笨蛋哥哥'],
        ['关系·琚瑶同班', '琚瑶'],
        ['关系·琚琪同班', '琚琪'],
        ['绝对不做·不争风吃醋', '不会去针对任何人'],
        ['补充·分不清亲情还是爱情', '分不清'],
      ],
      苏念: [
        ['性别年龄', '年龄：18'],
        ['关系·高中同学', '高中三年同班'],
        ['关系·大学同学', '大学又考到同一所'],
        ['补充·暗恋不敢开口', '喜欢了三年多'],
        ['补充·只认识楚楠', '不认识楚楠身边的其他人'],
      ],
      云婉: [
        ['性别年龄', '20（大二'],
        ['身份', '法律专业'],
        ['身份·校花级', '校花'],
        ['性格·妖艳魅惑（写成行为）', '尾音带钩'],
        ['性格·高冷开关', '变高冷'],
        ['性格·托付真心时温柔贤淑', '笨手笨脚地照顾人'],
        ['关系·学姐兼秘书', '秘书'],
        ['绝对不做·有主见', '接受别人替她做决定'],
        ['补充·首富彩礼', '彩礼'],
        ['补充·换男友收礼给母亲治病', '给母亲治病'],
      ],
      琚瑶: [
        ['性别年龄', '17（未成年'],
        ['身份', '第二十中学'],
        ['身份·成绩一般', '成绩一直是"差不多"'],
        ['性格·软萌胆小', '声音小，句子短'],
        ['性格·没主见', '先看一眼妹妹'],
        ['关系·琚琪的姐姐', '琚琪（妹妹'],
        ['绝对不做·听妹妹的', '决定基本都是妹妹做的'],
        ['补充·家长请洛汐辅导功课', '上门辅导功课'],
      ],
      琚琪: [
        ['性别年龄', '17（未成年'],
        ['身份', '第二十中学'],
        ['性格·冷面热心', '她的"冷"是壳不是里子'],
        ['说话风格·为维护姐姐冷嘲热讽', '损人不用脏字'],
        ['关系·琚瑶的妹妹', '琚瑶（姐姐'],
        ['绝对不做·无法接受姐姐被欺负', '谁干的'],
        ['补充·家长请洛汐辅导功课', '上门辅导'],
      ],
    }
    for (const [name, list] of Object.entries(cells)) {
      const lost = missing(find(name), list)
      ok(`${name}：模板填过的每一格都在卡里（${list.length} 格抽查）`, lost.length === 0, lost.join(' | '))
    }
  }

  // ---------- 4) 关系网自洽（改动最大的地方，逐一钉住） ----------
  {
    const chu = find('楚楠'), lx = find('洛汐'), sn = find('苏念'), yw = find('云婉'), qy = find('琚瑶'), qq = find('琚琪')
    ok('🔴 苏念只认识楚楠：卡里不再出现「洛汐姐」，也写明不认识其他人',
      !sn.profile.relations.includes('洛汐姐') && sn.profile.relations.includes('不认识楚楠身边的其他人'))
    ok('🔴 洛汐卡里没有苏念（哥哥没往家里带过人）', !allText(lx).includes('苏念'))
    ok('🔴 云婉卡里写明不认识苏念（只有"没打过照面"这一句）', allText(yw).includes('完全没打过照面'))
    ok('苏念喊楚楠「哥哥」有来处（高一坐他后排叫顺了口）', sn.profile.externals.includes('坐在他后排'))
    ok('楚楠不知道苏念喜欢他（写成「他真的没往那边想过」）',
      chu.profile.relations.includes('他不知道她喜欢他'))
    ok('洛汐与楚楠是兄妹，且写明没有血缘', chu.profile.relations.includes('没有一点血缘') && lx.profile.relations.includes('血缘上毫无关系'))
    ok('云婉与楚楠的「学姐兼职员」错位写清楚了',
      yw.profile.relations.includes('她的学弟') && yw.profile.relations.includes('给她发钱的人'))
    ok('琚家姐妹互为姐妹、且都是洛汐的同班同学',
      qy.profile.relations.includes('琚琪（妹妹') && qq.profile.relations.includes('琚瑶（姐姐') &&
      qy.profile.relations.includes('洛汐（同班同学') && qq.profile.relations.includes('洛汐（同班同学'))
    ok('琚家姐妹都不认识楚楠（只知道是洛汐的哥哥）',
      qy.profile.relations.includes('只知道他是洛汐的哥哥'))
    ok('辅导功课这条支线写在两姐妹卡上', allText(qy).includes('辅导功课') && allText(qq).includes('辅导'))
  }

  // ---------- 5) 未成年人保护 + 兄妹线硬约束（不许松） ----------
  {
    for (const name of ['洛汐', '琚瑶', '琚琪']) {
      const c = find(name)
      ok(`🔴 ${name}（17）：尺度栏写明未成年、不写亲密内容`,
        c.conduct.rating.includes('未成年') && c.conduct.rating.includes('亲密'))
    }
    const chu = find('楚楠')
    ok('🔴 楚楠：底线第一条就是「不许对洛汐有半分越界」',
      chu.conduct.bottomLine.includes('不许对洛汐有半分越界'))
    ok('🔴 楚楠：尺度栏点名洛汐不参与任何亲密场景',
      chu.conduct.rating.includes('洛汐（17 岁，未成年'))
    ok('🔴 楚楠：写明那点力量不是万能的（只影响好感、不解决现实问题）',
      chu.conduct.bottomLine.includes('不改事实') && chu.profile.cannot.includes('只影响"好感"'))
    const lx = find('洛汐')
    ok('🔴 洛汐这条线「不推进」写进进度锁', lx.conduct.paceLock.includes('不推进'))
    ok('🔴 洛汐不会被写成争风吃醋的反派', lx.conduct.bottomLine.includes('争风吃醋的反派'))
    const yw = find('云婉')
    ok('🔴 云婉：魅惑只到语言姿态层，不写身体描写',
      yw.conduct.rating.includes('具体身体描写不写'))
    ok('🔴 云婉：不许写「用身体换东西」的桥段', yw.conduct.bottomLine.includes('用身体换东西'))
  }

  // ---------- 6) 示例对话格式（v1.7：对白纯文本、非对白一律（ ）、〖对方〗只作对照） ----------
  {
    for (const c of SEED_FREE_CHARACTERS) {
      ok(`${c.name}：示例里非对白内容用（）包住、独立成行`, /^（.+）$/m.test(c.examples))
      ok(`${c.name}：🔴 示例里不再出现【】`, !c.examples.includes('【'))
      ok(`${c.name}：示例说明行同步了单括号规则`,
        c.examples.includes('其余全部用全角括号（ ）独立成行'))
      ok(`${c.name}：示例说明写明 〖对方〗 是输入侧对照、不许写进输出`,
        c.examples.includes('你的输出里永远不要出现') && c.examples.includes('〖对方〗'))
      ok(`${c.name}：不用旧标记、也不写自己的名字前缀`,
        !c.examples.includes('【用户】') && !c.examples.includes('〖用户〗') &&
        !c.examples.includes('对方：') && !new RegExp(`^${c.name}[：:]`, 'm').test(c.examples))
      ok(`${c.name}：说明性文字中性化（指代用 Ta）`, c.examples.includes('Ta'))
      ok(`${c.name}：每一段样本都写了对照标记`, (c.examples.match(/〖对方〗/g) || []).length >= 4)
    }
  }

  // ---------- 7) 第 0 章刻意不存 ----------
  {
    const bad: string[] = []
    for (const c of SEED_FREE_CHARACTERS) {
      const t = allText(c)
      if (t.includes('第 0 章')) bad.push(`${c.name}:第 0 章`)
      if (t.includes('roleplay-core-protocol')) bad.push(`${c.name}:协议名`)
      if (t.includes('MODEL_CONFIG')) bad.push(`${c.name}:MODEL_CONFIG`)
    }
    ok('不携带第 0 章 / 协议名 / MODEL_CONFIG（协议是内置常量，不重复占上下文）',
      bad.length === 0, bad.join('、'))
  }

  // ---------- 8) 能正常渲染成四章 system 片段 ----------
  {
    for (const c of SEED_FREE_CHARACTERS) {
      const full: FreeCharacter = { ...c, id: 'x', createdAt: 0, updatedAt: 0 }
      const out = renderFreeCharacter(full)
      const heads = ['〖第 1 章 · 世界〗', '〖第 2 章 · 人物档案〗', '〖第 3 章 · 行为规范〗', '〖第 4 章 · 示例对话（请模仿其应对话术与格式）〗']
      ok(`${c.name}：渲染出全部四章标题`, heads.every(h => out.includes(h)),
        heads.filter(h => !out.includes(h)).join('、'))
      ok(`${c.name}：渲染后不带第 0 章`, !out.includes('第 0 章'))
    }
  }

  // ---------- 9) 播种幂等 ----------
  {
    __resetMockStores()
    const n1 = await seedFreeChars()
    ok('首次播种新建 6 张', n1 === 6, String(n1))
    const n2 = await seedFreeChars()
    ok('重复播种不再新建（按来源标记幂等，不堆副本）', n2 === 0, String(n2))
    ok('库里确实只有 6 张', (await store.listFreeChars()).length === 6)
  }

  // ---------- 10) 集成：创建示范项目会把卡一起播种，且内容真的进 system ----------
  {
    __resetMockStores()
    await createDemoProject()
    const list = await store.listFreeChars()
    const names = list.map(x => x.name)
    ok('创建示范项目 → 六张示范卡自动入库',
      ['楚楠', '洛汐', '苏念', '云婉', '琚瑶', '琚琪'].every(n => names.includes(n)), names.join('、'))

    const full = (await Promise.all(list.map(i => store.getFreeChar(i.id)))).filter(Boolean) as FreeCharacter[]
    const lx = full.find(c => c.name === '洛汐')!
    ok('入库后的卡能完整读回（含四章正文）',
      !!lx && lx.world.includes('奉阳') && lx.examples.includes('哥哥大人'))

    const sess = await store.createFreeSession([lx.id], '与洛汐的测试场', { providerId: 'stub' }, {})
    const sys = await buildFreeSystem(sess, [lx])
    ok('角色卡内容真的进了 system（不是只躺在库里）', sys.system.includes('奉阳市'))
    ok('协议之后只跟一个记账块（格式提醒仍是协议的最后一段）',
      sys.system.indexOf(PROTOCOL_CORE) > 0 &&
      sys.system.indexOf('〖本场数值〗') > sys.system.indexOf(PROTOCOL_CORE))
  }

  // ---------- 11) 老库升级 ----------
  // 整卡指纹表是「2026-09-15 世界观整卡改版」能让老库自动升上来的唯一依据。
  // 生成时是用 git 里那三张旧卡逐个算过的（见提交说明），这里守它的**格式**与**不自我命中**。
  {
    for (const name of SEED_FREE_CHARACTERS.map(c => c.name)) {
      const sigs = LEGACY_SEED_CARD_SIGS[name] ?? []
      ok(`${name}：留了历史整卡指纹且格式正确`,
        sigs.length >= 1 && sigs.every(s => /^[0-9a-f]{8}$/.test(s)), JSON.stringify(sigs))
      ok(`${name}：当前版本指纹不在历史表里（否则每次启动都会白刷一遍）`,
        !sigs.includes(cardSig(find(name) as never)))
    }
    ok('六张卡都登记了「改版前」的指纹（改过卡内容就必须登记，否则老库升不上来）',
      SEED_FREE_CHARACTERS.every(c => (LEGACY_SEED_CARD_SIGS[c.name] ?? []).length >= 1))

    // ② 整卡升级分支：把一张「四章与某历史版本全等」的卡放进库 → 应当整体换成新版。
    //    这里用一个合成指纹触发（真实指纹已在提交时用 git 旧卡验过），验的是**接线**：
    //    命中后换四章、且不碰名字与记忆。
    {
      __resetMockStores()
      const oldWorld = '1.1 时空坐标\n（这里是 2026-09-15 之前的青宜大学城版世界）'
      const made = await store.createFreeChar({
        ...find('洛汐'), name: '洛汐', world: oldWorld, examples: '旧示例，随便写的',
      })
      const synthetic = cardSig({ ...find('洛汐'), world: oldWorld, examples: '旧示例，随便写的' } as never)
      LEGACY_SEED_CARD_SIGS['洛汐'].push(synthetic)
      try {
        await store.saveMemory({ ...store.emptyMemory(made.id), longTerm: '这段记忆要活着' })
        const n = await upgradeSeedCards()
        const after = (await store.getFreeChar(made.id))!
        const mem = await store.getMemory(made.id)
        ok('🔴 整卡指纹命中 → 四章整体升到新版（不是只换示例）',
          n === 1 && after.world === find('洛汐').world && after.examples === find('洛汐').examples &&
          after.profile.core === find('洛汐').profile.core)
        ok('整卡升级不碰名字，也不碰记忆（那是「经历」不是模板）',
          after.name === '洛汐' && mem.longTerm === '这段记忆要活着')
        ok('升过之后不再重复升（幂等）', (await upgradeSeedCards()) === 0)
      } finally {
        LEGACY_SEED_CARD_SIGS['洛汐'].pop()
      }
    }

    // ③ 单个改动过的卡：指纹对不上 → 一个字都不动
    {
      __resetMockStores()
      const made = await store.createFreeChar({ ...find('苏念'), profile: { ...find('苏念').profile, core: '我自己改过的内核' } })
      const n = await upgradeSeedCards()
      const after = (await store.getFreeChar(made.id))!
      ok('作者改过一个字 → 指纹对不上，程序一个字都不动', n === 0 && after.profile.core === '我自己改过的内核')
    }

    // ④ 示例对话的历史版本仍走「整段换新」
    {
      __resetMockStores()
      await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '洛汐', examples: LEGACY_SEED_EXAMPLES['洛汐'][0] })
      const n = await upgradeSeedCards()
      const got = (await store.getFreeChar((await store.listFreeChars())[0].id))!.examples
      ok('老卡示例一字未改（v1.1 全文）→ 整段升级到最新版', n === 1 && got === find('洛汐').examples, `张数=${n}`)
      ok('旧示例都留在 LEGACY 里（每一代都追加，不只留上一代）',
        LEGACY_SEED_EXAMPLES['洛汐'].length >= 3 && LEGACY_SEED_EXAMPLES['苏念'].length >= 3 &&
        LEGACY_SEED_EXAMPLES['楚楠'].length >= 3)
    }

    // ⑤ 只有头部签名、正文被改过 → 只换标记
    {
      __resetMockStores()
      const v12 = find('洛汐').examples.split('〖对方〗').join('对方：')
      await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '洛汐', examples: v12 })
      await upgradeSeedCards()
      const got = (await store.getFreeChar((await store.listFreeChars())[0].id))!.examples
      ok('v1.2 格式的老卡 → 只换标记就回到新版（正文一字不动）',
        got === find('洛汐').examples && !got.includes('对方：'))
    }

    // ⑥ 作者自己写的示例 → 一个字都不动
    {
      __resetMockStores()
      const mine = '对方：今天吃什么\n（她想了想）\n随便。'
      await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '洛汐', examples: mine })
      await upgradeSeedCards()
      const got = (await store.getFreeChar((await store.listFreeChars())[0].id))!.examples
      ok('作者自己写的示例（无示范卡签名）→ 一个字都不动', got === mine)
    }
  }

  // ---------- 12) 恢复内置版本 ----------
  {
    ok('内置示范卡名单认得这六张',
      ['楚楠', '洛汐', '苏念', '云婉', '琚瑶', '琚琪'].every(n => isSeedCardName(n)) &&
      !isSeedCardName('洛汐（副本）'))

    __resetMockStores()
    const created = await store.createFreeChar({ ...find('楚楠'), world: '被我改坏了', examples: '随便写的' })
    await store.saveMemory({ ...store.emptyMemory(created.id), longTerm: '这段记忆要活着' })
    const hit = await resetCardToSeed(created.id)
    const after = await store.getFreeChar(created.id)
    const memAfter = await store.getMemory(created.id)
    ok('恢复内置版本：命中并覆盖四章',
      hit === '楚楠' && after!.world === find('楚楠').world && after!.examples === find('楚楠').examples)
    ok('恢复内置版本：记忆与日常状态不受影响', memAfter.longTerm === '这段记忆要活着')

    __resetMockStores()
    const renamed = await store.createFreeChar({ ...find('楚楠'), name: '楚楠（副本）', world: '保留我改的' })
    ok('改了名的卡不会被误伤',
      (await resetCardToSeed(renamed.id)) === null && (await store.getFreeChar(renamed.id))!.world === '保留我改的')
  }

  // ---------- 13) 按「来源标记」认卡（改名不重播） ----------
  {
    __resetMockStores()
    await seedFreeChars()
    const full = (await Promise.all((await store.listFreeChars()).map(i => store.getFreeChar(i.id))))
      .filter((c): c is FreeCharacter => !!c)
    ok('播种时给每张卡打上来源标记（值＝种子原名）',
      full.length === 6 && full.every(c => c.seededFrom === c.name),
      JSON.stringify(full.map(c => [c.name, c.seededFrom])))

    const lx = full.find(c => c.seededFrom === '洛汐')!
    await store.saveFreeChar({ ...lx, name: '洛汐（改名版）' })
    ok('🔴 改名之后重建示范项目**不会**再播一张原名卡',
      (await seedFreeChars()) === 0 && (await store.getFreeChar(lx.id))!.name === '洛汐（改名版）')
    ok('库里仍是 6 张（没多出副本）', (await store.listFreeChars()).length === 6)

    __resetMockStores()
    await seedFreeChars()
    const su = (await Promise.all((await store.listFreeChars()).map(i => store.getFreeChar(i.id))))
      .find(c => c?.seededFrom === '苏念')!
    await store.saveFreeChar({ ...su, name: '苏念·改', examples: LEGACY_SEED_EXAMPLES['苏念'][0] })
    const up = await upgradeSeedCards()
    ok('改名后依然能被升级命中（按来源认，不看现名）', up >= 1)

    __resetMockStores()
    const old = await store.createFreeChar({ ...find('洛汐') })
    ok('老库的卡一开始确实没有标记', !(await store.getFreeChar(old.id))!.seededFrom)
    ok('播种时给老库的卡补上标记', (await seedFreeChars()) === 5 && (await store.getFreeChar(old.id))!.seededFrom === '洛汐')
    ok('再播一次完全不动（幂等）', (await seedFreeChars()) === 0)

    const json = toCardFile((await store.getFreeChar(old.id))!)
    ok('🔴 导出文件里不含 seededFrom', !json.includes('seededFrom'))

    ok('findSeedFor 优先按标记认（改名后仍指向原种子）',
      findSeedFor({ name: '随便改的名字', seededFrom: '楚楠' })?.name === '楚楠')
    ok('findSeedFor 对自建卡返回 undefined',
      findSeedFor({ name: '我自己写的', seededFrom: undefined }) === undefined)
    ok('isSeedCard 认得出改名后的示范卡，也放得过自建卡',
      isSeedCard({ name: '洛汐·改', seededFrom: '洛汐' }) && !isSeedCard({ name: '我自己写的' }))
    ok('isSeedCardName 保留旧行为（按现名判定）',
      isSeedCardName('洛汐') && !isSeedCardName('洛汐（改名版）'))
  }

  console.log(`\ntavernSeedCards: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
