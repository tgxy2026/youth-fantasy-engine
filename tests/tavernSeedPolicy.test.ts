// ============ 出厂数据 · 项目原生不携带角色卡（老大 2026-09-15 定）============
//
// 这条策略两半，少锚住任何一半都会出事故：
//   ① **新库不播卡** —— 原生不带角色卡，卡由老大按 `.taverncards.json` 导入；
//      哪天有人"顺手"把播种加回来，这里会响。
//   ② **老库的卡一张不少、内容不被覆盖** —— 只删播种，绝不反向删用户数据。
//      这是老大最在意的一条：老用户升级后打开，卡必须还在。
//
// 背景：2026-09-15 之前，建示范项目时会顺带把 6 张示范自由卡播进全局 meta；
// 这批卡每次改版都要同步旧指纹/旧示例/断言（`LEGACY_SEED_*`），纯负担，
// 故整批摘除（`seedCardData.ts` / `seedCards.ts` 已删，见 commit 记录）。
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { createDemoProject } from '../src/lib/app/seedData'
import { emptyFreeCharacter } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  __resetMockStores()

  // ---------- ① 空库建示范项目：一张角色卡都不该出现 ----------
  await createDemoProject()
  const afterSeed = await store.listFreeChars()
  ok('建示范项目后不播种任何角色卡（原生不携带）', afterSeed.length === 0, `实际 ${afterSeed.length} 张`)

  // ---------- ② 模拟老库：手工放三张卡（含带历史来源标记的），重建示范项目后必须原封不动 ----------
  const mine = await store.createFreeChar({
    ...emptyFreeCharacter(), name: '我自己的卡', world: '我的手写世界观',
  })
  // 老库里的卡会带 `seededFrom`（旧的来源标记）；摘除种子后该字段只是历史残留，不该影响任何判断
  const legacy = await store.createFreeChar({
    ...emptyFreeCharacter(), name: '苏念', world: '老库里的卡，作者改过一点', seededFrom: '苏念',
  })
  const renamed = await store.createFreeChar({
    ...emptyFreeCharacter(), name: '改名过的老卡', world: '原示范卡改名后的正文', seededFrom: '洛汐',
  })

  await createDemoProject() // 幂等重建路径（界面「创建示范项目」按钮走的就是它）

  const after = await store.listFreeChars()
  ok('重建示范项目后老库的卡一张不少', after.length === 3, `实际 ${after.length} 张`)
  ok('自建卡的内容没被覆盖', (await store.getFreeChar(mine.id))?.world === '我的手写世界观')
  ok('老示范卡的内容没被覆盖（作者改过的一点点还在）',
    (await store.getFreeChar(legacy.id))?.world === '老库里的卡，作者改过一点')
  ok('改名过的老卡不会被按名字匹配回灌',
    (await store.getFreeChar(renamed.id))?.world === '原示范卡改名后的正文')
  ok('索引与分条仍然成对（三张都能逐张取到）',
    (await Promise.all(after.map(x => store.getFreeChar(x.id)))).every(Boolean))

  console.log(`\ntavernSeedPolicy: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
