// WQ1-4（3.2.0）：抽取入口三态化负向控制测试
//
// 锁死：合法空（本章无新实体/无变化）与解析失败必须可区分；
// 兼容包装 parseExtractedEntities / parseChapterChanges 与 detailed.data 逐字一致；
// WithStatus 网络函数在未配模型时是 failed（旧契约把失败吞成空数组=假绿）。
import { parseExtractedEntities, parseExtractedEntitiesDetailed } from '../src/lib/aiTasks/extract'
import { parseChapterChanges, parseChapterChangesDetailed } from '../src/lib/aiTasks/postProcess'
import { aiExtractSettingEntitiesWithStatus } from '../src/lib/aiTasks/extract'
import { aiExtractChapterChangesWithStatus } from '../src/lib/aiTasks/postProcess'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- parseExtractedEntitiesDetailed ----------
{
  const empty = parseExtractedEntitiesDetailed('[]')
  ok('实体：合法空数组 ⇒ valid', empty.outcome === 'valid' && empty.data.length === 0)

  const broken = parseExtractedEntitiesDetailed('模型不想回答：这一章没什么可抽的')
  ok('实体：纯文本 ⇒ invalid', broken.outcome === 'invalid')
  ok('实体：invalid 时 data 为空', broken.data.length === 0)

  const good = parseExtractedEntitiesDetailed(JSON.stringify([
    { type: '人物', name: '陈渊', desc: '主角' },
    { type: '地点', name: '青岚山' },
  ]))
  ok('实体：正常两条 ⇒ valid', good.outcome === 'valid' && good.data.length === 2)
  ok('实体：字段映射不变（desc）', good.data[0].desc === '主角')

  // 兼容：包装与 detailed.data 逐字一致（行为不回退）
  const samples = [
    '[]', '不是 JSON',
    JSON.stringify([{ type: '人物', name: '陈渊', desc: '主角' }]),
    JSON.stringify([{ type: '未知类型', name: 'x' }, { type: '地点', name: '青岚山' }]),
    JSON.stringify({ list: [{ type: '人物', name: '陈瑶' }] }),
  ]
  let same = true
  for (const raw of samples) {
    if (JSON.stringify(parseExtractedEntities(raw)) !== JSON.stringify(parseExtractedEntitiesDetailed(raw).data)) {
      same = false; console.log('  MISMATCH:', raw.slice(0, 40))
    }
  }
  ok('实体：parseExtractedEntities 与 detailed.data 五样本一致', same)
}

// ---------- parseChapterChangesDetailed ----------
{
  const empty = parseChapterChangesDetailed('[]')
  ok('变化：合法空数组 ⇒ valid', empty.outcome === 'valid' && empty.data.foreshadows.length === 0)

  const broken = parseChapterChangesDetailed('JSON 坏了')
  ok('变化：纯文本 ⇒ invalid', broken.outcome === 'invalid')
  ok('变化：invalid 时三类皆空', broken.data.foreshadows.length === 0 && broken.data.relations.length === 0 && broken.data.statuses.length === 0)

  const good = parseChapterChangesDetailed(JSON.stringify([
    { kind: '伏笔', action: '埋设', code: 'F0001', content: '左腕胎记' },
    { kind: '关系', a: '陈渊', b: '陈瑶', type: '兄妹', change: '更信任' },
    { kind: '状态', name: '陈渊', state: '聚灵一重' },
  ]))
  ok('变化：三类各一条 ⇒ valid', good.outcome === 'valid'
    && good.data.foreshadows.length === 1 && good.data.relations.length === 1 && good.data.statuses.length === 1)
  ok('变化：字段映射不变', good.data.foreshadows[0].code === 'F0001' && good.data.statuses[0].state === '聚灵一重')

  const samples = ['[]', '坏 JSON', JSON.stringify([{ kind: '伏笔', content: '胎记' }]), JSON.stringify([{ kind: '未知', x: 1 }])]
  let same = true
  for (const raw of samples) {
    if (JSON.stringify(parseChapterChanges(raw)) !== JSON.stringify(parseChapterChangesDetailed(raw).data)) { same = false; console.log('  MISMATCH:', raw.slice(0, 40)) }
  }
  ok('变化：parseChapterChanges 与 detailed.data 四样本一致', same)
}

// ---------- WithStatus：未配模型 ⇒ failed（不是 completed 空数组）----------
{
  const e = await aiExtractSettingEntitiesWithStatus('正文'.repeat(80), '第1章')
  ok('未配模型：实体抽取 ⇒ failed', e.state === 'failed')
  ok('未配模型：带 errorCode', typeof e.errorCode === 'string' && e.errorCode.length > 0)
  ok('未配模型：无 data（不是合法空结果）', e.result === undefined)

  const c = await aiExtractChapterChangesWithStatus('正文'.repeat(80), '第1章')
  ok('未配模型：三类变化抽取 ⇒ failed', c.state === 'failed')

  const cEmpty = await aiExtractChapterChangesWithStatus('', '第1章')
  ok('正文为空 ⇒ completed（不发请求的合法空）', cEmpty.state === 'completed')
}

console.log(`\nextractDetailed: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
