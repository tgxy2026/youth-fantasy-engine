// ============ 联网检索设置：搬家 + 迁移 + 旧键清理 ============
//
// 这次把设置从「酒馆设置里的一个字段」搬成了**全局键 app.search**（联网检索是全局能力）。
// 三件事必须锁住：
//  ① 老数据搬得过来（用户配好的密钥/引擎不会因为改存储位置而丢）；
//  ② 新位置说了算（两边都有值时以新位置为准，不会来回抖）；
//  ③ 旧键必须被剔干净（mergeDeep 会把「默认值里已没有的键」从旧记录/旧预设里照抄回来，
//     不剔就一直躺在库里被反复写回 —— 这类「死配置」本项目已经清过好几个）。
import * as db from '../src/lib/db'
import { getSearchSettings, saveSearchSettings, K_APP_SEARCH } from '../src/lib/settings/searchSettings'
import {
  getTavernSettings, saveTavernSettings, DEFAULT_TAVERN_SETTINGS, K_TAVERN_SETTINGS,
} from '../src/lib/tavern/settings'
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from '../src/lib/ai/webSearch'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const legacyCfg: SearchSettings = {
  mode: 'api', engine: 'searxng', endpoint: 'http://127.0.0.1:8888/search?q={query}', apiKey: '', topK: 7,
}

async function rawTavern(): Promise<Record<string, unknown> | null> {
  return db.getMeta<Record<string, unknown> | null>(K_TAVERN_SETTINGS, null)
}

async function main() {
  // ---------- ① 空库：出厂默认 ----------
  {
    __resetMockStores()
    const s = await getSearchSettings()
    ok('空库读到出厂值（默认关，零配置可用）',
      s.mode === 'off' && s.engine === DEFAULT_SEARCH_SETTINGS.engine, JSON.stringify(s))
    ok('空库不会顺手往库里写东西（读操作不该有副作用）',
      (await db.getMeta<unknown>(K_APP_SEARCH, null)) === null)
  }

  // ---------- ② 老位置 → 新位置（一次性迁移）----------
  {
    __resetMockStores()
    await db.setMeta(K_TAVERN_SETTINGS, { ...DEFAULT_TAVERN_SETTINGS, search: legacyCfg })
    const s = await getSearchSettings()
    ok('🔴 老数据搬得过来（配好的引擎/地址不丢）',
      s.mode === 'api' && s.engine === 'searxng' && s.topK === 7 && s.endpoint === legacyCfg.endpoint,
      JSON.stringify(s))
    const moved = await db.getMeta<SearchSettings | null>(K_APP_SEARCH, null)
    ok('🔴 搬完就地落到新键（下次直接读新位置）',
      !!moved && moved.engine === 'searxng' && moved.topK === 7, JSON.stringify(moved))
    ok('补齐了老数据缺的字段', moved?.mode === 'api')
  }

  // ---------- ③ 新位置优先 ----------
  {
    __resetMockStores()
    await db.setMeta(K_APP_SEARCH, { ...DEFAULT_SEARCH_SETTINGS, mode: 'off', engine: 'bocha', topK: 2 })
    await db.setMeta(K_TAVERN_SETTINGS, { ...DEFAULT_TAVERN_SETTINGS, search: legacyCfg })
    const s = await getSearchSettings()
    ok('🔴 两边都有值时以新位置为准（不会来回抖）', s.engine === 'bocha' && s.topK === 2, JSON.stringify(s))

    const saved = await saveSearchSettings({ ...s, mode: 'api', apiKey: 'sk-abc' })
    ok('保存回执 = 落库内容', saved.apiKey === 'sk-abc' && saved.mode === 'api')
    const reread = await getSearchSettings()
    ok('保存后读回一致', reread.apiKey === 'sk-abc' && reread.mode === 'api', JSON.stringify(reread))
    ok('保存时缺字段用出厂值补（不会写出半个对象）',
      reread.topK === 2 && reread.engine === 'bocha')
  }

  // ---------- ④ 旧键必须被剔掉 ----------
  {
    __resetMockStores()
    // 模拟老库 / 老预设：TavernSettings 里带着 search
    await db.setMeta(K_TAVERN_SETTINGS, { ...DEFAULT_TAVERN_SETTINGS, search: legacyCfg })
    const eff = await getTavernSettings()
    ok('🔴 读出来的**有效设置**里没有旧键（应用层永远看不到它）',
      !('search' in (eff as unknown as Record<string, unknown>)))
    // ⚠️ 读操作**不落盘**（getter 不该有副作用，与 free.defaultUserCharId 的老做法一致）：
    //    库里那条老记录会一直带着 search 键，直到下一次保存才被写干净。
    //    所以这里只断言「有效值已剔除」，落盘那半边由下面的保存侧断言负责。
    const after = await rawTavern()
    ok('读不改库（老记录原样留着，等下次保存再清）', !!after && 'search' in after)

    // 应用一个「老结构的预设」：写进去也不许留下 search
    __resetMockStores()
    const applied = await saveTavernSettings({
      ...DEFAULT_TAVERN_SETTINGS, search: legacyCfg,
    } as unknown as typeof DEFAULT_TAVERN_SETTINGS)
    ok('🔴 保存侧也剔旧键（老预设经过一次应用也不会把它带回库里）',
      !('search' in (applied as unknown as Record<string, unknown>)), JSON.stringify(applied))

    __resetMockStores()
    await saveTavernSettings({ ...DEFAULT_TAVERN_SETTINGS, search: legacyCfg } as unknown as typeof DEFAULT_TAVERN_SETTINGS)
    const onDisk = await rawTavern()
    ok('库里的酒馆设置也确实没有 search 键',
      !!onDisk && !('search' in onDisk), JSON.stringify(Object.keys(onDisk ?? {})))
  }

  // ---------- ⑤ 酒馆设置本身没被改坏 ----------
  {
    __resetMockStores()
    const t = await getTavernSettings()
    ok('酒馆设置照常读得到（协议与预算都在）',
      typeof t.protocol === 'string' && t.protocol.length > 100 && t.common.contextBudget > 0)
    ok('酒馆设置里不再有 search 字段', !('search' in (t as unknown as Record<string, unknown>)))
  }

  console.log('')
  console.log(`共 ${pass + fail} 条：PASS ${pass} · FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
