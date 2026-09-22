// ============ 酒馆模式 · 模型就绪判定（2026-09-22 六维审计 F1）============
//
// 【为什么必须单独测这一条】
// `tests/uiUxGuards.test.ts` 钉住了「TavernFree / InterviewChat 不许用全局就绪 Hook」，
// 理由是酒馆的模型来源是**三层兜底链**（会话 model → 面板 defaultProviderId → 全局活动模型），
// 而不是全局活动模型一个。既然禁了全局判据，就必须有一个**对**的判据顶上 ——
// 否则「不许用 A」的结果会退化成「干脆不加守卫」，F1 原意（点了才知道不行）又回来了。
//
// 本文件守的正是这个替身判据 `checkTavernReady`：
//   ① 全局活动模型为空、但面板指定了可用模型 → **必须 ready**（这正是全局判据会误禁的场景）；
//   ② 三层都没配 → 不 ready，且**不抛**（渲染期守卫抛会炸组件）；
//   ③ 会话指定的模型已被删除 → 回退，而不是判未就绪（与 resolveTavernProvider 同源）。
import { checkTavernReady } from '../src/lib/tavern/provider'
import { saveProviders, saveActiveId, type AIProvider } from '../src/lib/ai'
import { K_TAVERN_SETTINGS, DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 造一个配置完整的 provider（precheck 能过：有 baseUrl、有 model） */
const usable = (id: string, name: string, model = 'stub'): AIProvider =>
  ({ id, name, type: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model })

/** 写「面板默认模型」这一层 */
async function setPanelDefault(id: string) {
  await db.setMeta(K_TAVERN_SETTINGS, {
    ...DEFAULT_TAVERN_SETTINGS,
    common: { ...DEFAULT_TAVERN_SETTINGS.common, defaultProviderId: id },
  })
}

async function main() {
  // ---------- ① 全局活动模型为空 + 面板指定可用模型 → 必须 ready ----------
  //   🔴 这是全局就绪判据会**误禁**的那一类配置：作者没在「模型配置」里设活动模型，
  //      只在酒馆控制面板里挑了一个。
  //
  //   ⚠️ 关键设计：库里放**两个**模型，让「面板挑的那个」**不是列表第一个**。
  //      因为全局判据（`resolveActive`）在活动 id 为空时会兜底取 `list[0]` ——
  //      若面板模型恰好也是 list[0]，全局判据会**碰巧**判成 ready，
  //      这条断言就失去判别力（负面对照实测：第一版就踩了这个，只认全局的实现仍通过）。
  //      把顺序错开，才能让「判据到底看没看面板」暴露出来。
  {
    __resetMockStores()
    await saveProviders([usable('p-first', '列表第一个'), usable('p-panel', '面板模型')])
    await saveActiveId(null)          // 全局活动模型 = 空
    await setPanelDefault('p-panel')  // 面板兜底层有效（**不是** list[0]）

    const info = await checkTavernReady()
    ok('🔴 全局未设活动模型、但面板指定了可用模型 → ready（正是全局判据会误禁的场景）', info.ready)
    ok('  · 就绪时给出**面板那个**模型的标识（判据确实读了面板，而非兜底取了 list[0]）',
      info.label.includes('面板模型') && info.label.includes('stub'), info.label)
    ok('  · 命中的是面板默认模型，不算回退', info.fellBack === false)
  }

  // ---------- ② 三层都没配 → 不 ready，且不抛 ----------
  //   🔴 守卫是**渲染期**调用的：未配置时抛出去会炸掉整个组件。
  //      `resolveTavernProvider` 内部走 `requireActiveProvider()` 是会抛的，
  //      checkTavernReady 必须把它转成 ready:false。
  {
    __resetMockStores()
    await saveProviders([])
    await saveActiveId(null)
    await setPanelDefault('')  // 面板留空 = 跟随全局

    let threw = false
    let info = { ready: true, label: 'x', fellBack: false }
    try {
      info = await checkTavernReady()
    } catch {
      threw = true
    }
    ok('🔴 三层都没配 → 返回 ready:false，且**绝不抛**（渲染期守卫抛会炸组件）', !threw && !info.ready)
  }

  // ---------- ③ 会话指定的模型已被删除 → 回退，而不是判未就绪 ----------
  //   🔴 与 `resolveTavernProvider` 同源：指定的那个找不到就往下兜底。
  //      否则「删了一个用过的模型」会让整个酒馆被判成未就绪。
  {
    __resetMockStores()
    await saveProviders([usable('p-global', '全局模型')])
    await saveActiveId('p-global')
    await setPanelDefault('')

    const info = await checkTavernReady({ providerId: 'p-gone' }) // 这个 id 库里没有
    ok('🔴 会话指定的模型已被删除 → 回退到全局可用模型（不判未就绪）', info.ready)
    ok('  · 回退时 fellBack = true（界面可据此提示）', info.fellBack === true)
  }

  // ---------- ④ 会话自己指定了可用模型 → 优先用它（不依赖面板 / 全局） ----------
  //   同样把会话模型放到**列表第二个**，确保断言能区分「读了会话」与「兜底取 list[0]」。
  {
    __resetMockStores()
    await saveProviders([usable('p-first2', '列表第一个2', 'first2'), usable('p-sess', '会话模型', 'sess-model')])
    await saveActiveId(null)
    await setPanelDefault('')

    const info = await checkTavernReady({ providerId: 'p-sess' })
    ok('🔴 会话指定的可用模型优先（会话 → 面板 → 全局，与发请求那条链同序）',
      info.ready && info.label.includes('会话模型') && info.fellBack === false, info.label)
  }

  // ---------- ⑤ 全局活动模型可用（传统路径）→ 仍然 ready ----------
  //   回归保险：新判据不能把「就是老老实实用全局模型」的常规场景弄坏。
  {
    __resetMockStores()
    await saveProviders([usable('p-global2', '全局模型2', 'g2')])
    await saveActiveId('p-global2')
    await setPanelDefault('')

    const info = await checkTavernReady()
    ok('常规场景（全局活动模型可用）仍判就绪 —— 新判据不影响传统路径',
      info.ready && info.label.includes('全局模型2'), info.label)
  }

  console.log(`\n—— tavernReady 用例结束：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exit(1)
}

void main()
