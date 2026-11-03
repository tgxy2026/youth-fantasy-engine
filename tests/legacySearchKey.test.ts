// ============ 老库检索密钥残留清理（2026-09-23 六维审计 P1）============
//
// 病根：云盘同步是**整条 key-value** 写出，没法只排除某个字段。`EXCLUDED_META_KEYS` 里已经有
// `app.search`，但这个密钥在**老库里还有第二份载体** —— 2026-09-15 搬家前它挂在
// `tavern.settings.search` 上。写入侧（saveTavernSettings）与升级路径（upgradeLegacyDefaults）
// 都会剔它，唯独「从没保存过酒馆设置」的老库会一直留着 ⇒ 开启云盘同步后 apiKey 随 .yfe 落到网盘，
// 而检索设置面板的密钥栏明确承诺「只存本机、不会上传到任何服务器」。
//
// 这里钉住四件事：
//   ① 真能清掉（且**只清 search**，不伤同一条记录里的其它设置字段）；
//   ② 记录本身留着（是剔除字段，不是整条删掉）；
//   ③ 幂等 —— 可反复跑，第二遍不该再写盘；
//   ④ 记录不存在 / 本来就没有 search 时不炸、也不瞎写。
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ legacySearchKey')

__resetMockStores()

const { ops } = await import('../src/lib/db/core')
const { migrateLegacySearchKey } = await import('../src/lib/db/migrations')

/** 塞一条 meta 记录 / 读它的 JSON 文本（用 JSON 断言可绕开 Record<string,unknown> 的取值收窄） */
const putMeta = (key: string, value: unknown) => ops.put('meta', { key, value })
const metaText = async (key: string) => JSON.stringify(await ops.get('meta', key))

const SECRET = 'sk-LEGACY-SECRET-9f3a'

// ---------- 1. 老库形态：tavern.settings 里嵌着 search ----------
{
  await putMeta('tavern.settings', {
    common: { defaultProviderId: 'p1' },
    free: { longTermLimit: 1200 },
    search: { provider: 'bing', apiKey: SECRET },
  })
  // 新位置也放一份：确认清理**不误伤**它
  await putMeta('app.search', { provider: 'bing', apiKey: 'sk-NEW' })

  ok('前置：老库记录里确实带着 search 密钥',
    (await metaText('tavern.settings')).includes(SECRET))

  const n1 = await migrateLegacySearchKey()
  ok('🔴 清掉了一条残留（返回 1）', n1 === 1, String(n1))

  const after = await metaText('tavern.settings')
  ok('🔴 密钥字符串已不在 meta 记录里（不会再随 .yfe 上云）', !after.includes(SECRET), after.slice(0, 90))
  ok('🔴 只清 search：同一条记录里的其它设置字段原样保留',
    after.includes('"defaultProviderId":"p1"') && after.includes('"longTermLimit":1200'), after.slice(0, 120))
  ok('记录本身还在（是剔字段，不是整条删掉）', after.includes('tavern.settings'), after.slice(0, 60))
  ok('🔴 不误伤新位置 app.search',
    (await metaText('app.search')).includes('sk-NEW'))

  const n2 = await migrateLegacySearchKey()
  ok('幂等：再跑一遍返回 0（不反复写盘）', n2 === 0, String(n2))
  ok('幂等：第二遍之后内容依然正确',
    !(await metaText('tavern.settings')).includes(SECRET))
}

// ---------- 2. 记录不存在 / 本来就没有 search：不炸、不瞎写 ----------
{
  __resetMockStores()
  ok('记录不存在时返回 0 且不抛', (await migrateLegacySearchKey()) === 0)

  await putMeta('tavern.settings', { common: { defaultProviderId: 'p2' } })
  ok('本来就没有 search 时返回 0', (await migrateLegacySearchKey()) === 0)
  ok('本来就没有 search 时内容一字未动（不是"写一遍看起来一样的"）',
    (await metaText('tavern.settings')).includes('"defaultProviderId":"p2"'))

  // 边界：value 不是对象（被外部写坏）时也不能炸
  await ops.put('meta', { key: 'tavern.settings', value: 'not-an-object' })
  let threw = ''
  try { await migrateLegacySearchKey() } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  ok('value 不是对象时不抛（最坏情况与修复前等价）', threw === '', threw || '(没抛)')
}

console.log(`\nlegacySearchKey: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
