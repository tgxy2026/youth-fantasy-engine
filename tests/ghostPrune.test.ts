// ============ 幽灵索引清理 · 安全前置（复判 / 备份 / 不误伤 / 写盘锁闸）============
//
// 背景：数据体检第 5 类把「酒馆列表残留」报出来了，并在卡片上给了「清理」按钮。
// 但幽灵的判据是「索引项在、分条**读不到**」，而**读不到 ≠ 不存在** —— 桌面版数据文件读不出来时
// 所有分条都读不到，那一刀下去会把**还能恢复**的索引整片删掉且不可逆。
// 所以界面不直接调裸的 `pruneGhost*`，一律走 `pruneGhostsSafely`（写盘锁拒绝 / 二次复判 / 先备份）。
//
// ⚠️ 两组断言**在测试环境覆盖不到**，如实记在这里，别以为它们被验过：
//    · **写盘锁分支**：闸门是 `DESKTOP && getDesktopState().writeLocked`，而测试环境 `DESKTOP`
//      恒为 false（与 dev 浏览器同理）→ 只能保证「不误挡」，挡的那一侧靠与 `enableDesktopCloudSync`
//      的同构先例 + 代码审查（负面对照脚本会注入"恒挡"来证明"被挡时确实不动数据"）。
//    · **复判真正救场的那一次**：需要"第一次读不到、隔 200ms 又能读到"，mock 存储造不出这种瞬时失败。
//      这里只能证明复判**不碍事**（正常情况下照清）。
import * as db from '../src/lib/db'
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { GHOST_BACKUP_PREFIX, ghostPruneBlockedReason, pruneGhostsSafely } from '../src/lib/tavern/store'
import type { TavernSessionIndexItem, TavernCharIndexItem } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const K_SESSION = 'tavern.sessionIndex'
const K_CHAR = 'tavern.charIndex'

function mkSession(title: string) {
  return {
    title,
    mode: 'immersive' as const,
    anchorChapterId: 'ch1',
    anchorChapterLabel: '第1章 · 起始',
    cast: [{ cardId: 'c1', role: 'user' as const, tabId: 'char-main', name: '李默' }],
    scene: { place: '山门', time: '清晨', present: ['李默'], description: '' },
    model: { providerId: 'p1' },
    params: {},
  }
}

/** 往会话索引里塞一条幽灵（只写索引、不写分条） */
async function pushGhostSession(id: string, title: string) {
  const idx = await db.getSetting<TavernSessionIndexItem[]>(K_SESSION, [])
  idx.push({ id, title, mode: 'immersive', castBrief: '', anchorTitle: '', updatedAt: Date.now() })
  await db.setSetting(K_SESSION, idx)
}

async function pushGhostChar(id: string, name: string) {
  const idx = await db.getMeta<TavernCharIndexItem[]>(K_CHAR, [])
  idx.push({ id, name, storyId: '', updatedAt: Date.now() })
  await db.setMeta(K_CHAR, idx)
}

async function main() {
  __resetMockStores()
  const proj = await db.createProject('幽灵清理测试项目')
  db.setCurrentProject(proj.id)

  // ---------- 1) 非桌面环境不得误挡 ----------
  ok('非桌面环境前置闸放行（writeLocked 恒 false）', ghostPruneBlockedReason() === '',
    `实际=${JSON.stringify(ghostPruneBlockedReason())}`)

  // ---------- 2) 正常清理：真清掉 + 回报条数 + 留备份 ----------
  let backupKey = ''
  {
    await pushGhostSession('g1', '幽灵甲')
    await pushGhostSession('g2', '幽灵乙')
    const good = await store.createSession(mkSession('正常场'))   // 索引 + 分条都在

    const r = await pruneGhostsSafely('sessions')
    ok('清掉 2 条幽灵', r.pruned === 2, `实际=${r.pruned}`)
    ok('没有被前置闸挡下', !r.blocked, r.blocked)
    ok('清掉即索引里再也查不到', (await store.listSessions()).every(x => x.id !== 'g1' && x.id !== 'g2'))
    ok('🔴 正常会话毫发无损（没被连带清掉）', (await store.listSessions()).some(x => x.id === good.id))
    ok('🔴 正常会话的分条也还在（清理只动索引）', (await store.getSession(good.id))?.title === '正常场')
    ok('返回了备份键且前缀正确', !!r.backupKey && r.backupKey.startsWith(GHOST_BACKUP_PREFIX), r.backupKey)
    backupKey = r.backupKey ?? ''

    const backup = await db.getMeta<{ id: string; title: string }[]>(backupKey, [])
    ok('备份里是把被删的那两条整条存下来了（含标题，事后认得出）',
      backup.length === 2 && backup.map(x => x.title).sort().join('、') === '幽灵乙、幽灵甲',
      JSON.stringify(backup.map(x => x.title)))
  }

  // ---------- 3) 没有幽灵时：不动作、不留空备份 ----------
  {
    const r = await pruneGhostsSafely('sessions')
    ok('无幽灵时 pruned=0', r.pruned === 0, `实际=${r.pruned}`)
    ok('无幽灵时不产生新备份键（不留空档）', !r.backupKey, r.backupKey)
  }

  // ---------- 4) 分组互不越界 ----------
  {
    await pushGhostChar('c-ghost', '幽灵角色')
    await pushGhostSession('g3', '幽灵丙')
    const r = await pruneGhostsSafely('sessions')
    ok('清 sessions 不动 freeChars', (await store.listFreeChars()).some(x => x.id === 'c-ghost'))
    ok('结果里的 group 如实回报', r.group === 'sessions' && r.pruned === 1, `${r.group}/${r.pruned}`)

    const r2 = await pruneGhostsSafely('freeChars')
    ok('再清 freeChars 才轮到它', r2.pruned === 1 && (await store.listFreeChars()).every(x => x.id !== 'c-ghost'))
  }

  // ---------- 5) 备份可回滚：把备份里的项写回索引，条目又能看见了 ----------
  {
    const backup = await db.getMeta<TavernSessionIndexItem[]>(backupKey, [])
    ok('前置：备份里有 2 条', backup.length === 2)
    const idx = await db.getSetting<TavernSessionIndexItem[]>(K_SESSION, [])
    await db.setSetting(K_SESSION, [...idx, ...backup])
    const titles = (await store.listSessions()).map(x => x.title)
    ok('回滚后索引里又能看到它们（备份确实是可用的救济）',
      titles.includes('幽灵甲') && titles.includes('幽灵乙'), titles.join('、'))
  }

  console.log(`\nghostPrune: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
