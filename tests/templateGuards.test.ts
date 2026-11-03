// 3.2.1 · 模板层的两个「自检工具」补闸（2026-10-22 死代码清算）
//
// 来由：`isMigrationKey` 的注释写着「自检用，防将来改键漏改前缀」、
//       `MAPPING_PLAN_VERSION` 的注释写着「仅测试用：防有人悄悄改结构却忘了升版本」——
//       但两者全库零引用，**闸本身没被任何测试调用**。
//       一个没人调用的自检 == 没有自检。这里把它们真正接上。
//
// 钉两件事：
//   ① 迁移三类键（日志 / 备份 / 索引）都必须落在 `MIGRATION_KEY_PREFIX` 这一族里
//      —— 这些键是"本机专属"，云同步 / 导出要按前缀排除；哪天新增一类漏了前缀，
//        它会跟着同步上云，而云端的另一台机器读到会当成自己的迁移状态。
//   ② 映射计划的结构版本号：改 `SemanticMappingPlan` 的形状就必须升它，
//      升了这条断言会红，逼人回来确认"旧计划还能不能读"。
import {
  isMigrationKey,
  migrationLogKeyOf,
  migrationBackupKeyOf,
  migrationIndexKeyOf,
  MIGRATION_KEY_PREFIX,
} from '@/lib/templates/migrationLog'
import { MAPPING_PLAN_VERSION } from '@/lib/templates/mappingPlan'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('\n── ① 迁移键必须同族（同步/导出按前缀排除）──')
{
  const keys = [
    ['日志键', migrationLogKeyOf('p1', 'characters')],
    ['备份键', migrationBackupKeyOf('p1', 'characters')],
    ['索引键', migrationIndexKeyOf('p1')],
  ]
  for (const [label, k] of keys) {
    ok(`${label} 命中 isMigrationKey`, isMigrationKey(k), k)
    ok(`${label} 以 ${MIGRATION_KEY_PREFIX} 开头`, k.startsWith(MIGRATION_KEY_PREFIX), k)
  }

  // 负向控制：普通键不能被误判成迁移键（否则同步排除会把正常数据一起排掉）
  for (const k of ['settingsKV:p1::kbInBackup', 'aiProviders', 'templateDef:p1:characters', '']) {
    ok(`非迁移键不误判：${k || '(空串)'}`, isMigrationKey(k) === false, k)
  }

  // 前缀本身不能被当成"任意 template 键"：前缀必须带版本段
  ok('前缀含版本段（templateMigration32:）', MIGRATION_KEY_PREFIX.includes('32'), MIGRATION_KEY_PREFIX)
}

console.log('\n── ② 映射计划结构版本 ──')
{
  ok('MAPPING_PLAN_VERSION === 1', MAPPING_PLAN_VERSION === 1, String(MAPPING_PLAN_VERSION))
  console.log(
    '     ↑ 改 SemanticMappingPlan 的形状（增删字段 / 改 digest 口径）时：\n' +
    '       先想清"旧计划还能不能读"，能就把版本留在 1 并补兼容；不能就必须升版本 + 改这条断言。'
  )
}

console.log(`\n${fail === 0 ? '✅' : '❌'} templateGuards: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
