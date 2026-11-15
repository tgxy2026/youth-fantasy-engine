// ============ 3.5.6 · 灵感三入口接入 ACP ============
//
// 覆盖：灵感融合、AI 取名、AI 辅助规划的 ACP 通道；解析/去重/溯源规则不变；
// 界面就绪条件与任务标识同步。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiFuseInspiration } from '../src/lib/aiTasks/inspiration'
import { aiSuggestNames } from '../src/lib/aiTasks/suggest'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 灵感融合 ----------
const fusePrompts: string[] = []
const ideas = await aiFuseInspiration({
  items: ['雨夜捡到青铜铃', '铃中有前朝剑仙残魂', '宗门正在追查失窃的剑冢'],
  context: '青石巷、青铜剑宗',
  acpText: async prompt => {
    fusePrompts.push(prompt)
    return JSON.stringify({
      ideas: [
        { text: '陈渊在雨夜听见铃中剑鸣，决定顺着残魂的指引前往青石巷。', basedOn: [1, 2] },
        { text: '宗门追查剑冢失窃，却不知线索一直挂在陈渊腰间。', basedOn: [3] },
        { text: '越界编号应被剔除。', basedOn: [9] },
      ],
    })
  },
})
ok('灵感融合走 ACP 并解析出创意', ideas.length === 3)
ok('溯源编号保留合法项', ideas[0].basedOn.join(',') === '1,2')
ok('越界编号被剔除', ideas[2].basedOn.length === 0)
ok('融合提示词带 JSON 约束与灵感清单', /【输出格式】/.test(fusePrompts[0]) && fusePrompts[0].includes('雨夜捡到青铜铃'))

// ---------- AI 取名 ----------
const namePrompts: string[] = []
const names = await aiSuggestNames({
  target: '人名',
  style: '仙侠',
  extra: '',
  context: '青铜剑宗',
  count: 10,
  acpText: async prompt => {
    namePrompts.push(prompt)
    return JSON.stringify({
      names: [
        { name: '陈渊', meaning: '深渊藏锋' },
        { name: '陈渊', meaning: '重复项应被去掉' },
        { name: '苏泠', meaning: '清冷如霜' },
      ],
    })
  },
})
ok('取名走 ACP 并解析候选', names.length === 2)
ok('重名被去掉', names.filter(item => item.name === '陈渊').length === 1)
ok('取名提示词带对象与风格', namePrompts[0].includes('人名') && namePrompts[0].includes('仙侠'))
ok('取名提示词带 JSON 约束', /【输出格式】/.test(namePrompts[0]))

// ---------- 接线静态契约 ----------
const box = read('src/components/creative/InspirationBox.tsx')
ok('灵感夹按钮按写作就绪判断', /task: 'inspiration-fuse'/.test(box) && box.includes('writingReady'))
ok('融合不再要求 API 模型', box.includes('acpWriting?.ready') && box.includes('acpText: prompt => acpSend(prompt)'))
const tools = read('src/components/creative/InspireTools.tsx')
ok('AI 取名按钮按写作就绪判断', /task: 'name-suggest'/.test(tools) && tools.includes('writingReady'))
const assist = read('src/components/ai/AIAssist.tsx')
ok('辅助规划有 ACP 分支', /task: 'ai-assist'/.test(assist) && assist.includes('writingReady'))
ok('辅助规划不再强制 API provider', assist.includes('acpSend ? null : await requireActiveProvider'))
const bridge = read('src/lib/agentHost/acpBridge.ts')
const main = read('electron/main.cjs')
for (const task of ['inspiration-fuse', 'name-suggest', 'ai-assist']) {
  ok(`任务标识登记 ${task}`, bridge.includes(`'${task}'`))
  ok(`主进程放行 ${task}`, main.includes(`'${task}'`))
}

console.log(`\nACP_INSPIRATION ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
