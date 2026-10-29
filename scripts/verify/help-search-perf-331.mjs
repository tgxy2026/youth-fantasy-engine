// 本机隔离浏览器手册检索耗时采样；不读取项目或访问模型。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `help-search-perf-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext()
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url === `${origin}/__help_perf__`) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Help performance</title>' })
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  // 空文档来自 Vite，随后只加载手册模块；不打开应用项目。
  await page.goto(`${origin}/__help_perf__`, { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const help = await import('/src/lib/help/index.ts')
    const queries = ['字太小怎么放大', '校对怎么跳到原文', '换电脑怎么带走数据', '如何配置模型', '保存状态怎么看', '怎么创建项目', '图鉴切换', '角色设定', '章节目录', '写作进度', '伏笔追踪', '地图编辑', '自由对话', '备份恢复', '联网模型', '功能页引导', '表格新增', '复制失败', '量子纠缠的退相干时间']
    for (const q of queries) help.searchHelp(q)
    const elapsed = []
    for (let i = 0; i < 20; i++) for (const q of queries) {
      const start = performance.now()
      help.searchHelp(q)
      elapsed.push(performance.now() - start)
    }
    elapsed.sort((a, b) => a - b)
    return { queries: queries.length, samples: elapsed.length, p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1], maxMs: elapsed.at(-1) }
  })
  const evidence = { cpu: os.cpus()[0]?.model, browser: browser.version(), ...result, thresholdMs: 150, passed: result.p95Ms <= 150, scope: '隔离 Edge 开发预览；不代表其他设备或首次加载耗时' }
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ run, ...evidence }))
  if (!evidence.passed) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
