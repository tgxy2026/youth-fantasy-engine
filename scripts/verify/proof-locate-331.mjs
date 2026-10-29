// 3.3.1 · P7「定位原文」隔离探针
//
// 验的是「点完定位之后正文发生了什么」，不验模型：校对结果用固定载荷模拟。
// 覆盖：选区落在引文上、正文不被改、滚动到位、跨章拒绝、伪造下标不盲信、
//       正文改过之后不跳到别的句子、连点只认最后一次、返回入口回传条目身份。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const run = await mkdtemp(path.join(root, '.workbuddy/tmp/proof-locate-331-'))
const server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra })
  if (!cond) console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
}
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/proof-locate-331-fixture.tsx'))
  const area = page.getByRole('textbox', { name: '正文' })
  await area.waitFor()

  const setup = await page.evaluate(() => {
    const body = window.body
    const quote = window.quote
    return { body, quote, target: body.indexOf(quote), length: quote.length, original: body }
  })
  check('目标句在正文里唯一且靠后（否则滚动验不出）', setup.target > 500, `target=${setup.target}`)

  const locate = patch => page.evaluate(p => window.locate(p), {
    chapterId: 'ch-1', source: 'tool', index: 3, total: 7,
    start: setup.target, end: setup.target + setup.length,
    quote: setup.quote, issueKey: 42, scope: 'text', ...patch,
  })
  const readArea = () => page.evaluate(() => {
    const ta = document.querySelector('textarea')
    return { start: ta.selectionStart, end: ta.selectionEnd, scrollTop: ta.scrollTop, value: ta.value,
      located: document.querySelector('[data-located]').textContent || '',
      bar: !!document.querySelector('[data-proof-locate-bar]'), focused: document.activeElement === ta }
  })

  // ① 正常定位
  const handled = await locate({})
  const after = await readArea()
  check('请求被正文接手', handled === true)
  check('选区正好落在引文上', after.start === setup.target && after.end === setup.target + setup.length,
    `${after.start}-${after.end} vs ${setup.target}-${setup.target + setup.length}`)
  check('🔴 正文一个字都没改', after.value === setup.original)
  check('滚到了目标位置（不是停在顶部）', after.scrollTop > 0, `scrollTop=${after.scrollTop}`)
  check('焦点交给正文（作者可以直接改）', after.focused)
  check('编辑器拿到同一区间（选区状态同步）', after.located === `${setup.target}-${setup.target + setup.length}`)
  check('出现「返回校对结果」入口', after.bar)
  const barText = await page.locator('[data-proof-locate-bar]').innerText()
  check('返回条回显第几条与总数', /第 3 \/ 7 条/.test(barText), barText)

  // ② 跨章请求：当前在 ch-1，结果属于 ch-2
  const crossHandled = await locate({ chapterId: 'ch-2' })
  const cross = (await readArea()).start
  check('🔴 跨章请求不接手（不跳到别的章的位置）', crossHandled === false)
  check('跨章请求没有移动选区', cross === setup.target, `selectionStart=${cross}`)

  // ③ 伪造下标：at 对着别处，但引文全文唯一 ⇒ 仍落到真实位置，不盲信 at
  const spoof = await locate({ start: 0 })
  const spoofPos = await readArea()
  check('伪造 at 不盲信：仍落在引文真实位置', spoof === true && spoofPos.start === setup.target,
    `${spoofPos.start} vs ${setup.target}`)

  // ④ 正文改过之后：引文已不存在 ⇒ 不跳、不误跳
  await area.fill(setup.original.replace(setup.quote, '第40段：他走进屋子'))
  const beforeStale = (await readArea()).start
  await locate({})
  const stale = await readArea()
  check('🔴 引文已改掉时不跳到别的句子', stale.start === beforeStale, `${stale.start} vs ${beforeStale}`)
  check('引文已改掉时不更新已定位区间', stale.located === `${setup.target}-${setup.target + setup.length}`, stale.located)

  // ⑤ 连点：只认最后一次
  await area.fill(setup.original)
  const second = setup.original.indexOf('第20段：他走进房间')
  await locate({})
  await locate({ start: second, end: second + setup.length, quote: '第20段：他走进房间', index: 5 })
  const last = (await readArea()).start
  check('连点定位以最后一次为准', last === second, `${last} vs ${second}`)

  // ⑥ 返回校对结果
  await page.getByRole('button', { name: '返回校对结果' }).click()
  const returned = await page.evaluate(() => ({ returned: window.returned, bar: !!document.querySelector('[data-proof-locate-bar]') }))
  check('返回按钮回传条目身份（用于列表滚回那一条）', returned.returned === 42, String(returned.returned))
  check('返回后提示条收起', !returned.bar)

  // ⑦ 空引文：不崩、不产生 0 长度区间
  const beforeEmpty = (await readArea()).start
  const emptyHandled = await locate({ quote: '' })
  const afterEmpty = (await readArea()).start
  check('空引文不产生定位（也不抛错）', emptyHandled === true && afterEmpty === beforeEmpty)

  const failed = checks.filter(c => !c.ok)
  console.log(JSON.stringify({
    run, total: checks.length, passed: checks.length - failed.length, failed: failed.length,
    result: failed.length ? 'failures found' : 'selection, read-only, scroll, chapter guard, spoofed offset, stale quote, repeat clicks and return handled',
    checks,
  }, null, 2))
  if (failed.length) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
