// ============ 2.7.3：对话引导要能带既有设定，且由作者逐项勾选 ============
//
// 起因（核实结论）：对话引导（InterviewChat）原先**完全不带**母级设定 —— 界面也没有任何提示，
// 作者无从察觉，补全子世界时 AI 会把母设定忘掉。而一次性全灌又会把作者的脑子掏空。
// 本测试钉四件事：
//   ① buildWorldContext 可按分组取舍，不传参数时**行为与从前逐字一致**（回归保护）；
//   ② buildSiblingContext 产出兄弟条目摘要，且**刻意截断**（多套并行时最容易撞车，也最耗额度）；
//   ③ 弹窗把勾选结果接成 context 递给访谈组件（结构断言）；
//   ④ 面板在一次成稿模式下**不出现**（那是原有复选框的地盘，别两处打架）。
import { buildSiblingContext } from '../src/lib/creative/interview'
import { buildWorldContext, WORLD_CONTEXT_GROUPS } from '../src/lib/ai'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = process.cwd()
const read = (rel: string) => {
  const p = path.join(ROOT, rel)
  return readFileSync(p, 'utf8')
}

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

async function main() {
  __resetMockStores()

  await db.saveFormData('worldbase', {
    '一、世界总览::世界名称': '九霄界',
    '一、世界总览::一句话世界观': '神族封天，人族不知',
    '一、世界总览::文明程度': '修行文明',
  })
  await db.saveFormData('power', { '一、体系::体系名称': '玄脉体系' })
  await db.saveFormData('positioning', { '一、作品::书名': '吞天神脉' })

  // ① 分组取舍
  const all = await buildWorldContext()
  ok('🔴 不传参数 = 三组全带（保持从前的行为）',
    all.includes('九霄界') && all.includes('玄脉体系') && all.includes('吞天神脉'), all)
  const onlyWorld = await buildWorldContext(['worldbase'])
  ok('🔴 只勾世界设定 ⇒ 不含力量体系与作品信息',
    onlyWorld.includes('九霄界') && !onlyWorld.includes('玄脉体系') && !onlyWorld.includes('吞天神脉'), onlyWorld)
  const none = await buildWorldContext([])
  ok('空数组当作「全带」（与不传同义，避免误伤老调用方）', none === all, JSON.stringify(none))
  ok('🔴 分组三组齐备且字段名都在 schema 里',
    WORLD_CONTEXT_GROUPS.length === 3 && WORLD_CONTEXT_GROUPS.every(g => g.names.length > 0))
  // 白名单字段名必须与 schema 一致 —— 改过名就会静默取空（这正是本条要防的病）
  const schemaTxt = [
    'src/lib/schemaTemplates/worldbase.ts',
    'src/lib/schemaTemplates/power.ts',
    'src/lib/schemaTabs/part1.ts', // 作品信息（positioning）的字段直接写在 TABS 里，不走题材包
  ].map(read).join('\n')
  const missing = WORLD_CONTEXT_GROUPS.flatMap(g => g.names.filter(n => !schemaTxt.includes(`'${n}'`)))
  ok('🔴 白名单字段名与 schema 一致（防改名后静默取空）', missing.length === 0, missing.join('、'))

  // ② 兄弟条目摘要
  const sib = buildSiblingContext(
    [
      { name: '三国', data: { '一、政体::决策机制': '九品中正制', '一、政体::备注': 'x' } },
      { name: '空条目', data: {} },
      { name: '长条目', data: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`一、政体::字段${i}`, `值${i}`])) },
    ],
    { itemLabel: '子世界', perEntryLines: 3, totalLines: 6 },
  )
  ok('兄弟条目标题带称呼与名字', sib.includes('【子世界·三国】'), sib)
  ok('🔴 键名去掉「模块::」前缀（模型看到的是字段名，不是存储键）',
    sib.includes('决策机制：九品中正制') && !sib.includes('政体::'), sib)
  ok('空条目不进摘要', !sib.includes('空条目'), sib)
  ok('🔴 超长条目被截断并明写省略', sib.includes('其余 27 项略'), sib)
  ok('总量受 totalLines 约束', sib.split('\n').length <= 8, String(sib.split('\n').length))
  ok('无兄弟条目时返回空串', buildSiblingContext([]) === '')

  // ③④ 结构断言：弹窗接线
  const panel = read('src/components/ai/AITemplateFill.tsx')
  ok('🔴 访谈分支把勾选结果作为 context 递进去', /context=\{interviewCtx \|\| undefined\}/.test(panel))
  ok('访谈分支带上面板（作者看得见、能勾）', /headerSlot=/.test(panel) && /InterviewContextPicker/.test(panel))
  ok('🔴 面板只在对话引导出现（一次成稿仍用原来的复选框）',
    /withWorldContext \? \(\s*<InterviewContextPicker/.test(panel.replace(/\n\s*/g, ' ')))
  ok('🔴 默认只带母级世界设定，不是全灌', /useState<string\[\]>\(\['worldbase'\]\)/.test(panel))
  const chat = read('src/components/creative/InterviewChat.tsx')
  ok('访谈组件支持 headerSlot 且不自己读库（读什么由调用方定）',
    /headerSlot\?/.test(chat) && !/getFormData|getSubSets/.test(chat))
  ok('🔴 访谈提示词里「既有设定」那段终于会用上',
    /既有设定（回答要与它一致）/.test(read('src/lib/creative/interview.ts')))

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.log('FAIL 未捕获异常:', e?.stack ?? e); process.exit(1) })
