// ============ 酒馆模式 · 故事层与「删故事不删卡」（老大 2026-09-16 定的红线）============
//
// 这组断言盯的是一条**红线**和一条**容易悄悄坏掉的分组逻辑**：
//   ① 删故事 → 其下**剧本一并删**（剧本是子节点，留着就是孤儿），
//      但**角色卡一张都不能删**，只解除归属（卡连着记忆与日记，删不得）；
//   ② 角色卡与对话都有「未归属」的去处 —— 没有出口的自由状态等于变相丢数据；
//   ③ 会话的归属优先用自己存的 storyId，推不出时才按在场角色反推，绝不错挂到别的故事上。
import * as db from '../src/lib/db'
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { createStory, listStories, getStory, deleteStory, storyDisplayName, emptyStory } from '../src/lib/tavern/story'
import { emptyScript, saveScript, listScriptsByStory } from '../src/lib/tavern/script'
import { sessionStoryId, cardStoryId, type FreeCharacter } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function mkChar(name: string, storyId: string): Promise<FreeCharacter> {
  return store.createFreeChar({ ...store.emptyFreeCharacter(), storyId, name })
}

/** 逐卡改归属（界面走的就是这条路：读整卡 → 写回） */
async function rebindOne(id: string, storyId: string): Promise<void> {
  const full = await store.getFreeChar(id)
  if (full) await store.saveFreeChar({ ...full, storyId })
}

async function main() {
  __resetMockStores()
  db.setCurrentProject('story-tree-proj')

  // ---------- 1) 故事 CRUD 与索引成对 ----------
  const A = await createStory({ name: '云州江湖' })
  const B = await createStory({ name: '青丘岁月' })
  {
    const list = await listStories()
    ok('建了两个故事', list.length === 2)
    ok('列表含两个名字', list.map(s => s.name).sort().join('|') === '云州江湖|青丘岁月')
    // 契约是「按 updatedAt 非递增」，不赌同毫秒内的相对顺序（两个故事可能就是同一毫秒建的）
    ok('按更新时间倒序（非递增）', list.every((s, i) => i === 0 || list[i - 1].updatedAt >= s.updatedAt))
    ok('分条可读回', (await getStory(A.id))?.name === '云州江湖')
    ok('故事名兜底', storyDisplayName({ name: '' }) === '（未命名故事）')
  }

  // ---------- 2) 每个故事下的剧本各自成组 ----------
  await saveScript({ ...emptyScript(), storyId: A.id, name: '雨夜便利店' })
  await saveScript({ ...emptyScript(), storyId: A.id, name: '清晨集市' })
  await saveScript({ ...emptyScript(), storyId: B.id, name: '青丘初见' })
  {
    ok('A 故事下两份剧本', (await listScriptsByStory(A.id)).length === 2)
    ok('B 故事下一份剧本', (await listScriptsByStory(B.id)).length === 1)
    ok('按故事分组不串味', (await listScriptsByStory(A.id)).every(s => s.storyId === A.id))
  }

  // ---------- 3) 角色卡归属 ----------
  const c1 = await mkChar('云昭', A.id)
  await mkChar('阿禾', A.id)
  await mkChar('小狐狸', B.id)
  const cFree = await mkChar('流浪者', '')
  {
    ok('A 故事下两张卡', (await store.listCharsByStory(A.id)).length === 2)
    ok('B 故事下一张卡', (await store.listCharsByStory(B.id)).length === 1)
    ok('自由状态的卡单独一枚', (await store.listUnboundChars()).some(c => c.id === cFree.id))
    ok('归属非空的卡不算自由状态', !(await store.listUnboundChars()).some(c => c.id === c1.id))
    ok('cardStoryId 把 undefined 归一成空串', cardStoryId({ storyId: undefined }) === '' && cardStoryId(null) === '')
  }

  // ---------- 4) 解除归属 / 重新归类 ----------
  {
    const n = await store.rebindCharsStory(B.id, A.id)
    ok('整批改归属返回受影响张数', n === 1)
    ok('改完 B 故事下没人了', (await store.listCharsByStory(B.id)).length === 0)
    ok('改完 A 故事下多了一张', (await store.listCharsByStory(A.id)).length === 3)
    const back = await store.rebindCharsStory(A.id, '')
    ok('传空串 = 整批退回自由状态', back === 3 && (await store.listCharsByStory(A.id)).length === 0)
    ok('退回的卡都能在「未归属」里找到', (await store.listUnboundChars()).length === 4)
    /**
     * 来源为空 → 函数**刻意**什么都不做（`if (!fromStoryId) return 0`）。
     * 「把全部未归属的卡一次性挂进某故事」在界面上是按卡改下拉做的，
     * 这里留一个空来源守卫，免得哪个调用方传了个坏 id 就把所有自由卡一起改走 —— 那是不可逆的。
     */
    const refused = await store.rebindCharsStory('', A.id)
    ok('来源为空时不整批捞卡（守卫住「误传 id 改走所有自由卡」）', refused === 0)
    ok('守卫后自由卡一张没动', (await store.listUnboundChars()).length === 4)
    // 逐卡挂回（界面走的就是这条路）
    for (const c of await store.listUnboundChars()) {
      await rebindOne(c.id, A.id)
    }
    ok('逐卡挂回后 A 故事下齐了', (await store.listCharsByStory(A.id)).length === 4)
  }

  // ---------- 5) 🔴 删故事：剧本删、角色卡一张不删 ----------
  {
    const charsBefore = (await store.listFreeChars()).length
    const res = await deleteStory(A.id)

    ok('删故事返回「解绑了几张卡」', res.reboundChars === 4)
    ok('故事本身没了', !(await listStories()).some(s => s.id === A.id))
    ok('其下剧本一并删掉（不留孤儿）', (await listScriptsByStory(A.id)).length === 0)
    ok('其它故事的剧本不受影响', (await listScriptsByStory(B.id)).length === 1)
    ok('🔴 角色卡一张都不少', (await store.listFreeChars()).length === charsBefore)
    ok('原属该故事的卡全部转成自由状态', (await store.listCharsByStory(A.id)).length === 0)
    ok('它们都在「未归属」里等作者重新归类',
      (await store.listUnboundChars()).length === charsBefore)
  }

  // ---------- 6) 会话归属：自己存的优先，推不出才反推 ----------
  {
    const st = (await listStories())[0]
    const free = await store.listFreeChars()

    ok('会话自己存了归属就用自己的', sessionStoryId({ storyId: 's-explicit', charIds: [free[0].id] }, free) === 's-explicit')
    ok('推不出归属 → 空串（落「未归属」而不是从列表消失）', sessionStoryId({ charIds: [free[0].id] }, free) === '')
    ok('在场角色全查不到 → 空串', sessionStoryId({ charIds: ['不存在-1', '不存在-2'] }, free) === '')
    ok('空会话 → 空串', sessionStoryId(null, free) === '')

    // 把卡挂到故事 B 之后，同一场对话就该反推成 B
    for (const c of free) await rebindOne(c.id, st.id)
    const bound = await store.listFreeChars()
    ok('按在场角色反推（卡归属变了，会话跟着归组）',
      sessionStoryId({ charIds: [bound[0].id] }, bound) === st.id)
    ok('会话显式存的归属压过反推结果',
      sessionStoryId({ storyId: 's-explicit', charIds: [bound[0].id] }, bound) === 's-explicit')
  }

  // ---------- 7) 故事名上限与空态 ----------
  {
    const fresh = emptyStory()
    ok('空故事有稳定默认值', fresh.name === '' && fresh.setting === '')
    const long = await createStory({ name: 'x'.repeat(80) })
    ok('超长故事名被截断（列表里不撑破）', long.name.length <= 40)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
