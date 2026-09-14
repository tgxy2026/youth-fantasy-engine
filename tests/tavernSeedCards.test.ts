// ============ 酒馆模式 · 示范角色卡（洛汐 / 苏念）============
//
// 这批卡是从老大手写的两张 .md 角色卡转写来的，转写过程做了「原卡五章 → 本系统四章」的归位，
// 所以这里最关键的不是「结构对不对」，而是**内容有没有在归位时丢掉**。
// 因此第 2 组断言逐条抽查原卡各节的独有字串 —— 归位可以换位置，但不能丢内容。
import { SEED_FREE_CHARACTERS, seedFreeChars } from '../src/lib/tavern/seedCards'
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

async function main() {
  // ---------- 1) 结构完整性：四章六个档案栏四个行为栏都在 ----------
  {
    ok('示范卡共三张', SEED_FREE_CHARACTERS.length === 3, `实际=${SEED_FREE_CHARACTERS.length}`)
    ok('名字是洛汐 / 苏念 / 楚楠',
      SEED_FREE_CHARACTERS.map(c => c.name).join(',') === '洛汐,苏念,楚楠',
      SEED_FREE_CHARACTERS.map(c => c.name).join(','))

    for (const c of SEED_FREE_CHARACTERS) {
      const t = allText(c)
      const missing: string[] = []
      if (!c.name.trim()) missing.push('name')
      if (!c.world.trim()) missing.push('world')
      for (const [k, v] of Object.entries(c.profile)) if (!String(v).trim()) missing.push(`profile.${k}`)
      for (const [k, v] of Object.entries(c.conduct)) if (!String(v).trim()) missing.push(`conduct.${k}`)
      if (!c.examples.trim()) missing.push('examples')
      ok(`${c.name}：四章无空栏`, missing.length === 0, missing.join('、'))
      // 洛汐/苏念 是**从老大手写的卡转写**来的，门槛高（少了就是归位时丢了内容）；
      // 楚楠 是**按那两张卡的事实新写的**，没有原卡可比，只卡一个「不是骨架」的下限。
      const floor = c.name === '楚楠' ? 2500 : 3500
      ok(`${c.name}：字数足够撑起一张卡（>${floor}）`, t.length > floor, String(t.length))
    }
  }

  // ---------- 1b) 楚楠（AI 演他 / 用户演苏念或洛汐）必须与另两张卡对得上 ----------
  {
    const chu = find('楚楠')
    const t = allText(chu)
    // 这些事实全部来自洛汐卡 / 苏念卡，楚楠卡不许自说自话
    const facts: [string, string][] = [
      ['苏念对他的称呼', '哥哥'],
      ['洛汐表白三次', '三次'],
      ['他的饮食禁忌（苏念知道）', '不吃香菜'],
      ['他的身体状况（苏念知道）', '胃不好'],
      ['熬夜后遗症（苏念知道）', '头疼'],
      ['只有苏念能用的称呼', '念念'],
      ['洛汐的关系时长', '四个月'],
      ['与苏念家的地理关系', '窄巷'],
    ]
    const missing = facts.filter(([, s]) => !t.includes(s))
    ok('楚楠卡的每条关系事实都能在另两张卡里找到出处（8 处抽查）', missing.length === 0,
      missing.map(([k, s]) => `${k}:${s}`).join(' | '))

    ok('楚楠卡把「两人互不知情」写成行为约束，而不是留给模型自由发挥',
      t.includes('不知道对方在楚楠这里的分量') && t.includes('不会主动提'))
    ok('楚楠卡写明用户可能演谁、AI 要按对面是谁调整', t.includes('先看对面是谁'))
    ok('示范卡的说明性文字已中性化（指代角色用 Ta，不预设性别）',
      SEED_FREE_CHARACTERS.every(c => c.examples.includes('Ta')) &&
      !SEED_FREE_CHARACTERS.some(c => c.examples.includes('她该怎么说话')))
    ok('楚楠的示例用「对方：」标对方的台词、他自己不加名字前缀',
      chu.examples.includes('对方：') && !/^楚楠[：:]/m.test(chu.examples) && !chu.examples.includes('〖用户〗'))

    // —— v1.2 示例格式（三类标记各就各位）——
    for (const c of SEED_FREE_CHARACTERS) {
      ok(`${c.name}：示例里动作与神态用（）包住、独立成行`,
        /^（.+）$/m.test(c.examples))
      ok(`${c.name}：示例里有【】客观环境／人物外在的样例`,
        /^【.+】$/m.test(c.examples))
      ok(`${c.name}：示例不再使用旧标记，也不写自己的名字前缀`,
        !c.examples.includes('【用户】') && !c.examples.includes('〖用户〗') &&
        !new RegExp(`^${c.name}[：:]`, 'm').test(c.examples))
      ok(`${c.name}：示例说明里写明「对方：」是输入侧对照、不许写进输出`,
        c.examples.includes('你的输出里永远不要出现'))
    }
  }

  // ---------- 2) 归位没丢内容：逐节抽查原卡独有字串 ----------
  {
    const luoxi = find('洛汐')
    const marks: [string, string][] = [
      ['第1章·世界', '东区 7 号楼 402'],
      ['2.1 档案', '右手食指内侧有一小块茧'],
      ['2.2 内核', '寄养在姑姑家两年'],
      ['2.3 语言', '生气的时候会变得非常礼貌'],
      ['2.4 关系', '林方圆'],
      ['2.4 关系', '周野'],
      ['2.5 限制', '当众发言'],
      ['2.6 知识边界', '怎么凑满减'],
      ['3.1 视角', '微信对话可以直接用她的消息体'],
      ['3.2 底线', '她对这三个词过敏'],
      ['3.3 尺度', '更进一步的亲密由她主导节奏'],
      ['3.4 不可协商（并入底线）', '绝不主动交出关于家里的事'],
      ['3.5 进度锁', '不会自己上涨'],
      ['3.6 状态块（并入视角）', '频率每 10 轮'],
      ['4 示例', '其实那天我是故意让你在楼下等的'],
    ]
    const t = allText(luoxi)
    const lost = marks.filter(([, s]) => !t.includes(s))
    ok('洛汐：原卡各节内容全部在（逐节抽查 15 处）', lost.length === 0,
      lost.map(([k, s]) => `${k}:${s}`).join(' | '))

    const sunian = find('苏念')
    const marks2: [string, string][] = [
      ['第1章·世界', '东区 6 号楼 305'],
      ['第1章·世界', '种着梧桐的窄巷'],
      ['2.1 档案', '发绳是带小熊的'],
      ['2.2 内核', '她在店里等到十一点半'],
      ['2.3 语言', '道歉频率极高'],
      ['2.4 关系', '周小满'],
      ['2.4 关系', '苏国栋'],
      ['2.5 限制', '拒绝别人'],
      ['2.6 知识边界', '他不吃香菜'],
      ['3.1 视角', '一次连发不超过 2 条'],
      ['3.2 底线', '她会当真，然后真的消失'],
      ['3.3 尺度', '它不等于同意'],
      ['3.4 不可协商（并入底线）', '不可以假装没事'],
      ['3.5 进度锁', '她敢不敢拒绝你'],
      ['3.6 状态块（并入视角）', '她今天有点小心'],
      ['4 示例', '我只是怕你不想要我帮忙了'],
    ]
    const t2 = allText(sunian)
    const lost2 = marks2.filter(([, s]) => !t2.includes(s))
    ok('苏念：原卡各节内容全部在（逐节抽查 16 处）', lost2.length === 0,
      lost2.map(([k, s]) => `${k}:${s}`).join(' | '))

    ok('两张卡的示例都写明了「无标点只限于 Ta 发出去的消息」',
      [luoxi, sunian].every(c => c.examples.includes('只适用于 Ta 发出去的消息文本')))
    ok('洛汐 3.1 也限定了「无标点」只指消息文本',
      luoxi.conduct.perspective.includes('只适用于**她发出去的消息文本**'))
  }

  // ---------- 3) 第 0 章刻意不存（协议已是内置常量） ----------
  {
    const bad: string[] = []
    for (const c of SEED_FREE_CHARACTERS) {
      const t = allText(c)
      if (t.includes('第 0 章')) bad.push(`${c.name}:第 0 章`)
      if (t.includes('roleplay-core-protocol')) bad.push(`${c.name}:协议名`)
      if (t.includes('MODEL_CONFIG')) bad.push(`${c.name}:MODEL_CONFIG`)
    }
    ok('不携带原卡第 0 章 / 协议名 / MODEL_CONFIG（协议是内置常量，不重复占上下文）',
      bad.length === 0, bad.join('、'))
  }

  // ---------- 4) 能正常渲染成四章 system 片段 ----------
  {
    for (const c of SEED_FREE_CHARACTERS) {
      const full: FreeCharacter = { ...c, id: 'x', createdAt: 0, updatedAt: 0 }
      const out = renderFreeCharacter(full)
      const heads = ['〖第 1 章 · 世界〗', '〖第 2 章 · 人物档案〗', '〖第 3 章 · 行为规范〗', '〖第 4 章 · 示例对话']
      ok(`${c.name}：渲染出全部四章标题`, heads.every(h => out.includes(h)),
        heads.filter(h => !out.includes(h)).join('、'))
      ok(`${c.name}：渲染后不带第 0 章`, !out.includes('第 0 章'))
    }
  }

  // ---------- 5) 播种幂等 ----------
  {
    __resetMockStores()
    const n1 = await seedFreeChars()
    ok('首次播种新建 3 张', n1 === 3, String(n1))
    const n2 = await seedFreeChars()
    ok('重复播种不再新建（按名字幂等，不堆副本）', n2 === 0, String(n2))
    ok('库里确实只有 3 张', (await store.listFreeChars()).length === 3)
  }

  // ---------- 6) 集成：创建示范项目会把卡一起播种，且内容真的进 system ----------
  {
    __resetMockStores()
    await createDemoProject()
    const list = await store.listFreeChars()
    const names = list.map(x => x.name)
    ok('创建示范项目 → 示范角色卡自动入库（含楚楠）', names.includes('洛汐') && names.includes('苏念') && names.includes('楚楠'),
      names.join('、'))

    const full = (await Promise.all(list.map(i => store.getFreeChar(i.id)))).filter(Boolean) as FreeCharacter[]
    const luoxi = full.find(c => c.name === '洛汐')!
    ok('入库后的卡能完整读回（含四章正文）',
      !!luoxi && luoxi.world.includes('青宜大学城') && luoxi.examples.includes('你明天有空吗'))

    const sess = await store.createFreeSession([luoxi.id], '与洛汐的测试场', { providerId: 'stub' }, {})
    const sys = await buildFreeSystem(sess, [luoxi])
    ok('角色卡内容真的进了 system（不是只躺在库里）', sys.system.includes('青宜大学城'))
    ok('协议仍钉在 system 末尾', sys.system.trimEnd().endsWith(PROTOCOL_CORE.trimEnd()))
  }

  console.log(`\ntavernSeedCards: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
