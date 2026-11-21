#!/usr/bin/env node
/**
 * 长书真机性能探针（3.6.2 · W4）
 *
 * ✅ **状态：已调通（2026-11-21；同日补切章冗余渲染修复后的复测）**。800 章 / 120 万字：
 *    修前：切章高亮 P50 396 ms / P95 429 ms，长任务 110 个（合计 13.3 s），保存 2.6 s；
 *    修后两轮：高亮 P50 169 / 172 ms、P95 184 / 197 ms，**正文就位** P50 180 ms / P95 202 ms，
 *    长任务 36 个（合计 4.5 s），保存 2.2 s（含 2 s 防抖），JS 堆 172–283 MB。
 * ⚠️ 早先记录的 P50 327–339 ms 与本轮的 396 ms 有**跨会话漂移**（开发记录 §1.5c）——
 *    修前/修后只在同一次会话背靠背跑时可比，别跨天对数字。
 * ⚠️ 400–420 ms 的单次尖峰不保证复现；验收看**长任务总数 / 总时长**，不看「有没有尖峰」。
 *    高亮出现 ≠ 正文可读，所以另量「正文就位」（textarea 值以「第N卷第M章」开头）。
 * ⚠️ 首屏 15–24 s 是 dev 形态（Vite 按需编译近千模块），**不代表生产**。
 *
 * 【关键锚点（调通的前提）】
 *   · 章节行：`[data-chapter-id]`、卷：`[data-volume-id]`、卷头：`[data-volume-head]`
 *     —— 章节行**折叠时不渲染**，所以先点卷头的「展开本卷章节」；
 *   · 一律按 id / 选择器定位，**不按可见文字**：按标题文字定位的探针，
 *     标题格式一改就会"红得莫名其妙"，那不是产品退化。
 *   · 侧栏「正文写作」是**分组标题**，页签叫「正文编辑」——点错就永远进不去编辑器。
 *
 * 【测什么（设计目标）】
 *   ① 首屏可交互（打开 → 侧栏/正文可用）✅
 *   ② 切章（首章 / 中段 / 末章，各 3 次，取 P50/P95）✅
 *   ③ 保存（改一个字 → 出现「已保存」）✅（注意：页面上第一个 textarea 是「章节压缩摘要」，
 *      正文是 `textarea.novel-textarea` —— 定位错了就永远等不到「已保存」）
 *   ④ 长任务计数与总时长（`longtask`，>50ms 的任务）✅
 *   ⑤ JS 堆（若 Chromium 给了 `performance.memory`）✅
 *   ⑥ 全文检索（工具 → 全文检索；含末章覆盖性）✅
 *   ⑦ 图鉴大表（`--atlas N` 造 N 行；打开耗时 + 名称筛选）✅
 *
 * 【隔离】🔴 绝不碰真实数据：
 *   · 独立 `--user-data-dir`（mkdtemp 临时目录，跑完删除）；
 *   · 数据写在**这个临时 profile 的 IndexedDB** 里，与作者平时用的浏览器 profile 无关；
 *   · 项目名带 `perf-longbook-<时间戳>`，即便误连也能一眼认出来。
 *
 * 用法：
 *   node scripts/verify/ui-perf-longbook.mjs                  # 默认 800 章（约 120 万字）
 *   node scripts/verify/ui-perf-longbook.mjs --chapters 40    # 小规模自检（几十秒）
 *   node scripts/verify/ui-perf-longbook.mjs --runs 3         # 切章重复次数（默认 3）
 *   node scripts/verify/ui-perf-longbook.mjs --atlas 2000     # 顺带测图鉴大表（造 2000 行）
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
/** 自定义切换目标（下标，逗号分隔）。用于对照实验，例如 --marks 0,400 排除末章 */
/** 图鉴大表要造多少行（0 = 不造，跳过图鉴测量） */
const ATLAS_ROWS = num('--atlas', 0)
const MARKS_ARG = (() => {
  const i = process.argv.indexOf('--marks')
  if (i < 0) return null
  const list = String(process.argv[i + 1] || '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= 0)
  return list.length ? list : null
})()
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
    const out = await page.evaluate(async ({ chapters, volumes, chars, atlasRows }) => {
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
      // 图鉴大表（可选）：用「地理风物」表造行。
      // data 的键就是**中文列名**（见 lib/storage/tableIO.ts 的 cols.forEach(c => data[c.name] = '')），
      // 不是内部 id —— 猜错了行会全部空白但表能渲染，很难看出来。
      if (atlasRows > 0) {
        for (let i = 0; i < atlasRows; i++) {
          await db.saveTableRow({
            id: crypto.randomUUID(), projectId: p.id, tabId: 'geography',
            data: {
              '编号': String(i + 1),
              '名称': `烟雨渡${i}`,
              '类别': i % 2 ? '城市' : '区域',
              '地理位置': `云州·第${i}区`,
              '备注': `第${i}条图鉴`,
            },
            order: i, createdAt: now, updatedAt: now,
          })
        }
      }
      return { projectId: p.id, name, count: made, firstChapterTitle: '第1卷 第1章', atlasRows }
    }, { chapters: CHAPTERS, volumes: VOLUMES, chars: CHARS_PER_CHAPTER, atlasRows: ATLAS_ROWS })
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
  //
  // 入口与锚点（2026-11-21 补）：章节行**折叠时不渲染**，所以要先点卷头的展开键；
  // 定位一律按 `data-volume-id` / `data-chapter-id` 走 id，不按可见文字 ——
  // 按标题文字定位的探针，标题格式一改就会红得莫名其妙，那不是产品退化。
  {
    // 先进「正文编辑」（章节树在这个页面的侧栏里）。
    // ⚠️ 「正文写作」是**分组标题**，点它不会切页 —— 页签叫「正文编辑」。
    const navWriting = page.getByText('正文编辑', { exact: true }).first()
    if (await navWriting.count()) { await navWriting.click().catch(() => {}) }
    await page.waitForSelector('[data-volume-id]', { timeout: 90_000 }).catch(() => {})

    // 展开所有卷（按钮文案随状态变，用 aria-label 精确匹配展开那一侧）
    const toggles = page.locator('[data-volume-head] button[aria-label=展开本卷章节]')
    const toggleCount = await toggles.count()
    for (let i = 0; i < toggleCount; i++) await toggles.nth(i).click({ timeout: 5000 }).catch(() => {})
    await page.waitForSelector('[data-chapter-id]', { timeout: 30_000 }).catch(() => {})

    const rows = page.locator('[data-chapter-id]')
    const total = await rows.count()
    result.steps.chapterRows = { count: total, toggles: toggleCount }
    if (total === 0) {
      const dump = await page.evaluate(() => (document.querySelector('aside')?.innerText || '').slice(0, 400)).catch(() => '')
      result.errors.push('切章：展开后仍没有 [data-chapter-id]｜侧栏：' + dump.replace(/\s+/g, ' '))
    }

    const marks = MARKS_ARG ?? (total > 1 ? [0, Math.floor(total / 2), total - 1] : [0])
    const samples = []
    /** 正文真正换好的耗时（含描边高亮之后的那次草稿同步） */
    const contentSamples = []
    /** 逐样本明细：ms + 该次期间的长任务个数 */
    const perSample = []
    for (let r = 0; r < RUNS; r++) {
      for (const idx of marks) {
        if (idx >= total) continue
        // 切章前后的长任务增量：用来判断「尖峰是渲染/GC」还是「在等什么」
        const heapBefore = await page.evaluate(() => (performance).memory ? (performance).memory.usedJSHeapSize : 0).catch(() => 0)
        const ltBefore = await page.evaluate(() => {
          const l = window.__perfLongTasks ?? []
          return { n: l.length, sum: l.reduce((a, b) => a + b, 0) }
        }).catch(() => ({ n: 0, sum: 0 }))
        const t0 = Date.now()
        await rows.nth(idx).click({ timeout: 15_000 }).catch(() => {})
        // 等到这一行真的变成当前章（active 态），才算切过去了
        await page.waitForFunction(i => {
          const all = document.querySelectorAll('[data-chapter-id]')
          const el = all[i]
          return !!el && /bg-amber\/15/.test(el.className)
        }, idx, { timeout: 30_000 }).catch(() => {})
        const ms = Date.now() - t0
        /**
         * 🔴 「行高亮」比「正文换好」早一拍：切章后还有一次草稿 state 同步（可能含第二次提交）。
         *    只量高亮会在长书上把数字说小，所以再等正文 textarea 真的换成目标章。
         *    造数时正文开头固定是「第V卷第I章」，据此判定，不用章名（章名是「第V卷 第I章」，有空格）。
         */
        const perVolume = Math.ceil(CHAPTERS / VOLUMES)
        const expectPrefix = `第${Math.floor(idx / perVolume) + 1}卷第${(idx % perVolume) + 1}章`
        const contentHit = await page.waitForFunction(prefix => {
          const areas = document.querySelectorAll('textarea.novel-textarea')
          const ta = areas[areas.length - 1]
          return !!ta && (ta).value.startsWith(prefix)
        }, expectPrefix, { timeout: 30_000 }).then(() => true).catch(() => false)
        const contentMs = Date.now() - t0
        const ltAfter = await page.evaluate(() => {
          const l = window.__perfLongTasks ?? []
          return { n: l.length, sum: l.reduce((a, b) => a + b, 0) }
        }).catch(() => ltBefore)
        const heapAfter = await page.evaluate(() => (performance).memory ? (performance).memory.usedJSHeapSize : 0).catch(() => 0)
        samples.push(ms)
        contentSamples.push(contentMs)
        /**
         * 🔴 归因用：`spike` 判定取「明显高于本轮中位数」，再看它期间有没有长任务。
         *    有长任务 ⇒ 主线程被占（渲染 / GC）；没有 ⇒ 在等 IO 或串行队列。
         */
        perSample.push({
          idx, ms, contentMs, contentHit,
          longTasks: Math.max(0, ltAfter.n - ltBefore.n),
          /** 该次期间长任务总时长：用来区分「任务变慢」与「多干了一件事」 */
          longTaskMs: Math.max(0, ltAfter.sum - ltBefore.sum),
          heapBeforeMB: Math.round(heapBefore / 1048576),
          heapAfterMB: Math.round(heapAfter / 1048576),
          /** 堆明显回落 = 期间发生了一次回收 */
          heapDropped: heapBefore > 0 && heapAfter > 0 && heapAfter < heapBefore * 0.85,
        })
      }
    }
    // 尖峰归因：取明显高于中位数的样本，看它们期间有没有长任务
    const med = samples.length ? [...samples].sort((a, b) => a - b)[Math.floor((samples.length - 1) / 2)] : 0
    const spikes = perSample.filter((x) => x.ms > med * 1.2)
    result.steps.switchChapter = {
      samples, p50: p50(samples), p95: p95(samples), rounds: RUNS,
      /** 正文真正切换完成的耗时（比高亮更接近作者体感） */
      contentSamples, contentP50: p50(contentSamples), contentP95: p95(contentSamples),
      median: med,
      perSample,
      spikes: {
        count: spikes.length,
        withLongTask: spikes.filter((x) => x.longTasks > 0).length,
        withHeapDrop: spikes.filter((x) => x.heapDropped).length,
        samples: spikes,
      },
    }
    console.log(`切章：高亮 P50 ${p50(samples)}ms / P95 ${p95(samples)}ms；正文就位 P50 ${p50(contentSamples)}ms / P95 ${p95(contentSamples)}ms（${samples.length} 次，共 ${total} 章）`)
  }

  // ---------- ③ 保存 ----------
  //
  // ⚠️ 口径说明：这里量的是「输入后到状态栏出现『已保存』」的墙钟时间，
  //    其中含 2 秒自动保存防抖，所以它**不是纯写盘耗时**。标 heuristic 免得被当成 I/O 指标。
  {
    const t0 = Date.now()
    // 🔴 页面上第一个 textarea 是「章节压缩摘要」，不是正文 —— 那是第一次调这里踩的坑。
    //    正文是 textarea.novel-textarea（层叠里 z-10 那层，可编辑）。
    const area = page.locator('textarea.novel-textarea').last()
    const visible = await area.isVisible().catch(() => false)
    if (!visible) {
      result.steps.save = { skipped: true, reason: '正文输入区不可见（可能不在编辑器页）' }
      console.log('保存：跳过（正文区不可见）')
    } else {
      const beforeLen = (await area.inputValue().catch(() => '')).length
      await area.click()
      await area.type('X', { delay: 20 })
      const afterLen = (await area.inputValue().catch(() => '')).length
      result.steps.saveInput = { beforeLen, afterLen, typed: afterLen !== beforeLen }
      // 8 秒足够覆盖 2 秒防抖 + 写盘；再久就是在等一个不会发生的事（会拖长 800 章的运行）
      const hit = await page.waitForFunction(() => /已保存/.test(document.body.innerText), null, { timeout: 8_000 })
        .then(() => true).catch(() => false)
      const statusLines = await page.evaluate(() =>
        (document.body.innerText.match(/[^\n]*(保存|写入)[^\n]*/g) || []).slice(0, 6))
        .catch(() => [])
      result.steps.save = { ms: Date.now() - t0, heuristic: true, sawSavedState: hit, inputChanged: afterLen !== beforeLen, statusLines }
      console.log(`保存：${result.steps.save.ms}ms（含自动保存防抖；见到「已保存」=${hit}）`)
    }
  }

  // ---------- ③b 全文检索 ----------
  //
  // 🔴 分两段测，因为这是两件不同的事：
  //   · **索引就绪**：打开面板到能搜（面板上会显示「建索引…」）—— 长书真正卡的是这一段；
  //   · **查询延迟**：输入关键词到结果出现。
  //   合成一个数会让人以为"检索很快"，而实际上用户先等的是索引。
  {
    const navWriting = page.getByText('正文编辑', { exact: true }).first()
    if (await navWriting.count()) { await navWriting.click().catch(() => {}) }

    // 「工具」菜单（HelpPopover 的触发器）→ 全文检索
    let opened = false
    // 🔴 HelpPopover 的 aria-label 取 triggerTitle（这里是「编辑工具」），不是可见的「工具」二字
    const toolBtn = page.locator('[aria-label="编辑工具"]').first()
    if (await toolBtn.count()) {
      await toolBtn.click().catch(() => {})
      const entry = page.getByRole('button', { name: /全文检索/ }).first()
      if (await entry.count()) { await entry.click().catch(() => {}); opened = true }
    }
    if (!opened) {
      result.errors.push('全文检索：找不到「工具 → 全文检索」入口')
      console.log('全文检索：入口未找到，跳过')
    } else {
      const searchInput = page.locator('input[placeholder*="搜全书"]').first()
      await searchInput.waitFor({ timeout: 30_000 }).catch(() => {})

      /**
       * 实测口径：**打开面板 → 输入关键词 → 结果出现**，这是作者真实的路径
       * （打开就开始打字，不会先等一个索引完成的提示）。
       *
       * 另记一个标记：结果已经出来了，但面板上是否还挂着「建索引…」——
       * 若两者同时成立，用户会以为还没好，那是 UI 误报，得单独记。
       */
      const tOpen = Date.now()
      await searchInput.fill('渡口')
      const gotHit = await page.waitForSelector('[data-idx]', { timeout: 180_000 }).then(() => true).catch(() => false)
      const firstHitMs = Date.now() - tOpen

      // 结果条数稳定下来才算查完（分批进来的）
      let prev = -1, stable = 0
      for (let i = 0; i < 60 && gotHit; i++) {
        const n = await page.locator('[data-idx]').count()
        if (n === prev) { if (++stable >= 3) break } else { stable = 0; prev = n }
        await new Promise((r) => setTimeout(r, 50))
      }
      const queryMs = Date.now() - tOpen
      const stillIndexing = await page.getByText('建索引…').count().catch(() => 0)
      result.steps.fullText = {
        firstHitMs, settledMs: queryMs, hits: prev, keyword: '渡口',
        showsIndexingLabelAfterResults: stillIndexing > 0,
      }
      console.log(`全文检索：首条结果 ${firstHitMs}ms，结果稳定 ${queryMs}ms（${prev} 条）` +
        (stillIndexing > 0 ? '｜⚠️ 结果已出但仍显示「建索引…」' : ''))

      /**
       * 🔴 覆盖性验证：137ms 对 120 万字来说快得可疑，必须证明索引真的到了最后一章。
       *    造数时标题是「第V卷 第I章」，最后一章唯一 - 搜到它就是全量覆盖的证据。
       */
      const lastTitle = `第${VOLUMES}卷 第${Math.ceil(CHAPTERS / VOLUMES)}章`
      await searchInput.fill('')
      await searchInput.fill(lastTitle)
      await page.waitForSelector('[data-idx]', { timeout: 30_000 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 250))
      const lastHits = await page.locator('[data-idx]').count()
      // 🔴 只看条数不够：limit=60 会把结果截断，随便一个高频词都能凑满 60 条。
      //    必须确认结果文本里**真的出现**那一章的标题。
      const hitTexts = await page.locator('[data-idx]').allInnerTexts().catch(() => [])
      const indexCoversTail = hitTexts.some((t) => t.includes(lastTitle))
      result.steps.fullText.indexCoversTail = { keyword: lastTitle, hits: lastHits, found: indexCoversTail }
      console.log(`全文检索 · 覆盖性：搜「${lastTitle}」→ ${lastHits} 条${indexCoversTail ? '（覆盖到末章 ✅）' : '（⚠️ 末章搜不到，索引可能不全）'}`)

      // 关掉面板，别影响后面的步骤
      await page.keyboard.press('Escape').catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  // ---------- ③c 图鉴大表 ----------
  //
  // 「大表卡不卡」的真实指标是**打开到表格可交互**，不是筛选那一下 ——
  // 筛选是纯内存过滤（filteredRows），几千行通常是毫秒级；渲染才是瓶颈。
  // 所以这里主测打开耗时，顺带记一次筛选后的行数收敛。
  if (ATLAS_ROWS > 0) {
    const t0 = Date.now()
    const navAtlas = page.getByText('地理风物', { exact: true }).first()
    if (!(await navAtlas.count())) {
      // 分组的折叠状态不可预期：先试着展开「世界构建」
      const grp = page.getByText('世界构建', { exact: true }).first()
      if (await grp.count()) await grp.click().catch(() => {})
    }
    const nav2 = page.getByText('地理风物', { exact: true }).first()
    if (!(await nav2.count())) {
      result.errors.push('图鉴大表：侧栏找不到「地理风物」入口')
      console.log('图鉴大表：入口未找到，跳过')
    } else {
      await nav2.click().catch(() => {})
      const appeared = await page.waitForSelector('table tbody tr', { timeout: 120_000 }).then(() => true).catch(() => false)
      const openMs = Date.now() - t0
      const rowCount = await page.locator('table tbody tr').count().catch(() => 0)
      result.steps.atlasTable = { rows: ATLAS_ROWS, openMs, renderedRows: rowCount, appeared }
      console.log(`图鉴大表：打开 ${openMs}ms（渲染 ${rowCount} 行 / 造 ${ATLAS_ROWS} 行）`)

      /**
       * 筛选：列头输入框（placeholder="筛选"），每列一个。
       * 🔴 必须限定在「名称」那一列表头里找 —— 页面上有十几个同样的输入框，
       *    不限定就会填进「编号」列，然后得出一个假的"筛选很快"。
       */
      const filterInput = page.locator('th', { hasText: '名称' }).locator('input[placeholder="筛选"]').first()
      if (await filterInput.count()) {
        /**
         * 🔴 判据不能是「行数变少」：表格是**虚拟滚动**，2000 行也只渲染可见的十几行，
         *    筛选前后 tr 数量可能一样。第一版就是这么写的，等了 60 秒拿到 15→15。
         *    改用「筛到一个唯一值后，表格里只剩很少的行」。
         */
        const tf = Date.now()
        await filterInput.fill('烟雨渡1999')
        const narrowed = await page.waitForFunction(
          () => document.querySelectorAll('table tbody tr').length <= 3,
          null, { timeout: 30_000 },
        ).then(() => true).catch(() => false)
        const filterMs = Date.now() - tf
        const after = await page.locator('table tbody tr').count().catch(() => 0)
        const bodyText = await page.locator('table').first().innerText().catch(() => '')
        result.steps.atlasFilter = {
          ms: filterMs, before: rowCount, after, narrowed,
          /** 表格是否显示了总行数（用来确认 2000 行真的写进去了，而不是只造了十几行） */
          mentionsTotal: bodyText.includes(String(ATLAS_ROWS)),
        }
        console.log(`图鉴大表 · 筛选：${filterMs}ms（${rowCount} → ${after} 行，收敛=${narrowed}）`)
        await filterInput.fill('')
      } else {
        result.errors.push('图鉴大表：找不到「名称」列的筛选框')
      }
    }
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
