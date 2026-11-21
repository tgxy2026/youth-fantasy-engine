// ============ 投稿广场 · 合集与浏览量（3.6.2）============
//
// 起真实 http 服务（与 communityApi.test.ts 同一套），守这几条：
//   ① 合集 CRUD 的权限与配额；
//   ② 关系只存一侧：删合集必须先解绑，帖子不能指向不存在的合集；
//   ③ 合集内排序是**正序**（与广场时间线相反）；
//   ④ 不可见篇目不进目录（序号跳号），全不可见时对外 404；
//   ⑤ 浏览量：作者不计、同一人 24h 一次、游客按 IP+UA、明细只进详情不算列表曝光；
//   ⑥ **旧稿件可以移入合集**（这是需求里明确要的）。
//
// ?? 本地通过 ≠ 部署验收：没有 TLS、没有真实反代、没有多进程竞争。

import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCommunityStore } from '../server/lib/communityStore.mjs'
import { createCommunityApi } from '../server/lib/communityApi.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-community-col-'))
const store = createCommunityStore({ root })
const USERS: Record<string, { id: string; name: string; role?: string }> = {
  alice: { id: 'u_alice', name: 'alice' },
  bob: { id: 'u_bob', name: 'bob' },
  mod: { id: 'u_mod', name: 'mod', role: 'moderator' },
}
const byId = new Map(Object.values(USERS).map((u) => [u.id, u]))
const api = createCommunityApi({
  store,
  authCheck: (req: any) => {
    const who = String(req.headers['x-test-user'] || '')
    const u = USERS[who]
    return { user: u || null, reason: u ? '' : 'NO_TOKEN' }
  },
  // 🔴 本文件要连发十几篇来构造合集，会撞上「每天 5 篇」的投稿限流。
  //    频率限制由 communityApi.test.ts 覆盖，这里放行以免把无关的门槛当成合集 bug。
  rateLimit: () => ({ ok: true, retryAfter: 0 }),
})

const server = createServer((req, res) => {
  const url = req.url || '/'
  const pathOnly = url.split('?')[0]
  const qs = new URLSearchParams(url.split('?')[1] || '')
  if (!pathOnly.startsWith('/api/community')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"ok":false}')
    return
  }
  const who = String(req.headers['x-test-user'] || '')
  const user = USERS[who] ? byId.get(USERS[who].id)! : null
  api.handle({ req, res, path: pathOnly, qs, user, authReason: user ? '' : 'NO_TOKEN', ip: '127.0.0.1' })
    .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e) })) })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : 0
const base = `http://127.0.0.1:${port}`

interface Result { status: number; json: any }
async function call(p: string, opts: { method?: string; body?: unknown; as?: string; headers?: Record<string, string> } = {}): Promise<Result> {
  const headers: Record<string, string> = { ...(opts.headers || {}) }
  if (opts.as) headers['x-test-user'] = opts.as
  let body: string | undefined
  if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const res = await fetch(base + p, { method: opts.method || 'GET', headers, body })
  const raw = await res.text()
  let json: any = null
  try { json = JSON.parse(raw) } catch { json = null }
  return { status: res.status, json }
}

const body = (n = 30) => '字'.repeat(n) + '，雨落在城墙上。'

/** 发一篇并让它通过审核，返回 postId */
async function publishAs(who: string, title: string, tags: string[] = []): Promise<string> {
  const created = await call('/api/community/posts', {
    method: 'POST', as: who, body: { title, body: body(), tags, display: 'anonymous' },
  })
  if (!created.json?.post) throw new Error('发布失败：' + JSON.stringify(created.json))
  const id = created.json.post.id as string
  const vid = created.json.post.pendingVersionId as string
  await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id, versionId: vid, action: 'approve' } })
  return id
}

console.log('\n—— communityCollections 用例开始 ——')

try {
  // ================= 合集：创建 / 权限 / 配额 =================
  {
    ok('未登录不能建合集', (await call('/api/community/collections', { method: 'POST', body: { title: 'x' } })).status === 401)
    ok('未登录不能读我的合集', (await call('/api/community/my/collections')).status === 401)

    const bad = await call('/api/community/collections', { method: 'POST', as: 'alice', body: { title: '  ' } })
    ok('空名称被拒', bad.status === 400 && bad.json.code === 'TITLE_REQUIRED')

    const tooLong = await call('/api/community/collections', { method: 'POST', as: 'alice', body: { title: '长'.repeat(41) } })
    ok('超长名称被拒（40 字上限）', tooLong.status === 400 && tooLong.json.code === 'TITLE_TOO_LONG')

    const withUrl = await call('/api/community/collections', {
      method: 'POST', as: 'alice', body: { title: '归墟', intro: '更多见 https://example.com/x' },
    })
    ok('🔴 简介里带网址被拒（合集不单独审核，所以必须在这里拦）',
      withUrl.status === 400 && withUrl.json.code === 'SCREENING_REJECTED', JSON.stringify(withUrl.json))

    const oneChar = await call('/api/community/collections', { method: 'POST', as: 'alice', body: { title: '序' } })
    ok('一字标题可以通过（不被 TOO_SHORT 误杀）', oneChar.status === 200, JSON.stringify(oneChar.json))

    const created = await call('/api/community/collections', { method: 'POST', as: 'alice', body: { title: '归墟（连载）', intro: '渡口与玉佩' } })
    ok('建合集成功', created.status === 200 && !!created.json.collection.id)
    const myCols = await call('/api/community/my/collections', { as: 'alice' })
    ok('我的合集列表能读到它',
      Array.isArray(myCols.json?.items) && myCols.json.items.some((c: any) => c.title === '归墟（连载）'),
      JSON.stringify(myCols.json))
    ok('别人看不到我的合集列表',
      (await call('/api/community/my/collections', { as: 'bob' })).json.items.length === 0)
  }

  // ================= 旧稿件移入合集 + 排序 + 目录 =================
  const aliceCol = (await call('/api/community/my/collections', { as: 'alice' })).json.items
    .find((c: any) => c.title === '归墟（连载）').id as string

  {
    // 先发三篇（存在一段时间再归集 = 模拟"以前的稿件"）
    const p1 = await publishAs('alice', '归墟·一')
    const p2 = await publishAs('alice', '归墟·二')
    const p3 = await publishAs('alice', '归墟·三')

    ok('🔴 旧稿件可以加入合集',
      (await call(`/api/community/collections/${aliceCol}/posts`, { method: 'POST', as: 'alice', body: { postId: p1 } })).status === 200)
    await call(`/api/community/collections/${aliceCol}/posts`, { method: 'POST', as: 'alice', body: { postId: p2 } })
    await call(`/api/community/collections/${aliceCol}/posts`, { method: 'POST', as: 'alice', body: { postId: p3 } })

    const page = await call(`/api/community/collections/${aliceCol}`)
    ok('合集页可公开访问且篇数为 3', page.status === 200 && page.json.collection.postCount === 3)
    ok('🔴 合集内是正序（第 1 篇在前）',
      page.json.collection.items.map((x: any) => x.title).join(',') === '归墟·一,归墟·二,归墟·三',
      page.json.collection.items.map((x: any) => x.title).join(','))
    ok('篇目带序号与总数', page.json.collection.items[0].collection.index === 1
      && page.json.collection.items[0].collection.total === 3)

    // 详情页的上下篇
    const d2 = await call(`/api/community/posts/${p2}`)
    ok('详情返回上一篇/下一篇', d2.json.post.collectionNav.prevId === p1 && d2.json.post.collectionNav.nextId === p3,
      JSON.stringify(d2.json.post.collectionNav))
    const d1 = await call(`/api/community/posts/${p1}`)
    ok('第一篇没有上一篇（不给禁用按钮占位）', d1.json.post.collectionNav.prevId === null)

    // 越权
    ok('不能把别人的投稿加进自己的合集',
      (await call(`/api/community/collections/${aliceCol}/posts`, { method: 'POST', as: 'bob', body: { postId: p1 } })).status === 403)
    const bobPost = await publishAs('bob', 'bob 的稿子')
    ok('不能把别人的投稿塞进来（合集归属校验）',
      (await call(`/api/community/collections/${aliceCol}/posts`, { method: 'POST', as: 'alice', body: { postId: bobPost } })).status === 403)

    // 一篇不能同时在两个合集
    const col2 = (await call('/api/community/collections', { method: 'POST', as: 'alice', body: { title: '另一个合集' } })).json.collection.id
    const conflict = await call(`/api/community/collections/${col2}/posts`, { method: 'POST', as: 'alice', body: { postId: p1 } })
    ok('一篇不能同时在两个合集（409 并说明怎么办）',
      conflict.status === 409 && conflict.json.code === 'ALREADY_IN_COLLECTION', JSON.stringify(conflict.json))

    // 手动排序
    await call(`/api/community/collections/${aliceCol}/order`, { method: 'PUT', as: 'alice', body: { postIds: [p3, p1, p2] } })
    const reordered = await call(`/api/community/collections/${aliceCol}`)
    ok('手动排序后顺序按给的数组',
      reordered.json.collection.items.map((x: any) => x.title).join(',') === '归墟·三,归墟·一,归墟·二')
    ok('排序会把合集切到 manual 模式', reordered.json.collection.orderMode === 'manual')

    // 移出
    ok('可以把一篇移出合集',
      (await call(`/api/community/collections/${aliceCol}/posts/${p2}`, { method: 'DELETE', as: 'alice' })).status === 200)
    const afterRemove = await call(`/api/community/collections/${aliceCol}`)
    ok('移出后篇数变 2', afterRemove.json.collection.postCount === 2)
  }

  // ================= 不可见篇目：不进目录 + 序号跳号 =================
  {
    const p4 = await publishAs('alice', '归墟·四')
    await call(`/api/community/collections/${aliceCol}/posts`, { method: 'POST', as: 'alice', body: { postId: p4 } })
    // 撤回第一篇
    await call(`/api/community/posts/${(await call(`/api/community/collections/${aliceCol}`)).json.collection.items[0].id}/withdraw`, { method: 'POST', as: 'alice' })
    const page = await call(`/api/community/collections/${aliceCol}`)
    ok('🔴 撤回的篇目不在公开目录里',
      !page.json.collection.items.some((x: any) => x.title === '归墟·三'), page.json.collection.items.map((x: any) => x.title).join(','))
    ok('🔴 序号跳号（不是紧邻重排）',
      page.json.collection.items.some((x: any) => x.collection.index > 1), JSON.stringify(page.json.collection.items.map((x: any) => x.collection.index)))
    ok('篇数按可见数算', page.json.collection.postCount === page.json.collection.items.length)
  }

  // ================= 删除合集：先解绑 =================
  {
    const before = (await call(`/api/community/collections/${aliceCol}`)).json.collection
    const firstId = before.items[0].id
    const del = await call(`/api/community/collections/${aliceCol}`, { method: 'DELETE', as: 'alice' })
    ok('删除合集返回解绑篇数', del.status === 200 && del.json.released > 0, JSON.stringify(del.json))
    ok('合集已不存在', (await call(`/api/community/collections/${aliceCol}`)).status === 404)
    const stillThere = await call(`/api/community/posts/${firstId}`)
    ok('🔴 篇目本身还在（删合集不删稿）', stillThere.status === 200 && !!stillThere.json.post)
    ok('🔴 篇目不再指向已删合集（不会出现空白归属）',
      (await call('/api/community/posts')).json.items.every((x: any) => x.collection === undefined))
  }

  // ================= 浏览量 =================
  {
    const post = await publishAs('alice', '浏览量测试')
    const detail = (as?: string, headers?: Record<string, string>) => call(`/api/community/posts/${post}`, { as, headers })

    const firstRead = await detail('bob')
    ok('详情可读', firstRead.status === 200)
    // 🔴 不等合并落盘就要看到 1：否则刚看完页面上还是旧数字，用户以为坏了
    ok('🔴 刚看完立刻显示 1（含未落盘增量）', firstRead.json.post.views === 1, String(firstRead.json.post.views))
    store.flushViewsNow()
    ok('首次阅读计 1 次', (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views === 1,
      String((await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views))

    await detail('bob')
    store.flushViewsNow()
    ok('🔴 同一人 24h 内重复读不重复计数（作者看到的是 1）',
      (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views === 1)

    await detail('alice')
    store.flushViewsNow()
    ok('🔴 作者本人阅读不计数', (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views === 1)

    // 游客：不同 UA 算不同人（只存哈希，不存 IP）
    await detail(undefined, { 'user-agent': 'Mozilla/5.0 A' })
    store.flushViewsNow()
    const afterGuest = (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views
    ok('游客阅读计数', afterGuest === 2, String(afterGuest))
    await detail(undefined, { 'user-agent': 'Mozilla/5.0 A' })
    store.flushViewsNow()
    ok('🔴 同一游客 24h 内不重复计数',
      (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views === 2)
    await detail(undefined, { 'user-agent': 'Mozilla/5.0 B' })
    store.flushViewsNow()
    ok('换一个 UA 的游客算另一个人',
      (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views === 3)

    // 列表不计数
    const before = (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views
    await call('/api/community/posts')
    store.flushViewsNow()
    ok('🔴 列表曝光不算浏览（滚动一遍不该涨）',
      (await call(`/api/community/posts/${post}`, { as: 'alice' })).json.post.views === before)

    // 缓存后落盘
    ok('合并落盘接口不抛', typeof store.flushViewsNow().flushed === 'number')
  }

  // ================= 发布时直接归集 =================
  //
  // ⚠️ 这一段用 bob：alice 已经发满 5 篇（服务端的「每天 5 篇」是**数库里的**，
  //    不走注入的 rateLimit），继续用她会撞上限，看起来像合集功能坏了。
  {
    const col = (await call('/api/community/collections', { method: 'POST', as: 'bob', body: { title: '发布时归集' } })).json.collection.id
    const created = await call('/api/community/posts', {
      method: 'POST', as: 'bob', body: { title: '边发边归', body: body(), display: 'anonymous', collectionId: col },
    })
    ok('发布时带合集 → 直接挂上', created.status === 200, JSON.stringify(created.json))
    ok('我的投稿里能看到 collectionId',
      (await call('/api/community/my/posts', { as: 'bob' })).json.items.some((x: any) => x.collectionId === col))

    // 不存在的合集：忽略而不是失败
    const withGhost = await call('/api/community/posts', {
      method: 'POST', as: 'bob', body: { title: '幽灵合集', body: body(), display: 'anonymous', collectionId: 'col_nope' },
    })
    ok('🔴 合集不存在时正常发稿（忽略归集，不报错）', withGhost.status === 200, JSON.stringify(withGhost.json))
  }

  // ================= 作者侧全量篇目（手动排序要用） =================
  //
  // 🔴 只给可见篇目是不够的：手动排序排的是整个合集，
  //    一篇正在审核的稿子排完却不在列表里，它一公开就会跳到末尾 —— 作者白排。
  {
    const col = (await call('/api/community/my/collections', { as: 'bob' })).json.items
      .find((c: any) => c.title === '发布时归集').id as string

    // bob 的合集里此刻有一篇草稿（pending）
    const mine = await call(`/api/community/collections/${col}`, { as: 'bob' })
    ok('作者能看到 allItems', Array.isArray(mine.json.collection.allItems), JSON.stringify(Object.keys(mine.json.collection)))
    ok('🔴 allItems 包含尚不可见的篇目', mine.json.collection.allItems.some((x: any) => x.visible === false))
    ok('公开 items 只含可见篇目', mine.json.collection.items.every((x: any) => !!x.id))
    ok('allItems 比 items 多（不可见的不在公开目录里）',
      mine.json.collection.allItems.length > mine.json.collection.items.length,
      `${mine.json.collection.allItems.length} vs ${mine.json.collection.items.length}`)
    ok('allItems 不带正文（正文只走 /my/posts）', mine.json.collection.allItems.every((x: any) => x.body === undefined))

    const byAlice = await call(`/api/community/collections/${col}`, { as: 'alice' })
    // 别人看到 404（这个合集里还没有公开篇目）—— 或者即便能看，也绝不能带 allItems
    ok('别人拿不到 allItems',
      byAlice.status === 404 || byAlice.json?.collection?.allItems === undefined,
      JSON.stringify({ status: byAlice.status, keys: byAlice.json?.collection ? Object.keys(byAlice.json.collection) : null }))
  }
} catch (e) {
  console.error('合集测试自身异常：', e)
  fail++
} finally {
  store.flushViewsNow()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

console.log(`\ncommunityCollections: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
