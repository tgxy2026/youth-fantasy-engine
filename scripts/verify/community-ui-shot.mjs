// 投稿广场 · 隔离视觉取证 + 版式审计（3.5.0）
//
// 用真实组件 + 拦截的夹具接口，在多种宽度/主题下截图，并采集客观版式指标，
// 供人工复核。🔴 这不是功能验收：只证明「当前源码在这个宽度下长什么样」。
// 🔴 不连接真实服务、不读真实账号、不写产品数据。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, '.workbuddy', 'tmp', process.env.YFE_UI_EVIDENCE_DIR || 'community-ui')
await fs.mkdir(outDir, { recursive: true })

const now = Date.now()
const posts = [
  {
    id: 'p_1', title: '雨落在旧城墙上的那一夜',
    excerpt: '雨是从傍晚开始下的。他站在旧城墙的垛口，看灯火一盏盏亮起来，忽然想起许多年前，有人说过「等这场雨停，我们就往南走」。',
    tags: ['短篇', '练笔'], createdAt: now - 3600_000, updatedAt: now - 3600_000,
    counts: { up: 46, down: 3, comments: 8 }, displayName: '匿名用户',
  },
  {
    id: 'p_2', title: '关于「灵潮」设定的一点补充',
    excerpt: '灵潮每十九年一次，涨落与月相有关。第三次灵潮之后，北境的所有旧契约都会失效——这不是设定漏洞，是后面要用的钩子。',
    tags: ['设定'], createdAt: now - 7200_000, updatedAt: now - 7200_000,
    counts: { up: 21, down: 1, comments: 4 }, displayName: '青灯',
  },
  {
    id: 'p_3', title: '写不动的下午',
    excerpt: '光标闪了很久，我没有敲下一个字。窗外有人在晒被子，风把被角吹起来又落下，像某种缓慢的呼吸。',
    tags: ['灵感'], createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
    counts: { up: 112, down: 0, comments: 19 }, displayName: '匿名用户',
  },
  {
    id: 'p_4', title: '求评：这个开头的节奏是不是太慢了',
    excerpt: '第一章写了三遍。第一遍从战场开始，第二遍从回忆开始，第三遍从一封没寄出的信开始。我不知道哪个更像「开头」。',
    tags: ['求评'], createdAt: now - 172_800_000, updatedAt: now - 172_800_000,
    counts: { up: 9, down: 2, comments: 27 }, displayName: '雨声',
  },
]

const longBody = `雨是从傍晚开始下的。

他站在旧城墙的垛口，看灯火一盏盏亮起来。城墙下的石板路被雨水洗得发亮，卖汤饼的摊子收了棚，只剩一盏纸灯在风里晃。他忽然想起许多年前，有人说过：「等这场雨停，我们就往南走。」

后来雨停过很多次，南边也去过，只是说那句话的人不在了。

他把手按在城砖上。砖缝里长着薄薄的青苔，凉得像一块旧玉。远处有更夫敲梆子，三长两短，是报平安的意思。这个时辰还在城墙上的人，多半是睡不着，或是没地方去。

他属于后者。

——以上是这次想请大家看的片段。我在犹豫要不要把「他」的身份留到第三章再交代，还是第一章就给一个明确的线索。目前写下来，自己读着有点闷，但删掉又觉得少了什么。想听听各位的看法。`

const comments = [
  { id: 'c_1', createdAt: now - 3000_000, body: '「凉得像一块旧玉」这句很好，别删。开头的节奏其实不慢，是信息密度低了一点。', displayName: '匿名用户', byAuthor: false },
  { id: 'c_2', createdAt: now - 2800_000, body: '同意楼上。可以把第三章的一个线索提前半句，既不点破，又让人有往下读的理由。', displayName: '青灯', byAuthor: false },
  { id: 'c_3', createdAt: now - 2600_000, body: '谢谢两位，我先试试提前半句的写法，改完再发一版。', displayName: '匿名用户', byAuthor: true },
]

const rankEntries = [
  { rank: 1, value: 38210, displayName: '青灯' },
  { rank: 2, value: 26940, displayName: '匿名用户' },
  { rank: 3, value: 18760, displayName: '匿名用户' },
  { rank: 4, value: 9930, displayName: '雨声' },
  { rank: 5, value: 6420, displayName: '匿名用户' },
  { rank: 6, value: 3110, displayName: '远山' },
  { rank: 7, value: 1280, displayName: '匿名用户' },
  { rank: 8, value: 640, displayName: '页边' },
]

const profile = {
  nickname: '雨声', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'nickname',
  rankOptIn: true, rankOptInAt: now - 86_400_000, rankRevokedAt: 0, updatedAt: now,
}

const adminQueue = [{
  id: 'p_admin_1', versionId: 'v_admin_1', title: '雨落在旧城墙上的那一夜',
  excerpt: longBody.slice(0, 120), tags: ['短篇'], createdAt: now - 600_000,
  screening: { level: 'review', reasons: ['REPEAT'] },
  advice: { suggestion: 'review', reasons: ['文本整体是正常文学片段', '有一处重复句式，建议人工确认是否刻意'], versionId: 'v_admin_1', at: now, model: 'qwen2.5:7b', endpoint: '127.0.0.1', coverage: { truncated: true, shown: 6000, total: 8400 } },
  claimedBy: '', claimedAt: 0,
}]

function json(route, body) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installFixtures(page) {
  await page.route('**/api/community/**', async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname.replace('/api/community', '')
    const method = route.request().method()
    if (p === '/square') return json(route, { ok: true, open: true, postsOpen: true, commentsOpen: true, tags: ['练笔', '短篇', '设定', '灵感', '求评'], limits: { titleMax: 100, bodyMax: 10000, commentMax: 1000, tagMax: 3 } })
    if (p === '/profile') return json(route, { ok: true, profile })
    if (p === '/admin/overview') return json(route, { ok: true, counts: { posts: 4, comments: 3, reports: 1 }, queue: { posts: 1, comments: 0, reports: 0, appeals: 1 }, state: { squareOpen: true, postsOpen: true, commentsOpen: true, updatedAt: now } })
    if (p === '/admin/queue') {
      const type = url.searchParams.get('type')
      if (type === 'post') return json(route, { ok: true, items: adminQueue, nextCursor: '' })
      if (type === 'appeal') return json(route, { ok: true, items: [{ id: 'a_1', kind: 'appeal', targetType: 'post', targetId: 'p_1', versionId: 'v_old', reason: '作者对审核结果提出申诉', detail: '', createdAt: now - 1200_000, status: 'open', claimedBy: '', claimedAt: 0 }], nextCursor: '' })
      return json(route, { ok: true, items: [], nextCursor: '' })
    }
    if (p === '/admin/item') return json(route, { ok: true, item: { ...adminQueue[0], status: 'pending', body: longBody, versions: [{ vid: 'v_admin_1', title: '雨落在旧城墙上的那一夜', createdAt: now - 600_000 }] } })
    if (p === '/posts' && method === 'GET') {
      const tag = url.searchParams.get('tag') || ''
      const list = tag ? posts.filter((x) => x.tags.includes(tag)) : posts
      return json(route, { ok: true, closed: false, items: list, nextCursor: '' })
    }
    if (p.startsWith('/posts/p_1/comments')) return json(route, { ok: true, items: comments, nextCursor: '' })
    if (p.startsWith('/posts/')) {
      const id = p.split('/')[2]
      const base = posts.find((x) => x.id === id) || posts[0]
      return json(route, { ok: true, post: { ...base, body: longBody, excerpt: undefined } })
    }
    if (p === '/rank') return json(route, { ok: true, closed: false, period: url.searchParams.get('period') || 'day', range: { start: '2026-11-10', end: '2026-11-10' }, entries: rankEntries })
    if (p === '/my/posts') return json(route, { ok: true, items: [] })
    if (p === '/my/comments') return json(route, { ok: true, items: [] })
    if (p === '/my/reports') return json(route, { ok: true, items: [] })
    if (p === '/my/appeals') return json(route, { ok: true, items: [] })
    return json(route, { ok: true })
  })
}

/** 采集客观版式指标：溢出、栏位、字号、行宽、对比度、触控目标 */
async function auditLayout(page) {
  return page.evaluate(() => {
    const rgb = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, b, a = '1'] = m[1].split(',').map((x) => parseFloat(x))
      return { r, g, b, a }
    }
    const lum = ({ r, g, b }) => {
      const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const bgOf = (el) => {
      let cur = el
      while (cur) {
        const c = rgb(getComputedStyle(cur).backgroundColor)
        if (c && c.a > 0.5) return c
        cur = cur.parentElement
      }
      return { r: 255, g: 255, b: 255, a: 1 }
    }
    const contrast = (el) => {
      const fg = rgb(getComputedStyle(el).color)
      if (!fg) return 0
      const bg = bgOf(el)
      const l1 = lum(fg), l2 = lum(bg)
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }
    const rect = (el) => (el ? el.getBoundingClientRect() : null)
    const q = (s) => document.querySelector(s)

    const h2 = q('h2')
    const card = q('ul > li > button')
    const aside = q('aside')
    const bodyText = q('article div')
    const btn = q('nav button')
    const small = q('p')
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      asideVisible: !!aside && rect(aside).width > 0,
      asideWidth: aside ? Math.round(rect(aside).width) : 0,
      mainWidth: card ? Math.round(rect(card).width) : 0,
      titleFont: h2 ? getComputedStyle(h2).fontSize : '',
      titleContrast: h2 ? contrast(h2) : 0,
      cardBg: card ? getComputedStyle(card).backgroundColor : '',
      cardContrast: card ? contrast(card.querySelector('h3') || card) : 0,
      smallContrast: small ? contrast(small) : 0,
      bodyLineHeight: bodyText ? getComputedStyle(bodyText).lineHeight : '',
      navButtonSize: btn ? Math.round(rect(btn).height) : 0,
      hasRankSection: !!q('section[aria-label="码字排行榜"]'),
    }
  })
}

const runId = `community-ui-${Date.now()}`
let server
let browser
const shots = []
const audits = []

try {
  server = await createServer({
    root,
    cacheDir: path.join(root, '.workbuddy', 'tmp', runId, 'vite-cache'),
    logLevel: 'error',
    optimizeDeps: { entries: ['index.html', 'tests/browser/*.html'] },
    server: { host: 'localhost', port: 0 },
  })
  await server.listen()
  const port = server.config.server.port || server.httpServer?.address()?.port
  const base = `http://localhost:${port}/tests/browser/community.html`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })

  async function shot(name, width, height, { query = '', theme = 'eye-care', steps } = {}) {
    const page = await browser.newPage({ viewport: { width, height } })
    await installFixtures(page)
    await page.goto(`${base}?theme=${theme}${query}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: /投稿广场/ }).waitFor({ timeout: 20000 })
    await page.waitForTimeout(600)
    if (steps) await steps(page)
    await page.waitForTimeout(300)
    const file = path.join(outDir, `${name}.png`)
    await page.screenshot({ path: file, fullPage: false })
    audits.push({ name, ...(await auditLayout(page)) })
    shots.push({ name, width, height, theme, file })
    await page.close()
  }

  await shot('feed-wide-1440', 1440, 900)
  await shot('feed-wide-dark', 1440, 900, { theme: 'dark' })
  await shot('detail-wide-1440', 1440, 900, {
    steps: async (page) => {
      await page.getByRole('button', { name: /雨落在旧城墙上的那一夜/ }).click()
      await page.getByRole('heading', { name: /评论/ }).waitFor({ timeout: 10000 })
      const reading = page.locator('article').first()
      const measure = await reading.evaluate((el) => {
        const parent = el.parentElement
        return { article: el.getBoundingClientRect().width, parent: parent?.getBoundingClientRect().width || 0 }
      })
      if (measure.article < measure.parent - 2) throw new Error('阅读正文未铺满可用宽度')
      await page.getByRole('button', { name: '阅读字号 20' }).click()
      if (await reading.locator('p.whitespace-pre-wrap').first().evaluate((el) => getComputedStyle(el).fontSize) !== '20px') throw new Error('阅读字号未生效')
      await page.getByRole('button', { name: '返回列表' }).click()
      await page.getByRole('button', { name: /雨落在旧城墙上的那一夜/ }).click()
      if (await page.getByRole('button', { name: '阅读字号 20' }).getAttribute('aria-pressed') !== 'true') throw new Error('阅读字号未保留')
      await page.getByRole('button', { name: '阅读字号 16' }).click()
    },
  })
  await shot('publish-wide-1440', 1440, 900, {
    steps: async (page) => {
      await page.getByRole('button', { name: '投稿', exact: true }).click()
      await page.getByRole('heading', { name: /写一段新投稿/ }).waitFor({ timeout: 10000 })
      await page.getByLabel('标题').fill('关于「灵潮」的一点补充')
      await page.getByLabel('正文').fill(longBody)
      await page.getByRole('button', { name: '短篇' }).click()
    },
  })
  await shot('admin-wide-1440', 1440, 900, {
    steps: async (page) => {
      await page.getByRole('button', { name: /审阅/ }).click()
      await page.getByRole('button', { name: /申诉复核/ }).waitFor({ timeout: 10000 })
    },
  })
  await shot('admin-detail-wide-1440', 1440, 900, {
    steps: async (page) => {
      await page.getByRole('button', { name: /审阅/ }).click()
      await page.getByRole('button', { name: '审阅', exact: true }).click()
      await page.getByText('生成位置').waitFor({ timeout: 10000 })
    },
  })
  await shot('feed-1024', 1024, 800)
  await shot('feed-768', 768, 1024)
  await shot('feed-390', 390, 844)
  await shot('rank-open-390', 390, 844, {
    steps: async (page) => {
      await page.getByRole('button', { name: /码字排行/ }).click()
      await page.getByRole('group', { name: '排行周期' }).waitFor({ timeout: 10000 })
    },
  })
  await shot('overlay-1440', 1440, 900, { query: '&mode=overlay' })

  await fs.writeFile(path.join(outDir, 'shots.json'), JSON.stringify({ base, shots, audits }, null, 2))
  console.log(JSON.stringify({ ok: true, outDir, audits }, null, 2))
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
}
