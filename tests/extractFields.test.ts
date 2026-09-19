// ============ B2 全字段抽取：一致性闸 + 解析容错 ============
//
// 两条目的：
//  ① **一致性闸**（详细设计 §11 开放问题 3）：抽取提示词里的字段键与落库映射表（`flow/fieldMap`）
//     必须严格对应。prompt 里少了某个 slot 键 → 该字段永远抽不出来（静默丢字段，最难发现）；
//     提示词里多了个表里没有的键 → 模型白花 token 产一个落不了库的值。
//     本项目已经吃过一次同类教训（`aiDataSources` 里 id 拼错导致气泡静默不显示）。
//  ② **解析容错**：模型爱把字段平铺、爱用中文列名当键、relations 时数组时字符串 ——
//     这些都认；但**不属于该类型的字段键一律丢弃**（否则会往表里写驴唇不对马嘴的数据）。
import { __resetMockStores } from './mock-memory'
import {
  EXTRACT_FIELD_KEYS, EXTRACT_FIELDS_SPEC, extractSysFull, SLOT_HINT, parseExtractedEntities,
} from '../src/lib/aiTasks'
import { KIND_MAP } from '../src/lib/flow/fieldMap'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()

const TYPES = Object.keys(KIND_MAP) as (keyof typeof KIND_MAP)[]

// ---------- ① 一致性闸：键 = fieldMap 的 slots，且都写进了 prompt ----------
{
  let mismatched: string[] = []
  for (const t of TYPES) {
    const want = (KIND_MAP[t].slots ?? []).map(s => s.from).join(',')
    const got = (EXTRACT_FIELD_KEYS[t] ?? []).join(',')
    if (want !== got) mismatched.push(`${t}: ${want} vs ${got}`)
  }
  ok('🔴 键清单与 fieldMap 的 slots 完全一致（同源派生，不是手抄）', mismatched.length === 0, mismatched.join(' ｜ '))

  const totalKeys = TYPES.reduce((n, t) => n + EXTRACT_FIELD_KEYS[t].length, 0)
  ok('字段键总数合理（六类合计 ≥ 30）', totalKeys >= 30, String(totalKeys))

  const missingInPrompt: string[] = []
  for (const t of TYPES) {
    for (const k of EXTRACT_FIELD_KEYS[t]) if (!EXTRACT_FIELDS_SPEC.includes(`${k}（`)) missingInPrompt.push(`${t}/${k}`)
  }
  ok('🔴 每个字段键都出现在 prompt 里（少了 = 该字段永远抽不出来）', missingInPrompt.length === 0, missingInPrompt.join(','))

  const noHint: string[] = []
  for (const t of TYPES) {
    for (const k of EXTRACT_FIELD_KEYS[t]) if (!SLOT_HINT[k]?.trim()) noHint.push(`${t}/${k}`)
  }
  ok('每个字段键都有中文提示（模型才看得懂该填什么）', noHint.length === 0, noHint.join(','))

  const used = new Set(TYPES.flatMap(t => EXTRACT_FIELD_KEYS[t]))
  const dead = Object.keys(SLOT_HINT).filter(k => !used.has(k))
  ok('没有「死提示」（SLOT_HINT 里的键没人用 = 拼错了或 fieldMap 删过 slot）', dead.length === 0, dead.join(','))

  ok('实际发出的 system 含字段段（避免只改了常量没接上）',
    extractSysFull().includes('【应补全的字段】') && extractSysFull().length > 900,
    String(extractSysFull().length))

  // 负面对照：凭空加一个不存在的键，一致性检查必须能发现（证明上面几条有判别力）
  const fake = [...EXTRACT_FIELD_KEYS['人物'], 'notARealField']
  const fakeBad = fake.filter(k => !EXTRACT_FIELDS_SPEC.includes(`${k}（`))
  ok('  · 负面对照：混入假键后能被上述检查抓出', fakeBad.length === 1, fakeBad.join(','))
}

// ---------- ② 解析：英文键平铺 / 中文列名 / fields 子对象 ----------
{
  const flat = parseExtractedEntities(JSON.stringify([
    { type: '人物', name: '陈渊', desc: '少年', evidence: '陈渊走出山门。', tier: '主要',
      identity: '外门弟子', realm: '淬体一重', skills: '混沌吞天诀', gear: '玄铁令' },
  ]))
  ok('② 英文键平铺能解析出 fields', !!flat[0]?.fields?.identity, JSON.stringify(flat[0]?.fields))

  const cn = parseExtractedEntities(JSON.stringify([
    { type: '人物', name: '陈渊', desc: '', evidence: '', '身份定位': '外门弟子', '实力境界': '淬体一重' },
  ]))
  ok('  · 中文列名当键也认（模型爱这么干）',
    cn[0]?.fields?.identity === '外门弟子' && cn[0]?.fields?.realm === '淬体一重',
    JSON.stringify(cn[0]?.fields))

  const nested = parseExtractedEntities(JSON.stringify([
    { type: '地点', name: '青岚山', 名称: '青岚山', fields: { category: '山脉', danger: '低' } },
  ]))
  ok('  · fields 子对象也认', nested[0]?.fields?.category === '山脉', JSON.stringify(nested[0]?.fields))
}

// ---------- ③ 解析：relations 的两种形态 ----------
{
  const arr = parseExtractedEntities(JSON.stringify([
    { type: '人物', name: '陈渊', aliases: [], relations: [{ with: '老瞎子', type: '恩人' }, { with: '萧景行', type: '师兄弟' }] },
  ]))
  ok('③ relations 数组 → 「甲：关系；乙：关系」', arr[0]?.fields?.relations === '老瞎子：恩人；萧景行：师兄弟', String(arr[0]?.fields?.relations))

  const str = parseExtractedEntities(JSON.stringify([
    { type: '人物', name: '陈渊', relations: '老瞎子：恩人' },
  ]))
  ok('  · relations 字符串原样保留', str[0]?.fields?.relations === '老瞎子：恩人', String(str[0]?.fields?.relations))
}

// ---------- ④ 🔴 负面对照：不属于该类型的字段键必须丢弃 ----------
{
  const out = parseExtractedEntities(JSON.stringify([
    { type: '地点', name: '青岚山', identity: '外门弟子', realm: '淬体一重', category: '山脉' },
  ]))
  const f = out[0]?.fields ?? {}
  ok('🔴 ④ 给「地点」塞人物字段（identity/realm）→ 一律丢弃', f.identity === undefined && f.realm === undefined,
    JSON.stringify(f))
  ok('  · 但该类型该有的字段照常保留', f.category === '山脉', JSON.stringify(f))
}

// ---------- ⑤ 解析：别称 / tier / 去重 / 上限 / 截断 ----------
{
  const out = parseExtractedEntities(JSON.stringify([
    { type: '人物', name: '王铁柱', aliases: ['铁柱', '铁柱', '王铁柱'], tier: '次要' },
    { type: '人物', name: '王铁柱', aliases: [], tier: '主要' },
    { type: '物品', name: '吞天诀', aliases: '吞天、天诀', tier: '主要' },
    { type: '地点', name: '长名测试', category: 'x'.repeat(400) },
  ]))
  ok('⑤ 别称去重并剔除与本名相同', out[0]?.aliases?.length === 1 && out[0]?.aliases?.[0] === '铁柱',
    JSON.stringify(out[0]?.aliases))
  ok('  · 同名同类型只留第一条', out.filter(e => e.name === '王铁柱').length === 1)
  ok('  · 别称是分隔串也能拆', out.find(e => e.name === '吞天诀')?.aliases?.length === 2,
    JSON.stringify(out.find(e => e.name === '吞天诀')?.aliases))
  ok('  · tier 只给人物（物品给了也不算）', !out.find(e => e.name === '吞天诀')?.tier)
  ok('  · 单字段值超长被截断（不撑破表格）', (out.find(e => e.name === '长名测试')?.fields?.category ?? '').length === 120,
    String(out.find(e => e.name === '长名测试')?.fields?.category?.length))

  const many = parseExtractedEntities(JSON.stringify(
    Array.from({ length: 30 }, (_, i) => ({ type: '人物', name: `角色${i}` }))))
  ok('  · 单章上限 20 条', many.length === 20, String(many.length))
}

console.log(`\n—— extractFields 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
