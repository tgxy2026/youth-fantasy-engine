// ============ AI 用途路由（2.8.0 · 台账 #014）============
//
// 三用途（创作 / 审校 / 整理）各存一个 providerId 引用，留空 = 跟随当前模型。
// 本用例盯四件事：
//   ① 🔴 **三格全空 ⇒ 解析结果 === 当前模型** —— 这是「升级零行为变化」的保证；
//   ② 指定 ⇒ 解析到指定模型（且不影响其它用途）；
//   ③ 指定但模型已被删除 ⇒ **回落当前模型、不抛错**（宁可退回去，也不让按钮变灰）；
//   ④ 读不写库、写后回读一致、rolesOf 归属正确。
import * as db from '../src/lib/db'
import {
  TASK_ROLES, ROLE_LABEL, ROLE_HINT, DEFAULT_ROUTING,
  loadRouting, saveRouting, resolveProviderFor, requireProviderFor, rolesOf,
} from '../src/lib/ai/aiRouting'
import { getActiveProvider, type AIProvider } from '../src/lib/ai'
import { __resetMockStores } from './mock-memory'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const P = (id: string, model: string): AIProvider => ({
  id, name: id, type: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '',
  model, local: true, contextWindow: 32768,
})

async function seed(providers: AIProvider[], activeId: string | null) {
  await db.setMeta('aiProviders', providers)
  await db.setMeta('aiActiveProviderId', activeId)
  await db.setMeta('aiConfigMigratedToGlobal', true)
}

async function main() {
  // ---------- ① 空库：出厂值 + 读无副作用 ----------
  {
    __resetMockStores()
    const r = await loadRouting()
    ok('空库读路由 = 出厂（三格全空）', TASK_ROLES.every(x => r[x] === ''), JSON.stringify(r))
    ok('读路由不写库（读操作不该有副作用）', (await db.getMeta<unknown>('aiRouting', null)) === null)
  }

  // ---------- ② 🔴 三格全空 ⇒ 解析 = 当前模型（零行为变化）----------
  {
    __resetMockStores()
    await seed([P('a', 'm-a'), P('b', 'm-b')], 'b')
    const cur = await getActiveProvider()
    ok('前置：当前模型解析为 b', cur?.id === 'b', cur?.id)
    for (const role of TASK_ROLES) {
      const got = await resolveProviderFor(role)
      ok(`🔴 ${ROLE_LABEL[role]}留空 ⇒ 解析到当前模型`, got?.id === cur?.id, `${got?.id} vs ${cur?.id}`)
    }
  }

  // ---------- ③ 指定 ⇒ 解析到指定模型（互不影响）----------
  {
    __resetMockStores()
    await seed([P('a', 'm-a'), P('b', 'm-b')], 'a')
    await saveRouting({ create: 'b', review: '', utility: '' })
    const c = await resolveProviderFor('create')
    ok('创作指定 b ⇒ 解析到 b', c?.id === 'b', c?.id)
    const rv = await resolveProviderFor('review')
    ok('审校留空 ⇒ 仍回落当前 a（指定某一用途不波及其它）', rv?.id === 'a', rv?.id)
  }

  // ---------- ④ 🔴 指定但已被删除 ⇒ 回落当前模型、不抛 ----------
  {
    __resetMockStores()
    await seed([P('a', 'm-a')], 'a')
    await saveRouting({ create: 'ghost', review: '', utility: '' })
    const c = await resolveProviderFor('create')
    ok('🔴 指定了不存在的模型 ⇒ 回落当前模型', c?.id === 'a', c?.id)
    let threw = false
    try { await requireProviderFor('create') } catch { threw = true }
    ok('🔴 有可回落模型时不抛错', !threw)
  }

  // ---------- ⑤ 一个模型都没有 ⇒ 抛出统一中文提示 ----------
  {
    __resetMockStores()
    await seed([], null)
    let msg = ''
    try { await requireProviderFor('utility') } catch (e) { msg = e instanceof Error ? e.message : String(e) }
    ok('无任何可用模型 ⇒ 抛出中文提示（供界面直接显示）', msg.includes('尚未配置可用的 AI 模型'), msg)
  }

  // ---------- ⑥ 写：归一 + 回读一致 + 不落 undefined ----------
  {
    __resetMockStores()
    const out = await saveRouting({ create: 'x', review: '', utility: '' })
    ok('saveRouting 回执已归一', out.create === 'x' && out.review === '' && out.utility === '')
    const r = await loadRouting()
    ok('保存后回读一致', r.create === 'x' && r.review === '' && r.utility === '')
    const raw = await db.getMeta<Record<string, unknown> | null>('aiRouting', null)
    ok('落库对象三键齐全且都是字符串（不存 undefined / 空洞）',
      !!raw && TASK_ROLES.every(x => typeof raw[x] === 'string'), JSON.stringify(raw))
  }

  // ---------- ⑦ rolesOf：归属查询 ----------
  {
    const rt = { create: 'a', review: 'b', utility: 'a' }
    ok('rolesOf：a 被创作与整理引用', rolesOf(rt, 'a').join() === 'create,utility', rolesOf(rt, 'a').join())
    ok('rolesOf：b 只被审校引用', rolesOf(rt, 'b').join() === 'review', rolesOf(rt, 'b').join())
    ok('rolesOf：未被引用 ⇒ 空数组', rolesOf(rt, 'z').length === 0)
    ok('出厂路由 ⇒ rolesOf 对任何 id 恒空（不会误标用途徽标）',
      TASK_ROLES.every(x => rolesOf(DEFAULT_ROUTING, x).length === 0))
  }

  // ---------- ⑧ 元信息自洽（界面直接用这三张表）----------
  {
    ok('三用途各有非空显示名', TASK_ROLES.every(x => ROLE_LABEL[x].trim().length > 0))
    ok('三用途各有非空提示语', TASK_ROLES.every(x => ROLE_HINT[x].trim().length > 5))
    ok('出厂路由键集合与 TASK_ROLES 一致（漏一个 ⇒ 设置页少一行）',
      Object.keys(DEFAULT_ROUTING).sort().join() === [...TASK_ROLES].sort().join(),
      Object.keys(DEFAULT_ROUTING).join())
  }

  // ---------- ⑨ 🔴 调用点归属（源码断言，防回滚）----------
  // 迁移最容易悄悄破掉的地方：某天有人图省事把某个调用点改回 `requireActiveProvider()` ——
  // 不报错、功能照跑，只是路由对那个功能**静默失效**。这里按文件把它钉住。
  {
    const SRC = fs.existsSync(path.join(process.cwd(), 'src'))
      ? path.join(process.cwd(), 'src')
      : path.join(process.cwd(), '..', 'src')
    const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
    const CASES: [string, string][] = [
      ['lib/outline/autoContinue.ts', 'create'],
      ['lib/aiTasks/creative.ts', 'create'],
      ['lib/aiTasks/inspiration.ts', 'create'],
      ['lib/aiTasks/rewrite.ts', 'create'],
      ['lib/aiTasks/inline.ts', 'create'],
      ['lib/aiCore/template.ts', 'create'],
      ['lib/aiTasks/jieWenJi.ts', 'review'],
      ['lib/aiTasks/audit.ts', 'review'],
      ['lib/aiTasks/pace.ts', 'review'],
      ['lib/aiTasks/readerProbe.ts', 'review'],
      ['lib/aiTasks/proofread.ts', 'review'],
      ['lib/aiTasks/organize.ts', 'utility'],
      ['lib/aiTasks/tableImport.ts', 'utility'],
      ['lib/aiTasks/extract.ts', 'utility'],
      ['lib/aiTasks/formSummary.ts', 'utility'],
      ['lib/aiTasks/suggest.ts', 'utility'],
      ['lib/aiTasks/bookBreakSplit.ts', 'utility'],
    ]
    for (const [f, role] of CASES) {
      const t = read(f)
      ok(`🔴 ${f} 走「${role}」路由`,
        t.includes(`requireProviderFor('${role}')`) && !t.includes('requireActiveProvider()'), f)
    }
    // 酒馆链路必须**保持**走全局活动模型 —— 它有「会话 → 面板 → 全局」三层兜底与专用就绪判据，
    // 被用途路由污染会破坏那套语义（老大 2026-10-04 已拍板酒馆口径保持不变）。
    ok('🔴 酒馆链路仍走 requireActiveProvider（不被用途路由污染）',
      read('lib/tavern/provider.ts').includes('requireActiveProvider()'))
  }

  console.log('')
  console.log(`共 ${pass + fail} 条：PASS ${pass} · FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
