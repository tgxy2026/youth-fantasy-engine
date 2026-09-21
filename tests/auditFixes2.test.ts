// ============ 六维审计 P1 / P2 修复的收口护栏（2026-09-20） ============
//
// 这批修的都是"**静默**"类缺陷：不报错、界面照常，只是数据/状态悄悄不对。
// 所以每条都要有判据 —— 能上纯函数行为测的就上行为测，接线性质用源码位置断言。
import fs from 'node:fs'
import path from 'node:path'
import { isPortableDataFile } from '../src/lib/storeOps'
import { emptyMemory, trimMemory } from '../src/lib/tavern/memory'
import { FACTS_MAX_LINES } from '../src/lib/tavern/types'

const ROOT = process.cwd()
const read = (rel: string) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— auditFixes2 用例开始 ——')

// ---------- ① P1-2 行为：数据文件身份校验（挡住"误放的合法 JSON 被当空库覆盖写"） ----------
{
  ok('🔴 本软件写出的数据文件 → 认',
    isPortableDataFile({ app: 'novel-studio', kind: 'portable-data', stores: {} }))
  ok('🔴 缺 kind 的任意合法 JSON → 不认（这就是"误放文件被当空库、随后覆盖真实文件"的那条路）',
    !isPortableDataFile({ foo: 1, bar: [1, 2, 3] }))
  ok('kind 不对 → 不认', !isPortableDataFile({ app: 'novel-studio', kind: 'something-else' }))
  ok('非对象（数组 / null / 字符串）→ 不认',
    !isPortableDataFile([1, 2]) && !isPortableDataFile(null) && !isPortableDataFile('{}'))
  // 不因历史文件缺 app 就锁死用户
  ok('缺 app 但有 kind → 认（老数据文件不能被锁死）',
    isPortableDataFile({ kind: 'portable-data' }))
}

// ---------- ② P2-⑪ 行为：facts / mines 的硬上限兜底 ----------
{
  const many = Array.from({ length: 20 }, (_, i) => `第${i + 1}条事实`).join('\n')
  const m = { ...emptyMemory('c-test'), facts: many, mines: many }

  // 未超硬上限：**一行都不许裁**（提示词里的 12 行只是"请模型自己归并"的建议值）
  const loose = trimMemory(m, { hardLimit: 100000, longTermLimit: 100000, diaryDays: 100 })
  ok('🔴 总量没超硬上限时**不裁** facts / mines（哪怕行数已经超过 FACTS_MAX_LINES）',
    loose.facts.split('\n').length === 20 && loose.mines.split('\n').length === 20,
    `facts ${loose.facts.split('\n').length} 行`)

  // 超硬上限：前面四栏压完还超，才轮到 facts / mines，且只留最后 N 行
  const tight = trimMemory(m, { hardLimit: 60, longTermLimit: 40, diaryDays: 3 })
  const factsLines = tight.facts.split('\n').filter(Boolean).length
  ok('🔴 压完其它栏仍超硬上限 ⇒ facts 被兜底到 FACTS_MAX_LINES 行',
    factsLines === FACTS_MAX_LINES, `${factsLines} 行（期望 ${FACTS_MAX_LINES}）`)
  ok('  · 保留的是**最后** N 行（越新的事实越可能被当前剧情引用）',
    tight.facts.includes('第20条事实') && !tight.facts.includes('第1条事实'),
    tight.facts.slice(0, 40))
}

// ---------- ③ P2-⑪ 结构：常量单一来源（不能在两处各写一个 12） ----------
{
  const types = read('src/lib/tavern/types.ts')
  const summarize = read('src/lib/tavern/summarize.ts')
  const memory = read('src/lib/tavern/memory.ts')
  ok('🔴 FACTS_MAX_LINES 只在 types.ts 定义一次',
    /export const FACTS_MAX_LINES = 12/.test(types)
    && !/export const FACTS_MAX_LINES = 12/.test(summarize)
    && !/const FACTS_MAX_LINES = 12/.test(memory))
  ok('summarize / memory 都从 types 取（summarize 保留 re-export 供旧 import 路径用）',
    /export \{ FACTS_MAX_LINES \}/.test(summarize) && /FACTS_MAX_LINES,/.test(memory))
}

// ---------- ④ P1-1 结构：关同步时的镜像必须有「删」这一半 ----------
{
  const core = read('src/lib/db/core.ts')
  ok('🔴 overwrite 分支同时做 put 与 delExtra（原来只 put ⇒ 同步期间删掉的记录关同步后复活）',
    /if \(overwrite\) \{[\s\S]{0,600}?bulkPut\(store, list\)[\s\S]{0,400}?mirrorDeleteExtra\(store, list\)/.test(core))
  ok('  · delExtra 读失败时不删（宁可多留一条，也不能因读失败误删）',
    /async function mirrorDeleteExtra[\s\S]{0,900}?catch \{/.test(core))
  ok('  · meta 的本地专属键在删除时被排除',
    /mirrorDeleteExtra[\s\S]{0,900}?isExcludedMetaKey/.test(core))
}

// ---------- ⑤ P1-3 结构：作者原文必须包 authorBlock ----------
{
  const cr = read('src/lib/aiTasks/creative.ts')
  ok('🔴 大纲规划的资料块走 authorBlock（资料里含作者已有细纲/卷大纲原文）',
    /from '\.\.\/promptGuard'/.test(cr) && /authorBlock\(newAuthorFence\(\), material\.trim\(\)\)/.test(cr))
}

// ---------- ⑥ P1-4 结构：酒馆「生成初版记忆」必须带 limits ----------
{
  const m = read('src/components/useTavernCardModel.ts')
  ok('🔴 coldStartMemory 收到 limits（不传就永远走内置 3000，面板那三个数是死的）',
    /memoryLimitsOf/.test(m) && /limits: \{ longTermLimit: lim\.longTermLimit, diaryDays: lim\.diaryDays, hardLimit: lim\.hardLimit \}/.test(m))
}

// ---------- ⑦ P1-5 结构：三个生成入口的 finally 都要判代次 ----------
{
  const ft = read('src/components/useFreeTurn.ts')
  const guards = (ft.match(/if \(abortRef\.current === ctrl\) \{/g) ?? []).length
  const guardBlocks = ft.match(/if \(abortRef\.current === ctrl\) \{[\s\S]{0,300}?\n\s{4,8}\}/g) ?? []
  ok('🔴 三个生成入口（send / reroll / assist）的 finally 都按代次复位',
    guards === 3, `实际 ${guards} 处`)
  ok('  · 三处复位都在 guard 块**内**（没有裸复位）',
    guardBlocks.length === 3 && guardBlocks.every(b => /abortRef\.current = null/.test(b)),
    `guard 块 ${guardBlocks.length} 个`)
}

// ---------- ⑧ P2-⑦⑧ 结构：两处"静默降级"都收口 ----------
{
  const core = read('src/lib/db/core.ts')
  const sc = read('src/lib/syncCore.ts')
  ok('🔴 读本机快照失败 ⇒ 抛错（不再 `.catch(() => [])` 静默当空）',
    /onDesktopLocalSnapshot\(async \(\) => \{[\s\S]{0,1200}?throw new Error\(`读取本机数据失败/.test(core)
    && !/getAll\(s\)\.catch\(\(\) => \[\]\)/.test(core))
  ok('🔴 拉取时读快照失败 ⇒ 在推进 rev **之前**中止（否则下次推送会拿旧 cache 覆盖云端）',
    /localSnapPre[\s\S]{0,400}?setStatus\('error'\)[\s\S]{0,200}?return[\s\S]{0,600}?rev = Number\(resp\.rev\)/.test(sc))
  ok('🔴 restoreFromCloudBackup / seedFromLocal 都检查 pushNow 的 conflict',
    (sc.match(/r\?\.conflict/g) ?? []).length >= 2, String((sc.match(/r\?\.conflict/g) ?? []).length))
}

// ---------- ⑨ P2-⑨⑩⑫ 结构：三处"不可区分 / 子串误判" ----------
{
  const re = read('src/lib/tavern/roundEnd.ts')
  ok('🔴 roundEnd 读旧档案失败 ⇒ 跳过该角色（不再降级 null 让退化保护失效）',
    /try \{\s*prev = await store\.getMemory\(c\.id\)\s*\} catch \{[\s\S]{0,300}?continue/.test(re)
    && !/getMemory\(c\.id\)\.catch\(\(\) => null\)/.test(re))

  const rv = read('src/lib/tavern/revise.ts')
  ok('🔴 设定审查：解析失败抛错（与"确实没有变更"区分开）',
    /未能解析成变更列表/.test(rv) && /throw new Error\('模型输出未能解析成变更列表/.test(rv))

  const rp = read('src/lib/tavern/report.ts')
  ok('🔴 否定判据放宽到"否定词出现在关键词前 6 字内"（「基本没有矛盾」不再被判成矛盾）',
    /\(无\|没有\|没\|未\|不\)\[\^，。；、\]\{0,6\}\(矛盾\|漏洞\|问题\)/.test(rp))
}

console.log(`\n—— auditFixes2 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
