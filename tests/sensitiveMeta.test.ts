// ============ 敏感 meta / 设置键判据 + 三条出口的剥离（2026-10-13）============
//
// 病根（社区反馈）：「导出数据文件」原本是**整库原样倒出**，`meta.aiProviders` 里的
// apiKey 明文跟着走 —— 而这份副本被文案引导为「留档 / 搬机」，作者会把它丢云盘、发给别人。
// 另外 1.5.0 之前 AI 配置按项目存在 `settingsKV`（键名同为 `aiProviders`），迁移到全局后
// 旧键不删 ⇒ `exportProject()` 按 `<项目id>::` 前缀全收，把它打进备份文件 / 迁移包。
//
// 本文件钉住四件事：
//   ① 纯判据：键名清单 + 值探测（只看键名，不误判正文里的同名词）；
//   ② `stripSensitiveMeta` **不改原对象**（改了就等于把运行中的密钥从内存库删掉）；
//   ③ `exportProject()` 不会把项目级密钥设置打进 bundle；
//   ④ `migrateLegacyProjectAiKeys()` 清残留，但**不误删**迁移标记键。
import * as db from '../src/lib/db'
import { ops } from '../src/lib/db/core'
import { createDemoProject } from '../src/lib/app/seedData'
import {
  isSensitiveMetaKey, valueHasSecretField, isSensitiveSettingKey, stripSensitiveMeta,
} from '../src/lib/storage/sensitiveMeta'
import { migrateLegacyProjectAiKeys } from '../src/lib/db/migrations'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ sensitiveMeta')

// ---------- 1. 纯判据 ----------
{
  ok('🔴 清单命中 aiProviders', isSensitiveMetaKey('aiProviders'))
  ok('🔴 清单命中 app.search', isSensitiveMetaKey('app.search'))
  ok('非敏感键不命中（welcomeDone）', !isSensitiveMetaKey('welcomeDone'))
  ok('非字符串不命中（null）', !isSensitiveMetaKey(null))

  // 值探测：命中
  ok('值探测：顶层 apiKey', valueHasSecretField({ apiKey: 'sk-x' }))
  ok('值探测：嵌套两层', valueHasSecretField({ a: { b: { secretKey: 's' } } }))
  ok('值探测：数组里的对象', valueHasSecretField([{ ok: 1 }, { password: 'p' }]))
  ok('值探测：驼峰 accessToken', valueHasSecretField({ accessToken: 't' }))
  // 值探测：不命中
  ok('值探测：普通设置不误判', !valueHasSecretField({ kbInBackup: true, topK: 5 }))
  ok('🔴 值探测只看键名：正文里出现 "token" 这个词不误判',
    !valueHasSecretField({ world: '苍澜大陆的令牌（token）制度……' }))
  ok('值探测：null / 原始值不炸', !valueHasSecretField(null) && !valueHasSecretField('x'))

  // 项目级设置判据
  ok('🔴 项目级旧键 aiProviders 命中', isSensitiveSettingKey('aiProviders'))
  ok('值里藏密钥的任意键也命中', isSensitiveSettingKey('myCustomThing', { apiKey: 'sk-x' }))
  ok('普通项目设置不命中（kbInBackup）', !isSensitiveSettingKey('kbInBackup', true))
  ok('普通项目设置不命中（tavern.world 长文本）',
    !isSensitiveSettingKey('tavern.world', { brief: '灵历 3024 年，神族牧苍澜……' }))
}

// ---------- 2. stripSensitiveMeta 必须换新对象 ----------
{
  const meta = {
    aiProviders: { key: 'aiProviders', value: [{ id: 'p1', apiKey: 'sk-LIVE' }] },
    'app.search': { key: 'app.search', value: { apiKey: 'sk-SEARCH' } },
    welcomeDone: { key: 'welcomeDone', value: true },
  }
  const stores = { meta, projects: { p1: { id: 'p1' } } }
  const r = stripSensitiveMeta(stores)

  ok('剥掉 2 条敏感 meta', r.removed.length === 2, r.removed.join(','))
  ok('剥后 meta 只剩 welcomeDone', Object.keys(r.stores.meta).length === 1)
  ok('非 meta 的 store 原样保留', 'projects' in r.stores)

  // 🔴🔴 最关键的一条：原对象**一个字节都不能动**
  ok('🔴 原对象里的密钥仍在（没有就地删运行中的内存库）',
    JSON.stringify(stores).includes('sk-LIVE'))
  ok('🔴 原对象的 meta 键数不变', Object.keys(stores.meta).length === 3)
  ok('🔴 返回的 meta 是新对象（引用不同）', r.stores.meta !== stores.meta)

  // 无敏感键时原样返回（不做无谓复制）
  const clean = { meta: { welcomeDone: { key: 'welcomeDone', value: true } } }
  const r2 = stripSensitiveMeta(clean)
  ok('无敏感键时原样返回同一引用', r2.stores === clean && r2.removed.length === 0)

  // 无 meta / 畸形输入不炸
  ok('没有 meta 时不炸', stripSensitiveMeta({} as never).removed.length === 0)
}

// ---------- 3. exportProject 不把项目级密钥打进 bundle ----------
__resetMockStores()
const pid = await createDemoProject()
db.setCurrentProject(pid)

{
  const SECRET = 'sk-LEAK-SENTINEL-1234'
  // 模拟 1.5.0 之前的老库：项目级 aiProviders 残留（含明文密钥）
  await ops.put('settingsKV', {
    key: `${pid}::aiProviders`,
    value: [{ id: 'p1', type: 'openai', apiKey: SECRET, model: 'x' }],
  })
  // 顺带塞一条「值里藏密钥」的自定义设置，验证值探测这一级也生效
  await ops.put('settingsKV', {
    key: `${pid}::mySneakySetting`,
    value: { nested: { apiKey: 'sk-VALUE-PROBE' } },
  })
  // 一条正常设置：必须**原样保留**（防误伤）
  await ops.put('settingsKV', { key: `${pid}::kbInBackup`, value: true })

  const bundle = await db.exportProject(pid) as { settings?: { key: string }[] }
  const text = JSON.stringify(bundle)
  const keys = (bundle.settings ?? []).map(s => s.key)

  ok('🔴 备份包里没有那枚密钥', !text.includes(SECRET))
  ok('🔴 值里藏密钥的设置也没进包', !text.includes('sk-VALUE-PROBE'))
  ok('🔴 settings 里没有 aiProviders 键', !keys.includes('aiProviders'))
  ok('正常设置 kbInBackup **原样保留**（没误伤）', keys.includes('kbInBackup'))
}

// ---------- 4. migrateLegacyProjectAiKeys 清残留 ----------
{
  ok('前置：残留确实还在',
    !!(await ops.get('settingsKV', `${pid}::aiProviders`)))

  const n = await migrateLegacyProjectAiKeys()
  ok('🔴 清掉了残留（返回 ≥1）', n >= 1, String(n))
  ok('🔴 项目级 aiProviders 已删除', !(await ops.get('settingsKV', `${pid}::aiProviders`)))

  // 🔴 迁移标记键**绝不能删** —— 删了每次读配置都会重跑迁移
  await ops.put('settingsKV', { key: `${pid}::aiConfigMigratedToGlobal`, value: true })
  await migrateLegacyProjectAiKeys()
  ok('🔴 不误删迁移标记 aiConfigMigratedToGlobal',
    !!(await ops.get('settingsKV', `${pid}::aiConfigMigratedToGlobal`)))

  // 幂等
  ok('幂等：再跑一遍返回 0', (await migrateLegacyProjectAiKeys()) === 0)

  // 正常设置不受影响
  ok('正常设置 kbInBackup 仍在', !!(await ops.get('settingsKV', `${pid}::kbInBackup`)))
}

console.log(`\nsensitiveMeta: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
