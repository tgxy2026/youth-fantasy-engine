// ============ 2.7.2：制度四页签的「末尾汇总」支持多套并列主体 ============
//
// 场景：拆书 / 创意写作末尾会把整本书收敛成「全书级设定」。制度四页签改并列结构后，
// 一条 = 一套（一个政权 / 一个地区 / 一个教派 / 一套律法）。若原小说有魏蜀吴三套政治体制，
// 必须拆成三条独立条目 —— 揉进一份字段会丢失差异、作者也无法分别改。
//
// 本测试锁四件事：① 提示词给模型「可按主体名分块」的说明（且只给这四张表）；
// ② formDraftRows 能把「主体名 → 模块 → 字段」拆成一行一套；③ 落库写进 cardRecords 条目
// 而不是无人读的 formData；④ 二次汇总同名走 update、不重复新建。
// 端到端探针：模型按「主体名 → 模块 → 字段」输出 ⇒ 应拆成多行草稿 ⇒ 落库成多条条目
import { formDraftRows, formFieldsPrompt, summaryFormTabs } from '../src/lib/flow/formMap'
import { commitDraftRows, previewCommit } from '../src/lib/flow/commit'
import { createDemoProject } from '../src/lib/app/seedData'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

async function main() {
  __resetMockStores()
  await createDemoProject()
  // 🔴 2026-10-05：示范项目已给四个制度页签补了种子条目（便于界面示范「已完结」开关）。
  //    本测试要验的是「在一张空表上做多套汇总」的语义 ⇒ 先把政治架构清空，
  //    否则下面 `subs.length === 3` 这类断言会被种子的 3 条（青岚宗/血魔教/中州皇朝）顶掉。
  for (const s of await db.getSubSets('politics')) await db.deleteSubSet('politics', s.id)
  await db.setSetting('worldSubActive::politics', [])

  // ① 提示词：这四张表带「可按主体名分块」说明，其余表没有
  const fp = formFieldsPrompt()
  ok('🔴 政治架构的清单带「可有多套并列主体」说明', fp.includes('政治架构') && /本表可有多套并列主体/.test(fp))
  ok('🔴 经济基础 / 宗教信仰 / 司法制度 都有该说明',
    ['经济基础', '宗教信仰', '司法制度'].every(t => {
      const i = fp.indexOf('〖' + t + '〗')
      return i >= 0 && fp.slice(i, i + 400).includes('本表可有多套并列主体')
    }))
  ok('🔴 作品信息 / 世界设定 **不**带该说明（单套口径不变）',
    !/〖作品信息〗[\s\S]{0,400}本表可有多套/.test(fp) && !/〖世界设定〗[\s\S]{0,400}本表可有多套/.test(fp))
  ok('🔴 summaryFormTabs 仍含四张制度表 + 单套表',
    ['politics', 'economy', 'belief', 'justice', 'positioning', 'worldbase'].every(t => summaryFormTabs().includes(t)))

  // ② 模型按主体名分块输出（模拟三国）
  const values = {
    '政治架构': {
      '魏': { '一、政体与权力结构': { '政体形式': '禅让代魏', '权力结构': '曹氏秉政' } },
      '蜀': { '一、政体与权力结构': { '政体形式': '称帝建国', '权力结构': '刘备称汉中王' } },
      '吴': { '一、政体与权力结构': { '政体形式': '都督府→称帝', '权力结构': '孙氏专权' } },
    },
    '经济基础': { '一、货币与财政': { '货币体系': '铜钱与布帛并行' } },   // 单套
  }
  const rows = formDraftRows(values)
  const pol = rows.filter(r => r.tabId === 'politics')
  ok('🔴 政治架构拆出三行（魏/蜀/吴）', pol.length === 3, '实际 ' + pol.length + '：' + pol.map(r => r.name).join())
  ok('🔴 三行的行名分别是魏/蜀/吴', pol.map(r => r.name).join() === '魏,蜀,吴', pol.map(r => r.name).join())
  ok('🔴 三行的 key 互不相同（勾选与落库不撞）',
    new Set(pol.map(r => r.key)).size === 3, pol.map(r => r.key).join(' | '))
  ok('🔴 字段被正确摊平（魏的政体形式=禅让代魏）',
    pol[0].fields.some(f => f.label === '政体形式' && f.value === '禅让代魏'),
    JSON.stringify(pol[0].fields))
  ok('🔴 落库键是「模块::字段」（与手填一致）',
    pol[0].fields.every(f => f.key.includes('::')), pol[0].fields[0]?.key)
  ok('🔴 kindLabel 标出是并列条目', pol[0].kindLabel.includes('并列设定'), pol[0].kindLabel)
  const eco = rows.filter(r => r.tabId === 'economy')
  ok('🔴 单套表仍是一行（老形态零变化）', eco.length === 1 && eco[0].name === '经济基础', JSON.stringify(eco.map(r => r.name)))

  // ③ 预览：三条都算「新建」
  const pv = await previewCommit(pol, 'keep-existing')
  ok('🔴 预览：三条全新条目都算 create', pv.create === 3, JSON.stringify(pv))

  // ④ 落库：真的写进 cardRecords，且设为活跃
  const out = await commitDraftRows(pol, { conflict: 'keep-existing' })
  ok('🔴 落库报告 created=3', out.created === 3, JSON.stringify(out))
  const subs = await db.getSubSets('politics')
  ok('🔴 库里真有三条政权条目', subs.length === 3, subs.map(s => s.name).join())
  ok('🔴 三条都设为活跃（会进 AI 上下文）',
    (await db.getActiveSubIds('politics')).length === 3,
    (await db.getActiveSubIds('politics')).join())
  const wei = subs.find(s => s.name === '魏')
  ok('🔴 魏那条的字段内容正确', !!wei?.data?.['一、政体与权力结构::政体形式']?.includes('禅让代魏'),
    JSON.stringify(wei?.data))
  ok('🔴 母级 formData 是空的（没有写进黑洞）',
    Object.keys(await db.getFormData('politics')).length === 0,
    JSON.stringify(await db.getFormData('politics')))

  // ⑤ 二次汇总：同名条目不重复新建；**字段没变时不该有任何写入**
  const rowsAgain = formDraftRows(values).filter(r => r.tabId === 'politics')
  const outSame = await commitDraftRows(rowsAgain, { conflict: 'keep-existing' })
  ok('🔴 二次汇总字段一字未变 ⇒ 不重复新建也不重复写（updated=0）',
    outSame.created === 0 && outSame.updated === 0, JSON.stringify(outSame))
  ok('🔴 条目数仍是 3', (await db.getSubSets('politics')).length === 3,
    (await db.getSubSets('politics')).map(s => s.name).join())

  // ⑤-b 模型这轮补了一个新字段 ⇒ 应命中「update」而不是新建第四条
  const values2 = {
    '政治架构': {
      '魏': { '一、政体与权力结构': { '政体形式': '禅让代魏', '权力结构': '曹氏秉政', '决策机制': '九品中正制' } },
      '蜀': { '一、政体与权力结构': { '政体形式': '称帝建国', '权力结构': '刘备称汉中王' } },
      '吴': { '一、政体与权力结构': { '政体形式': '都督府→称帝', '权力结构': '孙氏专权' } },
    },
  }
  const outNew = await commitDraftRows(formDraftRows(values2).filter(r => r.tabId === 'politics'), { conflict: 'keep-existing' })
  ok('🔴 魏新增了字段 ⇒ 走 update（其余两套无变化不动）', outNew.updated === 1 && outNew.created === 0, JSON.stringify(outNew))
  ok('🔴 仍是 3 条，没多出第四条', (await db.getSubSets('politics')).length === 3)
  const wei2 = (await db.getSubSets('politics')).find(s => s.name === '魏')
  ok('🔴 新字段真的补进去了',
    !!wei2?.data?.['一、政体与权力结构::决策机制']?.includes('九品中正制'), JSON.stringify(wei2?.data))

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.log('FAIL 未捕获异常:', e?.message ?? e); process.exit(1) })
