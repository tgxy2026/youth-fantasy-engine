// 酒馆模式 · 实弹测试（**手动运行**，不进全量回归）
//
// 用途：用**真实配置的模型**跑一遍剧情模式，看链路在真实网络 / 真实模型下通不通，
//       以及模型输出是否符合协议 —— 这是单测覆盖不到的一层。
//
// 用法：
//   node tests/build-test.mjs live-tavern                     # 完整实弹（联网 + 本地，会消耗少量额度）
//   YFE_LIVE_SKIP=1 node tests/build-test.mjs live-tavern     # 只做离线检查（组装 system，不调模型）
//
// 命名刻意**不叫 *.test.ts** —— 那样会被 run-all.mjs 自动纳入全量回归，导致每次
// `npm run verify` 都真联网烧额度。build-test.mjs 已支持直接传 .ts 文件名。
//
// 安全：模型配置（含 apiKey）在运行时从桌面版数据文件读取，**不写入任何文件、不打印**。
import fs from 'fs'
import * as db from '../src/lib/db'
import * as store from '../src/lib/tavern/store'
import { createDemoProject } from '../src/lib/seedData'
import { __resetMockStores } from './mock-memory'
import { saveProviders, saveActiveId, type AIProvider } from '../src/lib/ai'
import { buildPlotSystem, runPlotTurn } from '../src/lib/tavern/engine'
import { generateReport } from '../src/lib/tavern/report'
import { PROTOCOL_CORE } from '../src/lib/tavern/protocol'
import type { TavernSession } from '../src/lib/tavern/types'

const DATA = 'C:/Users/18223/AppData/Roaming/novel-studio/novel-studio-data.json'
/** 置 1 则只做离线检查（不调模型、不烧额度） */
const SKIP_NET = process.env.YFE_LIVE_SKIP === '1'

function loadRealProviders(): AIProvider[] {
  const meta = JSON.parse(fs.readFileSync(DATA, 'utf8')).stores.meta
  const raw = meta.aiProviders?.value ?? meta.aiProviders
  return Array.isArray(raw) ? raw : []
}

/** 挑一个本地真实存在的模型：配置里写的那个可能已被删、或从没 pull 成功 */
async function pickLocalModel(configured: string): Promise<{ model: string; note: string }> {
  try {
    const r = await fetch('http://localhost:11434/api/tags')
    const j = (await r.json()) as { models?: { name: string }[] }
    const names = (j.models ?? []).map(m => m.name)
    if (names.length === 0) return { model: configured, note: '（Ollama 里没有任何模型）' }
    if (names.includes(configured)) return { model: configured, note: '' }
    const prefer = names.find(n => /uncensored|abliterated/i.test(n)) ?? names.find(n => !/embed/i.test(n)) ?? names[0]
    return { model: prefer, note: `（配置里的「${configured}」本地不存在，本次改用「${prefer}」）` }
  } catch {
    return { model: configured, note: '（Ollama 未响应，跳过本地场景）' }
  }
}

let anchorId = ''
let anchorLabel = ''

async function prepare() {
  const providers = loadRealProviders()
  if (providers.length === 0) throw new Error('数据文件里没有模型配置')

  __resetMockStores()
  // 〖关键〗把真实配置写进（内存）存储 —— 否则 resolveTavernProvider 读不到，
  // 会回退到 requireActiveProvider 并直接抛「尚未配置可用模型」
  await saveProviders(providers)
  await saveActiveId(providers[0].id)

  const pid = await createDemoProject()
  db.setCurrentProject(pid)

  const chs = await db.getAllChapters()
  const anchor = chs[1]
  anchorId = anchor.id
  anchorLabel = anchor.title

  const main = (await db.getCardRecords('char-main'))[0]
  const secondary = await db.getCardRecords('char-secondary')
  const xiao = secondary.find(r => r.name === '萧景行') ?? secondary[0]
  // 「全 AI 扮演」那一场要两个 AI 角色，另找一个次要角色
  const other = secondary.find(r => r.id !== xiao.id) ?? xiao

  // 给 AI 演的角色填一份扮演设定（验证它真影响输出）
  await store.saveCastSetting(xiao.id, {
    voice: '话少，句子短，不用感叹号。被逼急了才会一次说长句',
    address: '叫对方「师弟」',
    unknown: '不知道陈渊体内有塔、也不知道他当夜觉醒的事',
    taboo: '被提到自己出身（庶出）会沉默，然后转开话题',
    care: '在意别人质疑他的天资',
    never: '绝不会主动示弱，也绝不会失态',
  })

  return { providers, main, xiao, other }
}

function mkSession(providerId: string, main: { id: string; name: string }, xiao: { id: string; name: string }): TavernSession {
  return {
    id: 'live-1',
    title: '实弹测试 · 雨夜偏院',
    mode: 'immersive',
    anchorChapterId: anchorId,
    anchorChapterLabel: anchorLabel,
    cast: [
      { cardId: main.id, role: 'user', tabId: 'char-main', name: main.name },
      { cardId: xiao.id, role: 'ai', tabId: 'char-secondary', name: xiao.name },
    ],
    scene: { place: '青岚宗外门偏院', time: '入夜', present: [main.name, xiao.name], description: '雨刚停，廊下积水映着灯笼' },
    messages: [
      {
        id: 'm0',
        role: 'user',
        content: '地点：青岚宗外门偏院 · 时间：入夜 · 在场：陈渊、萧景行\n雨刚停，廊下积水映着灯笼。\n（我握着扫帚站在檐下，看见他撑伞走进院子）',
        at: Date.now(),
      },
    ],
    model: { providerId },
    params: { contextBudget: 32000 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * 无「你演」角色的会话：整场交给 AI（2026-09-14 新增能力，必须实弹验证）。
 * 两个 AI 角色 → 身份层应带「一次只让其中一个说话」的多角色规则，
 * 且**不该**出现「用户扮演」「不要代写」这类只在有你演角色时才成立的语句。
 */
function mkAiOnlySession(
  providerId: string,
  a: { id: string; name: string },
  b: { id: string; name: string },
): TavernSession {
  return {
    id: 'live-2',
    title: '实弹测试 · 全 AI 扮演（无用户角色）',
    mode: 'immersive',
    anchorChapterId: anchorId,
    anchorChapterLabel: anchorLabel,
    cast: [
      { cardId: a.id, role: 'ai', tabId: 'char-secondary', name: a.name },
      { cardId: b.id, role: 'ai', tabId: 'char-secondary', name: b.name },
    ],
    scene: { place: '青岚宗外门偏院', time: '入夜', present: [a.name, b.name], description: '雨刚停，两人在廊下对站' },
    messages: [
      {
        id: 'm0',
        role: 'user',
        content: `地点：青岚宗外门偏院 · 时间：入夜 · 在场：${a.name}、${b.name}\n雨刚停，廊下积水映着灯笼。`,
        at: Date.now(),
      },
    ],
    model: { providerId },
    params: { contextBudget: 32000 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function runOne(label: string, s: TavernSession, userText = '（我点了点头，没有立刻答话，等他先开口。）') {
  console.log('\n' + '='.repeat(72))
  console.log(`▶ 场景：${label}`)
  console.log('='.repeat(72))

  const t0 = Date.now()
  let firstAt = 0
  let chunks = 0
  const phases: string[] = []

  try {
    const res = await runPlotTurn(s, userText, {
      onToken: () => { chunks++; if (!firstAt) firstAt = Date.now() - t0 },
      onPhase: p => phases.push(p),
    })

    const cost = Date.now() - t0
    console.log(`模型：${res.modelName}${res.fellBack ? '（⚠️ 回退了全局模型）' : ''}`)
    console.log(`阶段：${phases.join(' → ')}`)
    console.log(`耗时：${cost} ms · 首字：${firstAt || '(非流式)'} ms · 流式分片：${chunks}`)
    console.log(`回复长度：${res.reply.length} 字`)
    console.log('--- 模型输出 ---')
    console.log(res.reply || '(空)')
    console.log('--- 输出自检（协议 O1） ---')
    console.log(`  含半角括号（要求全角）：${/\(|\)/.test(res.reply) ? '⚠️ 有' : '✓ 无'}`)
    console.log(`  引号包裹对白：${/“|”|"/.test(res.reply) ? '⚠️ 有' : '✓ 无'}`)
    console.log(`  篇幅：${res.reply.length} 字（协议建议 60–160）${res.reply.length > 400 ? ' ⚠️ 偏长' : ''}`)
    console.log(`  疑似代写作者角色：${/(（陈渊|陈渊说)/.test(res.reply) ? '⚠️ 有' : '✓ 未见'}`)
    // v1.2：【】是**客观描写**的合法标记，不能再当「误用结构标记」来判；改判两件真事：
    // ① 对白行不该带「名字：」前缀、也不该把名字单独成行（示例里的〖对方〗是输入侧标注，不许写进输出）；
    // ② 输入侧的〖〗与〈〉绝不该出现在输出里。
    console.log(`  输出里混进输入侧标记（〖〗〈〉）：${/〖|〗|〈|〉/.test(res.reply) ? '⚠️ 有' : '✓ 无'}`)
    console.log(`  对白行带名字前缀：${/^[^\n（【〔]{1,6}[：:]\S*/m.test(res.reply) ? '⚠️ 有（人工看上面输出）' : '✓ 无'}`)
    console.log(`  用了客观描写【】：${/【/.test(res.reply) ? '✓ 有（人工核对该行是环境/外在）' : '（这轮没写环境，不算错）'}`)

    const saved = await store.saveSession(res.session)
    console.log(`  落库：会话 ${saved.id} · 消息 ${saved.messages.length} 条`)
    return saved
  } catch (e) {
    console.log(`❌ 该场景失败：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

async function runReport(s: TavernSession) {
  console.log('\n' + '='.repeat(72))
  console.log('▶ 结束推演 → 生成报告（真实模型）')
  console.log('='.repeat(72))
  const t0 = Date.now()
  try {
    const rep = await generateReport(s, { onPhase: p => console.log(`  阶段：${p}`) })
    console.log(`耗时：${Date.now() - t0} ms`)
    console.log('--- 概览 ---')
    console.log(rep.overview)
    console.log(`--- 问题清单（${rep.findings.length} 条） ---`)
    for (const f of rep.findings) {
      console.log(`  [${f.level}] ${f.targetTabId}${f.targetLabel ? ' / ' + f.targetLabel : ''}${f.targetRecordId ? ' → id=' + f.targetRecordId : ' → （未定位）'}`)
      console.log(`      ${f.detail}`)
      if (f.suggestion) console.log(`      建议：${f.suggestion}`)
    }
    const located = rep.findings.filter(f => f.targetRecordId).length
    console.log(`  可定位回真实条目：${located} / ${rep.findings.length}`)
    await store.saveReport(rep)
    console.log(`  报告落库：${(await store.listReports()).length} 份`)
  } catch (e) {
    console.log(`❌ 报告生成失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  const { providers, main, xiao, other } = await prepare()
  console.log('=== 读到真实模型配置 ===')
  providers.forEach(p => console.log(`  ${p.name} · ${p.type} · ${p.model} · key=${p.apiKey ? '已配置' : '无'}`))
  if (SKIP_NET) console.log('\n（YFE_LIVE_SKIP=1：只做离线检查，不调模型）')

  const online = providers.find(p => p.type === 'openai')
  const local = providers.find(p => p.type === 'ollama')

  // 先看一次真实 system（离线，不花钱），确认防剧透与扮演设定到位
  const probe = mkSession(online?.id ?? providers[0].id, main, xiao)
  const { system, settingChars, dropped } = await buildPlotSystem(probe)
  console.log('\n=== system 组装（离线，不调模型） ===')
  console.log(`  设定层 ${settingChars} 字 · system 总长 ${system.length} 字 · 被裁段落 ${dropped.length ? dropped.join('、') : '无'}`)
  console.log(`  含扮演设定：${system.includes('〖扮演设定 · 萧景行〗') ? '✓' : '✗'}`)
  console.log(`  含作者侧字段（结局归宿/隐藏设定…）：${/结局归宿|隐藏设定|演变轨迹/.test(system) ? '⚠️ 有' : '✓ 无'}`)
  console.log(`  协议在末尾：${system.trimEnd().endsWith(PROTOCOL_CORE.trimEnd()) ? '✓' : '✗'}`)
  console.log(`  身份提示含「不要代写」：${system.includes('不要代写') ? '✓' : '✗'}`)

  // 全 AI 扮演那一场：身份层该变的样子（离线断言，不花钱）
  const aiOnlyProbe = mkAiOnlySession(online?.id ?? providers[0].id, xiao, other)
  const aiOnlySys = (await buildPlotSystem(aiOnlyProbe)).system
  console.log('\n=== system 组装 · 无用户角色（全 AI 扮演） ===')
  console.log(`  不含「用户扮演」（没有你演的角色时不出现）：${aiOnlySys.includes('用户扮演') ? '⚠️ 有' : '✓ 无'}`)
  console.log(`  改为「全部由你推进」：${aiOnlySys.includes('全部由你推进') ? '✓' : '✗'}`)
  console.log(`  不含「不要代写」：${aiOnlySys.includes('不要代写') ? '⚠️ 有' : '✓ 无'}`)
  console.log(`  含多角色发言规则：${aiOnlySys.includes('一次只让其中一个说话') ? '✓' : '✗'}`)
  console.log(`  含两个 AI 角色名：${aiOnlySys.includes(xiao.name) && aiOnlySys.includes(other.name) ? '✓' : '✗'}`)

  if (SKIP_NET) {
    console.log('\n离线检查结束（未消耗额度）。')
    return
  }

  if (online) {
    const s = await runOne(`联网 · ${online.model}（流式）`, mkSession(online.id, main, xiao))
    if (s) await runReport(s)

    console.log('\n（下一场：没有「你演」的角色，整场由 AI 扮演 —— 验证新路径）')
    await runOne(
      `联网 · ${online.model} · 全 AI 扮演`,
      mkAiOnlySession(online.id, xiao, other),
      '（旁白：远处更鼓敲了三下。廊下的两人都没动。）',
    )
  }

  if (local) {
    const pick = await pickLocalModel(local.model)
    console.log(`\n本地模型：${pick.note || `使用「${pick.model}」`}`)
    if (!pick.note.includes('未响应') && !pick.note.includes('没有任何模型')) {
      // 用实际存在的模型覆盖内存里的那份配置（runPlotTurn 内部会重新 loadProviders）
      await saveProviders(providers.map(p => (p.id === local.id ? { ...p, model: pick.model } : p)))
      await runOne(`本地 Ollama · ${pick.model}（流式）`, mkSession(local.id, main, xiao))
    }
  }

  console.log('\n实弹测试结束。')
}

main().catch(e => {
  console.log('\n❌ 实弹测试失败：', e?.message ?? e)
  if (e?.stack) console.log(String(e.stack).split('\n').slice(0, 8).join('\n'))
  process.exitCode = 1
})
