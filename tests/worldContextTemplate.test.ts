// ============ 3.2.0 · WT0-4：世界上下文的字段名改走「有效模板」 ============
//
// 起因（方案 §3.10.3）：`buildWorldContext` 里的字段名是**硬编码白名单**。
// 作者用「字段显示名」把「世界名称」改成「世界称呼」之后，喂给模型的还是旧名 ——
// 模型按旧名理解和回填，改名等于白改。
//
// 本测试钉四件事：
//   ① 没有别名时，输出与**旧口径逐字一致**（回归保护：不许顺手改格式）；
//   ② 起了别名 ⇒ 输出用**当前显示名**，但**存储键一个字节都不动**（列名即存储键，碰了数据全丢）；
//   ③ 🔴 丢值回归：数据键的模块前缀与当前 schema 不一致（题材包换过 / 历史脏键）时，
//      必须退回全表扫描把值捞回来 —— 本轮实机测试抓到过：只认模板键 ⇒ 作者填好的内容凭空消失；
//   ④ 空数据 / 分组过滤等既有行为不变。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { invalidateAliasCache, saveAliases } from '../src/lib/settings/fieldAlias'
import { buildWorldContext, WORLD_CONTEXT_GROUPS } from '../src/lib/ai'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

/** 旧口径（迁移前的实现）逐字复刻 —— ① 的对照组 */
function legacyPick(data: Record<string, string> | undefined, names: string[]): string[] {
  if (!data) return []
  const out: string[] = []
  for (const n of names) {
    const hit = Object.entries(data)
      .map(([k, v]) => (k.endsWith(`::${n}`) || k === n ? v : ''))
      .find(Boolean)
    if (hit && hit.trim()) out.push(`${n}：${hit.trim()}`)
  }
  return out
}

async function main() {
  __resetMockStores()

  // ───────── ① 无别名 ⇒ 与旧口径逐字一致 ─────────
  {
    __resetMockStores()
    invalidateAliasCache()
    await db.saveFormData('worldbase', {
      '一、世界总览::世界名称': '九霄界',
      '一、世界总览::一句话世界观': '神族封天，人族不知',
      '一、世界总览::文明程度': '修行文明',
    })
    await db.saveFormData('power', { '一、体系::体系名称': '玄脉体系' })
    await db.saveFormData('positioning', { '一、作品::书名': '吞天神脉' })

    const got = await buildWorldContext()
    const byTab: Record<string, Record<string, string> | undefined> = {
      worldbase: await db.getFormData('worldbase'),
      power: await db.getFormData('power'),
      positioning: await db.getFormData('positioning'),
    }
    const want = WORLD_CONTEXT_GROUPS.flatMap(g => legacyPick(byTab[g.tabId], g.names)).join('\n')
    ok('🔴 无别名时与旧口径逐字一致', got === want, `\n got =${JSON.stringify(got)}\n want=${JSON.stringify(want)}`)
    ok('对照组有效（确实抽到了内容）', got.includes('九霄界') && got.includes('玄脉体系') && got.includes('吞天神脉'))
    ok('🔴 白名单字段名与 schema 一致（改名后不会静默取空）',
      got.includes('世界名称：') && got.includes('体系名称：') && got.includes('书名：'), got)
  }

  // ───────── ② 别名进显示名，存储键不动 ─────────
  {
    __resetMockStores()
    invalidateAliasCache()
    await db.saveFormData('worldbase', { '一、世界总览::世界名称': '九霄界' })
    await saveAliases('worldbase', ['一、世界总览::世界名称'], { '一、世界总览::世界名称': '世界称呼' })

    const got = await buildWorldContext(['worldbase'])
    ok('🔴 别名改名 ⇒ 输出用当前显示名', got.includes('世界称呼：九霄界'), got)
    ok('🔴 不再出现旧名字面量', !got.includes('世界名称'), got)
    // 🔴 存储键没被改写 ⇒ 原 key 下的数据照原样躺在库里
    const raw = await db.getFormData('worldbase')
    ok('🔴 存储键一个字节都没动', Object.keys(raw ?? {}).includes('一、世界总览::世界名称'))
    invalidateAliasCache()
  }

  // ───────── ③ 🔴 丢值回归：数据键前缀与 schema 不一致 ─────────
  {
    __resetMockStores()
    invalidateAliasCache()
    // 模拟「题材包换过 / 老数据模块名不同」：schema 现在是 `一、世界总览::世界名称`，
    // 库里却是 `老模块名::世界名称`。
    await db.saveFormData('worldbase', { '老模块名::世界名称': '旧题材包的值' })

    const got = await buildWorldContext(['worldbase'])
    ok('🔴 前缀不同时也把值捞回来了（走全表扫描兜底）', got.includes('世界名称：旧题材包的值'), got)
    ok('🔴 兜底时仍用模板的当前显示名，不退回脏键', !got.includes('老模块名'), got)
  }

  // ───────── ④ 既有行为不变 ─────────
  {
    __resetMockStores()
    invalidateAliasCache()
    ok('库里没数据 ⇒ 空串（不抛）', (await buildWorldContext()) === '')
    await db.saveFormData('worldbase', { '一、世界总览::世界名称': '甲' })
    await db.saveFormData('power', { '一、体系::体系名称': '乙' })
    await db.saveFormData('positioning', { '一、作品::书名': '丙' })
    const only = await buildWorldContext(['positioning'])
    ok('分组过滤：只要作品信息 ⇒ 不含另两组', only.includes('丙') && !only.includes('甲') && !only.includes('乙'), only)
    ok('空数组 = 全带（与不传同义）', (await buildWorldContext([])) === (await buildWorldContext()))
  }

  // ───────── ⑤ 源码闸：显示名走模板，但取值必须保留全表扫描兜底 ─────────
  //
  // 只会"看得见"的闸（①~④）守不住"下次有人图省事只认模板键"。
  // 这里按老规矩断言**调用了什么函数**，不认字面参数 —— 搬代码的人才会被拦住。
  {
    const src = readFileSync(path.join(process.cwd(), 'src/lib/aiCore/template.ts'), 'utf8')
    ok('🔴 源码：buildWorldContext 走有效模板', src.includes('resolveTemplateCached'))
    ok('🔴 源码：显示名取当前别名', src.includes('loadAliases'))
    ok('🔴 源码：模板键取不到时退回全表扫描（防丢值）', /const scan = /.test(src) && /scan\(/.test(src))
    ok('🔴 源码：不再自己拼死名字（白名单只用于「取哪些字段」）',
      /out\.push\(`\$\{f \? f\.label : n\}：/.test(src), '输出行应优先用模板 label')
  }

  console.log(`\nworldContextTemplate: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
