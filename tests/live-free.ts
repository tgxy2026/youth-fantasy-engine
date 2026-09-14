// 自由模式 · 实弹验证（**手动运行**，不进全量回归）
//
// 目的：验证方案 §10 给 P2 的验收标准 ——「聊满阈值后记忆自动更新；
//       关掉应用再打开，记忆还在**且能被用上**」。
//
// 怎么验最严：「能被用上」不能靠原文还在上下文里冒充。所以流程刻意设计成闭环 ——
//   会话 A 聊出事实（猫叫阿灰）→ 总结成六栏记忆 → **新建会话 B（同角色，没有任何原文）**
//   → 问它「还记得那只猫吗」。B 里只有记忆可用，答得出「阿灰」才说明记忆真的在起作用。
//   （这也顺带验证了方案 §7.2 的设计：记忆是角色级的，跳会话共享。）
//
// 用法：
//   node tests/build-test.mjs live-free                    # 用本地 Ollama（快、免费）
//   YFE_LIVE_FREE_MODEL=xxx node tests/build-test.mjs live-free
//
// 命名不叫 *.test.ts —— 避免被 run-all.mjs 纳入全量回归（会真调模型）。
import fs from 'fs'
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { saveProviders, saveActiveId, type AIProvider } from '../src/lib/ai'
import { runFreeTurn, buildFreeSystem } from '../src/lib/tavern/engine'
import { buildOpeningMessage } from '../src/lib/tavern/prompt'
import { uid } from '../src/lib/id'
import { summarizeMemory } from '../src/lib/tavern/summarize'
import { memoryChars, memoryToText, messagesAfterWatermark, nextWatermark, MEMORY_SECTIONS } from '../src/lib/tavern/memory'
import { SEED_FREE_CHARACTERS } from '../src/lib/tavern/seedCards'
import type { FreeCharacter, FreeSession } from '../src/lib/tavern/types'

const DATA = 'C:/Users/18223/AppData/Roaming/novel-studio/novel-studio-data.json'

function loadRealProviders(): AIProvider[] {
  const meta = JSON.parse(fs.readFileSync(DATA, 'utf8')).stores.meta
  const raw = meta.aiProviders?.value ?? meta.aiProviders
  return Array.isArray(raw) ? raw : []
}

/** 挑一个本地真实存在的模型（配置里写的那个可能已被删） */
async function pickLocal(): Promise<{ provider: AIProvider; model: string; note: string } | null> {
  const providers = loadRealProviders()
  const local = providers.find(p => p.type === 'ollama')
  if (!local) return null
  const want = process.env.YFE_LIVE_FREE_MODEL
  try {
    const j = (await (await fetch('http://localhost:11434/api/tags')).json()) as { models?: { name: string }[] }
    const names = (j.models ?? []).map(m => m.name)
    if (names.length === 0) return null
    if (want && names.includes(want)) return { provider: local, model: want, note: '' }
    if (names.includes(local.model)) return { provider: local, model: local.model, note: '' }
    const prefer = names.find(n => /uncensored|abliterated/i.test(n)) ?? names[0]
    return { provider: local, model: prefer, note: `（配置里的「${local.model}」本地不存在，改用「${prefer}」）` }
  } catch {
    return null
  }
}

const CHAR_EXAMPLES = [
  '〖对方〗这么晚还不下班？',
  '她把找零推过去，没抬头：',
  '「灯还亮着。」',
  '',
  '〖对方〗你一个人看店不怕吗？',
  '她停了一下，把烟按灭。',
  '「惯了。」',
  '',
  '〖对方〗……谢谢。',
  '她背过身去理货架，声音很轻：',
  '「伞在门后。」',
].join('\n')

async function mkChar(): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name: '苏念',
    world: '现代都市，老城区一间凌晨还亮着灯的便利店。她是店员，你是常来的顾客。',
    profile: {
      externals: '短发，总穿同一件洗旧的灰色围裙，左手腕有道旧疤',
      core: '外冷内热。嘴上不留情，但会记得你爱吃什么。',
      speech: '句子短，习惯用反问，从不说软话',
      relations: '独居，父母在老家',
      cannot: '说不出关心的话，只能换成别的方式表达',
      knowledge: '不知道顾客的职业与过去',
    },
    conduct: {
      perspective: '第一人称，只描写她自己的动作与感官',
      bottomLine: '不越界打听私事；被追问会转移话题，不会发火',
      paceLock: '关系推进要慢',
      rating: '日常向',
    },
    examples: CHAR_EXAMPLES,
  })
}

/**
 * 逐行审计模型输出是否符合协议 v1.3：
 *   对白＝纯文本 / （）＝动作·神态·心理 / 【】＝客观环境与人物外在 / 〔〕＝状态块
 * 返回各类行数与**违规清单**（带原文片段，便于人工复核）。
 */
export function auditFormat(reply: string, castNames: string[] = []) {
  const lines = reply.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const issues: string[] = []
  let action = 0, env = 0, talk = 0, status = 0
  for (const l of lines) {
    if (/[〖〗〈〉]/.test(l)) issues.push('出现输入侧结构标记：' + l.slice(0, 24))
    if (/^（|^\(/.test(l)) { action++; continue }
    if (/^【/.test(l)) { env++; continue }
    if (/^〔/.test(l)) { status++; continue }
    talk++
    if (/[“”"「」]/.test(l)) issues.push('对白里带引号：' + l.slice(0, 24))
    if (/^(对方|用户|用户角色)[：:]/.test(l)) issues.push('对白带对照标记：' + l.slice(0, 24))
    // v1.3 补的判据：把说话人的名字**单独写成一行** —— 比「名字：」更隐蔽，实测模型会这么干
    if (castNames.includes(l)) issues.push('对白行是说话人名字单独成行：' + l.slice(0, 24))
    if (/^[\u4e00-\u9fa5]{2,4}[：:]/.test(l)) issues.push('对白行疑似「名字：」前缀：' + l.slice(0, 24))
  }
  return { lines: lines.length, action, env, talk, status, issues }
}

async function say(session: FreeSession, char: FreeCharacter, text: string, cast?: FreeCharacter[]): Promise<FreeSession> {
  const t0 = Date.now()
  const res = await runFreeTurn(session, cast ?? [char], text)
  const saved = await store.saveFreeSession(res.session)
  console.log(`\n〖我〗${text}`)
  console.log(`〖${char.name}〗${res.reply}`)
  console.log(`   （${Date.now() - t0} ms）`)
  return saved
}

async function main() {
  const pick = await pickLocal()
  if (!pick) { console.log('❌ 本地 Ollama 不可用或没有模型，跳过'); return }
  console.log(`=== 使用模型：${pick.model} ${pick.note} ===`)

  __resetMockStores()
  await saveProviders([{ ...pick.provider, model: pick.model }])
  await saveActiveId(pick.provider.id)

  const char = await mkChar()

  // ---------- 阶段 0：开场设定（2026-09-14 新增：新建对话支持地点/时间/场景/第一句话） ----------
  // 风险点：开场是**第一条 user 消息**，随后用户再发一句就是**连续两条 user**。
  // 这里实测模型能不能吃下这种形态、并真的把场景用起来（而不是把开场当成「用户说过的话」回一句）。
  console.log('\n' + '='.repeat(70))
  console.log('▶ 阶段 0 · 开场设定 → 第一条消息（本轮新增能力）')
  console.log('='.repeat(70))
  const scene = { place: '老城区便利店', time: '凌晨两点', present: ['苏念'], description: '外面在下雨，店里只有收银台的灯亮着。' }
  const opening = buildOpeningMessage(scene, '（我把伞收在门口，走到柜台前。）')
  console.log('渲染出的开场消息：\n' + opening)
  let s0 = await store.createFreeSession([char.id], '开场设定验证', { providerId: pick.provider.id }, {})
  s0 = await store.saveFreeSession({
    ...s0, scene,
    messages: [{ id: uid(), role: 'user', content: opening, at: Date.now() }],
  })
  const { system: sys0 } = await buildFreeSystem(s0, [char])
  console.log(`[离线断言] system ${sys0.length} 字 · 含角色卡 ${sys0.includes('外冷内热') ? '✓' : '✗'} · 含协议 ${sys0.includes('最后提醒') ? '✓' : '✗'}`)
  s0 = await say(s0, char, '（我把伞收在门口，走到柜台前。）')
  const sceneUsed = /雨|伞|灯|柜台|两点/.test(s0.messages[s0.messages.length - 1]?.content ?? '')
  console.log(`[实弹观察] 回复里出现了场景词（雨/伞/灯/柜台/两点）：${sceneUsed ? '✓ 场景被用上了' : '⚠️ 未见场景词'}`)

  // ---------- 阶段 4：用户扮演具体角色（2026-09-14 新增） ----------
  // 用**交付的三张示范卡**跑：用户演苏念、AI 演楚楠。
  // 要验三件事：① 身份层真的写明了谁演谁；② 模型不抢用户角色的台词；
  //            ③ 按卡上写的关系称呼（楚楠只叫她「念念」，不会叫「苏念」）。
  console.log('\n' + '='.repeat(70))
  console.log('▶ 阶段 4 · 用户扮演苏念 / AI 演楚楠（用交付的示范卡）')
  console.log('='.repeat(70))
  const seedSu = SEED_FREE_CHARACTERS.find(c => c.name === '苏念')
  const seedChu = SEED_FREE_CHARACTERS.find(c => c.name === '楚楠')
  if (!seedSu || !seedChu) { console.log('❌ 示范卡里缺少苏念/楚楠，跳过本阶段'); return }
  const su2 = await store.createFreeChar(seedSu)
  const chu = await store.createFreeChar(seedChu)
  let s4 = await store.createFreeSession([chu.id, su2.id], '苏念 × 楚楠', { providerId: pick.provider.id }, {}, su2.id)
  const sys4 = (await buildFreeSystem(s4, [chu, su2])).system
  console.log(`[离线断言] 身份层写明「用户扮演：苏念」：${sys4.includes('用户扮演：苏念') ? '✓' : '✗'}`)
  console.log(`[离线断言] 要求不代写：${sys4.includes('不要代写') ? '✓' : '✗'}`)
  console.log(`[离线断言] AI 只演楚楠：${sys4.includes('你扮演：楚楠') ? '✓' : '✗'}`)
  console.log(`[离线断言] 楚楠卡进了设定层：${sys4.includes('被两个人当作锚点') ? '✓' : '✗'}`)
  console.log(`[离线断言] 苏念的记忆不给楚楠（她还没聊过，本应为空）：${sys4.includes('〖长期记忆 · 苏念〗') ? '⚠️ 有' : '✓ 无'}`)
  s4 = await say(s4, chu, '（我把伞立在门口，没看他，只把烟推过去。）', [chu, su2])
  const reply4 = s4.messages[s4.messages.length - 1]?.content ?? ''
  const stole = /^苏念[：:]/.test(reply4.trim()) || /（苏念/.test(reply4) || /苏念[说道]/.test(reply4)
  console.log(`[实弹观察] 模型是否抢了用户角色（苏念）的台词：${stole ? '⚠️ 疑似抢词' : '✓ 未见'}`)
  console.log(`[实弹观察] 是否按卡上关系用「念念」称呼（卡里写他只叫她念念）：${/念念/.test(reply4) ? '✓ 用了' : '（这轮没用，不算错）'}`)
  console.log(`[实弹观察] 是否误把她叫成「苏念」：${/苏念/.test(reply4) ? '⚠️ 叫了全名' : '✓ 没叫全名'}`)

  // ---------- 阶段 5：客观描写（2026-09-14 新增能力） ----------
  // 老大要的沉浸感：角色出场要「看得见」—— 她穿什么、周围什么光、外面什么天气。
  // 场景取自他给的例子：楚楠约洛汐看电影。用户演楚楠，AI 演洛汐。
  // 要验两件事：① 规则真的进了 system；② 模型真写了描写，而且**没把 60–160 字的篇幅撑爆**
  //            （协议的字数是硬约束，描写若挤掉对白就本末倒置）。
  console.log('\n' + '='.repeat(70))
  console.log('▶ 阶段 5 · 客观描写（约会场景 · 用户演楚楠 / AI 演洛汐）')
  console.log('='.repeat(70))
  const seedLuo = SEED_FREE_CHARACTERS.find(c => c.name === '洛汐')
  if (!seedLuo) { console.log('❌ 示范卡里缺少洛汐，跳过本阶段'); return }
  const luo = await store.createFreeChar(seedLuo)
  const chuU = await store.createFreeChar(seedChu)
  const scene5 = {
    place: '市中心影城的售票大厅',
    time: '周六傍晚，刚下过一场雨',
    present: ['洛汐'],
    description: '楚楠先到，站在取票机旁边等；大厅里在放新片的预告，声音有点大。',
  }
  let s5 = await store.createFreeSession([luo.id, chuU.id], '洛汐 × 楚楠（电影院）', { providerId: pick.provider.id }, {}, chuU.id)
  s5 = await store.saveFreeSession({
    ...s5, scene: scene5,
    messages: [{ id: uid(), role: 'user', content: buildOpeningMessage(scene5, '（我把两张票捏在手里，看见玻璃门被推开。）'), at: Date.now() }],
  })
  const sys5 = (await buildFreeSystem(s5, [luo, chuU])).system
  console.log(`[离线断言] system 含〖客观描写〗：${sys5.includes('〖客观描写〗') ? '✓' : '✗'}`)
  // ⚠️ 这两条曾长期是 ✗：断言里写的是旧措辞，规则正文早就换了说法（手动实弹不进回归，所以没被发现）。
  console.log(`[离线断言] 写明「不写任何人的心理活动」：${sys5.includes('不写任何人的心理活动') ? '✓' : '✗'}`)
  console.log(`[离线断言] 描写算在协议字数内：${sys5.includes('算在协议的字数里') ? '✓' : '✗'}`)
  console.log(`[离线断言] 写明动作归（）、不要写两遍：${sys5.includes('不要把同一个动作写两遍') ? '✓' : '✗'}`)
  s5 = await say(s5, luo, '（我把票递过去）路上淋着了吗？', [luo, chuU])
  const reply5 = s5.messages[s5.messages.length - 1]?.content ?? ''
  const DESC_WORDS = /(外套|裙子|裙|毛衣|围巾|发梢|头发|鞋|袖口|指尖|手里|肩上|雨|伞|灯|光|风|水汽|味道|地毯|海报|广播|玻璃门|大厅|晚场|票根)/
  const hitWords = (reply5.match(new RegExp(DESC_WORDS.source, 'g')) ?? []).slice(0, 8)
  const len5 = reply5.replace(/\s/g, '').length
  console.log(`[实弹观察] 回复里出现客观描写词：${hitWords.length ? '✓ ' + hitWords.join('、') : '⚠️ 未见'}`)
  console.log(`[实弹观察] 回复长度 ${len5} 字 → ${len5 <= 200 ? '✓ 仍在协议篇幅内' : '⚠️ 超出 160 字较多'}`)
  console.log(`[实弹观察] 是否替楚楠（用户角色）说话：${/（楚楠/.test(reply5) || /^楚楠[：:]/.test(reply5.trim()) ? '⚠️ 疑似代写' : '✓ 未见'}`)

  // ---------- 阶段 6：v1.2/v1.3 输出规范（老大 2026-09-14 定的三类标记 + 对白无说话人标记） ----------
  // 要观察的是：对白是不是纯文本（不带引号、不带名字前缀）、动作是不是（）、
  // 客观环境／人物外在是不是【】，以及**有没有把输入侧的〖〗〈〉漏进输出**。
  console.log('\n' + '='.repeat(70))
  console.log('▶ 阶段 6 · 输出规范（对白纯文本 / （）动作神态心理 / 【】客观环境与人物外在）')
  console.log('='.repeat(70))
  {
    const seedL = SEED_FREE_CHARACTERS.find(c => c.name === '洛汐')
    const seedC = SEED_FREE_CHARACTERS.find(c => c.name === '楚楠')
    if (!seedL || !seedC) { console.log('❌ 示范卡里缺少洛汐/楚楠，跳过本阶段'); return }
    const luo6 = await store.createFreeChar(seedL)
    const chu6 = await store.createFreeChar(seedC)
    const scene6 = {
      place: '市中心影城的售票大厅', time: '周六傍晚，刚下过一场雨',
      present: ['洛汐'], description: '楚楠先到，站在取票机旁边等；大厅在放新片预告，声音有点大。',
    }
    let s6 = await store.createFreeSession([luo6.id, chu6.id], '格式检查 · 电影院', { providerId: pick.provider.id }, {}, chu6.id)
    s6 = await store.saveFreeSession({
      ...s6, scene: scene6,
      messages: [{ id: uid(), role: 'user', content: buildOpeningMessage(scene6, '（我把两张票捏在手里，看见玻璃门被推开。）'), at: Date.now() }],
    })
    const sys6 = (await buildFreeSystem(s6, [luo6, chu6])).system
    console.log(`[离线断言] system 含〖客观描写〗：${sys6.includes('〖客观描写〗') ? '✓' : '✗'}`)
    console.log(`[离线断言] 协议正文已是 v1.3：${sys6.includes('角色扮演通用协议 · v1.3') ? '✓' : '✗'}`)
    console.log(`[离线断言] 身份层代词中性（Ta）：${sys6.includes('用 Ta 的眼睛看') ? '✓' : '✗'}`)
    console.log(`[离线断言] 输入侧用的是〖〗〈〉（示例标题/说话人）：${sys6.includes('〖样本') || sys6.includes('〈') ? '✓' : '✗'}`)
    console.log(`[离线断言] 对白不许加说话人标记已写进协议：${sys6.includes('不要把说话人的名字单独写成一行') ? '✓' : '✗'}`)
    console.log(`[离线断言] 示例里的对照标记是输入侧符号 〖对方〗：${sys6.includes('〖对方〗') ? '✓' : '✗'}`)
    console.log(`[离线断言] 旧版协议不再出现：${sys6.includes('v1.1') ? '⚠️ 有残留' : '✓ 无'}`)

    s6 = await say(s6, luo6, '（我把票递过去）路上淋着了吗？', [luo6, chu6])
    const reply6 = s6.messages[s6.messages.length - 1]?.content ?? ''
    const a6 = auditFormat(reply6, ['洛汐', '楚楠'])
    console.log(`[实弹观察] 行分布：动作（）${a6.action} · 环境【】${a6.env} · 对白 ${a6.talk} · 状态〔〕${a6.status}`)
    console.log(`[实弹观察] 违规项：${a6.issues.length ? '⚠️ ' + a6.issues.join(' | ') : '✓ 无'}`)
    console.log(`[实弹观察] 篇幅 ${reply6.replace(/\s/g, '').length} 字（协议建议 60–160）`)

    // 再来一轮，看稳定度（第一轮常受样本影响，第二轮才是常态）
    s6 = await say(s6, luo6, '（我往旁边挪了半步，把伞收好。）', [luo6, chu6])
    const reply6b = s6.messages[s6.messages.length - 1]?.content ?? ''
    const b6 = auditFormat(reply6b)
    console.log(`[实弹观察·第 2 轮] 行分布：动作（）${b6.action} · 环境【】${b6.env} · 对白 ${b6.talk}`)
    console.log(`[实弹观察·第 2 轮] 违规项：${b6.issues.length ? '⚠️ ' + b6.issues.join(' | ') : '✓ 无'}`)
  }

  // ---------- 阶段 1：会话 A 聊出可被记住的事实 ----------
  console.log('\n' + '='.repeat(70))
  console.log('▶ 阶段 1 · 会话 A：聊出事实（自我暴露 + 养了只猫）')
  console.log('='.repeat(70))
  let a = await store.createFreeSession([char.id], '夜里便利店', { providerId: pick.provider.id }, {})
  a = await say(a, char, '（我推门进来，抖了抖伞上的水）还是老样子啊。')
  a = await say(a, char, '我叫陈默，做后期的，最近天天加班到这个时候。')
  a = await say(a, char, '家里那只猫叫阿灰，今天把我杯子打碎了，气死我了。')

  const { system: sysA } = await buildFreeSystem(a, [char])
  console.log(`\n[上下文检查] 首轮 system ${sysA.length} 字 · 含角色卡 ${sysA.includes('外冷内热') ? '✓' : '✗'} · 含协议 ${sysA.includes('最后提醒') ? '✓' : '✗'}`)

  // ---------- 阶段 2：总结成六栏记忆 ----------
  console.log('\n' + '='.repeat(70))
  console.log('▶ 阶段 2 · 总结（真实模型 + 六栏解析）')
  console.log('='.repeat(70))
  const pending = messagesAfterWatermark(a.messages, a.watermark)
  console.log(`待总结消息：${pending.length} 条`)
  const t0 = Date.now()
  const mem = await summarizeMemory({
    charId: char.id,
    charName: char.name,
    prev: await store.getMemory(char.id),
    messages: pending,
    charContext: [
      `世界：${char.world}`,
      `内核：${char.profile.core}`,
      `做不到的事：${char.profile.cannot}`,
      `知识边界：${char.profile.knowledge}`,
    ].join('\n'),
  })
  await store.saveMemory(mem)
  const wm = nextWatermark(a)
  a = await store.saveFreeSession({ ...a, watermark: wm ?? a.watermark })
  console.log(`耗时 ${Date.now() - t0} ms · 合计 ${memoryChars(mem)} 字\n`)
  console.log(memoryToText(mem))

  // ---------- 阶段 3：新建会话 B（无原文）问记忆 ----------
  console.log('\n' + '='.repeat(70))
  console.log('▶ 阶段 3 · 新会话 B（**没有任何原文**，只有角色级记忆）')
  console.log('='.repeat(70))
  let b = await store.createFreeSession([char.id], '第二天', { providerId: pick.provider.id }, {})
  const { system: sysB } = await buildFreeSystem(b, [char])
  console.log(`B 的 system ${sysB.length} 字 · 含长期记忆块 ${sysB.includes('〖长期记忆 · 苏念〗') ? '✓' : '✗'}`)

  const reply = await say(b, char, '（我把伞收好）你还记得我家那只猫吗？')

  // ---------- 判定 ----------
  const last = reply.messages.filter(m => m.role === 'assistant').at(-1)?.content ?? ''
  console.log('\n' + '='.repeat(70))
  console.log('▶ 判定：记忆是否真的被用上')
  console.log('='.repeat(70))
  const knowsCat = /阿灰/.test(last)
  const knowsMe = /陈默/.test(last)
  console.log(`  新会话里提到「阿灰」：${knowsCat ? '✅ 是 —— 记忆闭环成立' : '❌ 否'}`)
  console.log(`  新会话里记得「陈默」：${knowsMe ? '✅ 是' : '（这一轮没提到，不算失败）'}`)
  console.log(`  记忆字数：${memoryChars(mem)}（软上限 1200）`)
  console.log(`  六栏解析：${MEMORY_SECTIONS.filter(s => String(mem[s.key] ?? '').trim()).length} / 6 栏非空`)
  console.log('\n实弹验证结束。')
}

main().catch(e => {
  console.log('\n❌ 实弹验证失败：', e?.message ?? e)
  if (e?.stack) console.log(String(e.stack).split('\n').slice(0, 8).join('\n'))
  process.exitCode = 1
})
