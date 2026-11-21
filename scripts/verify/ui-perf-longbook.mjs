#!/usr/bin/env node
/**
 * 长书真机性能探针（3.6.2 · W4）
 *
 * 🔴 **状态：未调通（2026-11-21）。不要把它当成"可用的数字来源"。**
 *    已跑通的部分：起 dev server、独立 profile、造 40 章夹具（31ms）、首屏可交互、
 *    打开项目、保存。
 *    卡住的部分：**切章**。侧栏的章节树默认折叠，只渲染到「卷」这一层；
 *    点「章节总表」在探针里没能稳定到达章节列表，`getByText('第 N 卷 第 M 章')` 一直找不到。
 *    随后「保存」等待也超时（180s）。
 *    ⇒ 因此本版**没有产出任何 P50/P95 数字**，W4 的「连续 3 次波动 < 30%」也没验。
 *
 * 【下一步需要什么】界面上给章节行/卷头加稳定的 `data-*` 锚点（例如 `data-chapter-id`、
 *    `data-volume-id`），探针按 id 点而不是按可见文字匹配。按文字匹配的探针
 *    一旦标题格式改了就会"红得莫名其妙"，那不是产品退化。
 *
 * 【为什么仍要入库】造数、独立 profile、长任务收集这三段是可复用的；
 *   删掉等于下次从零再写一遍。保留 + 明确标注状态，比"假装它能跑"诚实。
 *
 * 【测什么（设计目标）】
 *   ① 首屏可交互（打开 → 侧栏/正文可用）
 *   ② 切章（首章 / 中段 / 末章，各 3 次，取 P50/P95）
 *   ③ 保存（改一个字 → 出现「已保存」）
 *   ④ 长任务计数与总时长（`longtask`，>50ms 的任务）
 *   ⑤ JS 堆（若 Chromium 给了 `performance.memory`）
 *   ⚠️ 规划里的「全文检索」「图鉴大表筛选」本版**未纳入**：那两个入口的 DOM 结构
 *      随页面改版变动，探针写死选择器会变成"一改就红"的假失败。留待单独一版做。
 *
 * 【隔离】🔴 绝不碰真实数据：
 *   · 独立 `--user-data-dir`（mkdtemp 临时目录，跑完删除）；
 *   · 数据写在**这个临时 profile 的 IndexedDB** 里，与作者平时用的浏览器 profile 无关；
 *   · 项目名带 `perf-longbook-<时间戳>`，即便误连也能一眼认出来。
 *
 * 用法：
 *   node scripts/verify/ui-perf-longbook.mjs                  # 默认 800 章（约 120 万字）
 *   node scripts/verify/ui-perf-longbook.mjs --chapters 120   # 小规模自检
 *   node scripts/verify/ui-perf-longbook.mjs --runs 3         # 切章重复次数（默认 3）
 *
 * ⚠️ 需要 Edge / Chrome（`channel: 'msedge'`）。没有的话装一个或改 `channel`。
 */
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const num = (name, def) => {
  const i = process.argv.indexOf(name)
  if (i < 0) return def
  const v = Number(process.argv[i + 1])
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} 需要正整数`)
  return Math.floor(v)
}

const CHAPTERS = num('--chapters', 800)
const RUNS = num('--runs', 3)
/** 每章约 1500 字 → 800 章约 120 万字 */
const CHARS_PER_CHAPTER = num('--chars', 1500)
const VOLUMES = Math.max(1, Math.round(CHAPTERS / 80))

const p50 = xs => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.floor((s.length - 1) * 0.5)])
}
const p95 = xs => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)])
}

let server = null
let ctx = null
const profileDir = await mkdtemp(path.join(ROOT, '.workbuddy/tmp/ui-perf-'))
const result = {
  kind: 'ui-perf-longbook',
  chapters: CHAPTERS,
  charsPerChapter: CHARS_PER_CHAPTER,
  totalChars: CHAPTERS * CHARS_PER_CHAPTER,
  volumes: VOLUMES,
  runs: RUNS,
  startedAt: new Date().toISOString(),
  steps: {},
  longTasks: { count: 0, totalMs: 0 },
  errors: [],
}

try {
  server = await createServer({
    root: ROOT,
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await server.listen()
  const url = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}`
  console.log(`dev server: ${url}`)

  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    viewport: { width: 1440, height: 900 },
    args: ['--no-first-run', '--no-proxy-server'],
  })
  const page = ctx.pages()[0] ?? await ctx.newPage()
  page.setDefaultTimeout(120_000)
  page.on('pageerror', e => result.errors.push('pageerror: ' + String(e.message).slice(0, 160)))
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      result.errors.push('console: ' + m.text().slice(0, 160))
    }
  })

  // 关掉自动引导（否则它会挡住导航）
  await page.addInitScript(() => {
    try {
      localStorage.setItem('yfe-ui:guide-auto', '0')
      localStorage.setItem('yfe-ui:update-auto-check', '0')   // 别让更新检查抢带宽
      localStorage.setItem('yfe-ui:quota-notice-last', 'critical@2099-01-01') // 别让配额提示干扰
    } catch { /* 隐私模式忽略 */ }
  })

  // 长任务收集（在所有页面导航前挂，reload 后重新挂）
  const wireLongTasks = async () => {
    await page.evaluate(() => {
      if (window.__perfLongTasks) return
      window.__perfLongTasks = []
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) window.__perfLongTasks.push(Math.round(e.duration))
        }).observe({ type: 'longtask', buffered: true })
      } catch { /* 浏览器不支持就跳过 */ }
    }).catch(() => {})
  }

  /** 造数据：在页面里直接调 db API（与 scripts/verify/perf-board-500.mjs 同一套路） */
  const seed = async () => {
    const t0 = Date.now()
    const out = await page.evaluate(async ({ chapters, volumes, chars }) => {
      const db = await import('/src/lib/db.ts')
      // 用"新建项目"而不是示例项目：示例项目自带内容会干扰规模判断
      const name = `perf-longbook-${Date.now()}`
      const p = await db.createProject(name, '', '', '', 'full')
      db.setCurrentProject(p.id)
      const now = Date.now()
      const perVolume = Math.ceil(chapters / volumes)
      let made = 0
      for (let v = 0; v < volumes; v++) {
        const vid = crypto.randomUUID()
        await db.saveVolume({
          id: vid, projectId: p.id, order: v, title: `第${v + 1}卷`,
          description: '', createdAt: now,
        })
        for (let i = 0; i < perVolume && made < chapters; i++, made++) {
          // 用可复现的中文填充，不用随机（避免每次都不同导致数字不可比）
          const text = `第${v + 1}卷第${i + 1}章。林昭沿着官道往北走了三日，途遇细雨，衣衫尽湿。他想起临行前老人说的话，握紧了怀里的玉佩。${'前方是渡口，过了河便是归墟。'.repeat(Math.max(1, Math.floor(chars / 20)))}`
          await db.saveChapter({
            id: crypto.randomUUID(), projectId: p.id, volumeId: vid, order: i,
            title: `第${v + 1}卷 第${i + 1}章`,
            content: text, summary: `第${v + 1}卷第${i + 1}章摘要。`,
            status: '草稿', wordCount: text.length,
            createdAt: now, updatedAt: now,
          })
        }
      }
      return { projectId: p.id, name, count: made, firstChapterTitle: '第1卷 第1章' }
    }, { chapters: CHAPTERS, volumes: VOLUMES, chars: CHARS_PER_CHAPTER })
    result.seeded = { ...out, ms: Date.now() - t0 }
    console.log(`已造 ${out.count} 章（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    return out
  }

  // ---------- ① 首屏可交互 ----------
  {
    const t0 = Date.now()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // 新 profile 首启是欢迎向导，不是项目中心 —— 三种落点都要认
    await page.waitForFunction(() => {
      if (document.querySelector('[data-project-hub]') || document.querySelector('nav')) return true
      return [...document.querySelectorAll('button')].some(b => /跳过，直接进入项目管理|先看看示例/.test(b.textContent || ''))
    }, null, { timeout: 120_000 })
    const skipWizard = page.getByRole('button', { name: /跳过，直接进入项目管理/ }).first()
    if (await skipWizard.isVisible().catch(() => false)) await skipWizard.click()
    await page.waitForFunction(() => !!document.querySelector('[data-project-hub]'), null, { timeout: 60_000 })
    result.steps.boot = { ms: Date.now() - t0 }
    console.log(`首屏可交互：${result.steps.boot.ms}ms`)
    await wireLongTasks()
  }

  const seeded = await seed()

  // ---------- 打开项目（重载后走真实入口） ----------
  {
    const t0 = Date.now()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!document.querySelector('[data-project-hub]'), null, { timeout: 120_000 })
    const card = page.locator('[data-project-card]').filter({ hasText: 'perf-longbook-' }).first()
    await card.getByLabel('打开项目').click()
    await page.waitForFunction(() => !!document.querySelector('nav'), null, { timeout: 120_000 })
    result.steps.openProject = { ms: Date.now() - t0 }
    console.log(`打开项目：${result.steps.openProject.ms}ms`)
    await wireLongTasks()
  }

  // ---------- ② 切章 ----------
  {
    // 侧栏的章节树默认折叠（只显示卷名），章节在「章节总表」页里 —— 先导航过去
    const treeEntry = page.getByText('章节总表', { exact: true }).first()
    if (await treeEntry.count()) { await treeEntry.click().catch(() => {}); await page.waitForTimeout(1200) }
    result.steps.chapterListReady = { ok: (await treeEntry.count()) > 0 }
    const marks = [0, Math.floor(CHAPTERS / 2), CHAPTERS - 1]
    const samples = []
    for (let r = 0; r < RUNS; r++) {
      for (const idx of marks) {
        const title = `第${Math.floor(idx / Math.ceil(CHAPTERS / VOLUMES)) + 1}卷 第${(idx % Math.ceil(CHAPTERS / VOLUMES)) + 1}章`
        const t0 = Date.now()
        const item = page.getByText(title, { exact: true }).first()
        if (!(await item.count())) {
          // 找不到时把侧栏结构 dump 出来（否则只知道失败了，不知道页面长什么样）
          const dump = await page.evaluate(() => {
            const el = document.querySelector('aside') || document.querySelector('nav')
            return (el?.innerText || '').slice(0, 600)
          }).catch(() => '')
          result.errors.push(`切章找不到章节：${title}｜侧栏：${dump.replace(/\s+/g, ' ')}`)
          continue
        }
        await item.click()
        // 等到正文区出现该章标题（说明真的切过去了）
        await page.waitForFunction(t => {
          const main = document.querySelector('main') || document.body
          return (main.textContent || '').includes(t)
        }, title, { timeout: 60_000 }).catch(() => {})
        samples.push(Date.now() - t0)
      }
    }
    result.steps.switchChapter = { samples, p50: p50(samples), p95: p95(samples) }
    console.log(`切章：P50 ${p50(samples)}ms / P95 ${p95(samples)}ms（${samples.length} 次）`)
  }

  // ---------- ③ 保存 ----------
  {
    const t0 = Date.now()
    const box = page.locator('textarea, [contenteditable="true"]').first()
    await box.click().catch(() => {})
    await page.keyboard.type('测试保存')
    await page.waitForFunction(() => /已保存|已同步/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {})
    result.steps.save = { ms: Date.now() - t0 }
    console.log(`保存：${result.steps.save.ms}ms`)
  }

  // ---------- ④ 长任务 / 内存 ----------
  {
    const lt = await page.evaluate(() => ({
      list: window.__perfLongTasks ?? [],
      mem: (performance).memory ? (performance).memory.usedJSHeapSize : null,
    })).catch(() => ({ list: [], mem: null }))
    result.longTasks = { count: lt.list.length, totalMs: lt.list.reduce((a, b) => a + b, 0), samples: lt.list.slice(0, 20) }
    result.jsHeapMB = lt.mem ? Math.round(lt.mem / 1048576) : null
    console.log(`长任务 ${result.longTasks.count} 个 / 合计 ${result.longTasks.totalMs}ms；JS 堆 ${result.jsHeapMB ?? '—'} MB`)
  }

  result.finishedAt = new Date().toISOString()
  console.log('\n' + JSON.stringify(result, null, 2))
} catch (e) {
  result.fatal = String(e && e.message ? e.message : e)
  console.error('UI_PERF_FAIL', result.fatal)
  if (result.errors.length) console.error('页面错误：\n  ' + result.errors.slice(0, 5).join('\n  '))
  process.exitCode = 1
} finally {
  if (ctx) await ctx.close().catch(() => {})
  if (server) await server.close().catch(() => {})
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
}
