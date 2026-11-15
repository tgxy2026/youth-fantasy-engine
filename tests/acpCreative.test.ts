// ============ 3.5.6 · 创意写作三阶段接入 ACP ============
//
// 覆盖：设定奠基 / 大纲规划 / 逐章连写的 ACP 通道，零 API 配置下可推进；
// 解析与裁剪（实体数量、卷章数量）不放宽；界面就绪条件与任务标识同步。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiGenerateBible, aiPlanOutline } from '../src/lib/aiTasks/creative'
import { aiRewriteChapter } from '../src/lib/aiTasks/rewrite'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 设定奠基 ----------
const biblePrompts: string[] = []
const entities = await aiGenerateBible('少年在雨夜捡到一枚青铜铃，铃里有前朝剑仙的残魂。', {
  acpText: async prompt => {
    biblePrompts.push(prompt)
    return JSON.stringify({
      characters: [{ name: '陈渊', role: '主角', desc: '雨夜拾铃的少年' }],
      factions: [{ name: '青铜剑宗', desc: '前朝剑修遗脉' }],
      locations: [{ name: '青石巷', desc: '雨夜的旧巷' }],
      terms: [{ name: '铃魂', desc: '寄居铃中的残魂' }],
      items: [{ name: '青铜铃', desc: '封印剑仙残魂的旧铃' }],
    })
  },
})
ok('设定奠基走 ACP 并解析出实体', entities.length >= 3 && entities.some(e => e.name === '陈渊'))
ok('奠基提示词带 JSON 输出约束', biblePrompts.length >= 1 && /【输出格式】/.test(biblePrompts[0]))
ok('奠基提示词保留数量上限', biblePrompts[0].includes('数量上限'))
ok('ACP 空结果仍如实返回空（不假装成功）',
  (await aiGenerateBible('x', { acpText: async () => '不是 JSON' })).length === 0)

// ---------- 大纲规划 ----------
const outlinePrompts: string[] = []
const outline = await aiPlanOutline('【已有资料】合成资料', {
  volumes: 1,
  chaptersPerVolume: 2,
  fromNo: 1,
  fromVolumeNo: 1,
  extending: false,
  acpText: async prompt => {
    outlinePrompts.push(prompt)
    return JSON.stringify({
      volumes: [{ title: '第一卷', positioning: '开篇', stage: '起', scope: '青石巷', opening: '拾铃', climax1: '初战', turn: '残魂苏醒', climax2: '宗门追索', ending: '离巷', events: '认主', subplots: '师妹' }],
      chapters: [
        { title: '雨夜拾铃', event: '捡到青铜铃', fn: '引出金手指', cast: '陈渊', hook: '铃中有人说话', scenes: ['雨巷'] },
        { title: '残魂初现', event: '与残魂对话', fn: '交代世界观', cast: '陈渊 / 剑仙', hook: '宗门来人', scenes: ['破屋'] },
      ],
    })
  },
})
ok('大纲规划走 ACP 并产出两章', outline.chapters.length === 2)
ok('卷大纲字段被解析', outline.volumes.length === 1 && outline.volumes[0].title === '第一卷')
ok('大纲提示词带 JSON 输出约束', outlinePrompts.length >= 1 && /【输出格式】/.test(outlinePrompts[0]))
ok('作者资料仍走不可信数据块', outlinePrompts[0].includes('【资料】') && /作者原文|不可信|资料/.test(outlinePrompts[0]))

// ---------- 整章改写 ----------
const rewritePrompts: string[] = []
const rewritten = await aiRewriteChapter({
  title: '第一章',
  body: '原文第一段。原文第二段。',
  action: 'polish',
  requirement: '对话更口语些',
  isLatest: true,
  acpText: async prompt => {
    rewritePrompts.push(prompt)
    return '好的，以下是修改后的内容：\n改写后的正文。'
  },
})
ok('整章改写走 ACP', rewritten === '改写后的正文。')
ok('改写提示词保留作者要求与原文', rewritePrompts.length === 1 && rewritePrompts[0].includes('对话更口语些') && rewritePrompts[0].includes('原文第一段'))
const rewriteSrc = read('src/lib/aiTasks/rewrite.ts')
ok('整章改写不强制 API 配置', rewriteSrc.includes('o.acpText ? null : await requireProviderFor'))
ok('补字/压缩沿用同一 ACP 通道', (rewriteSrc.match(/acpText: o\.acpText/g) ?? []).length >= 2)

// ---------- 接线静态契约 ----------
const workflow = read('src/lib/ai/aiWorkflow.ts')
ok('三阶段各取自己的 ACP 发送器',
  ['creative-bible', 'creative-outline', 'autocontinue'].every(task => workflow.includes(`'${task}'`)))
ok('三阶段都在调用点注入 acpText',
  (workflow.match(/acpText: acp(Bible|Outline|Continue)/g) ?? []).length === 3)
const session = read('src/lib/creative/creativeSession.ts')
ok('创意会话可注入 ACP 工厂', session.includes('setCreativeAcpTextFor') && session.includes('acpTextFor'))
ok('整章改写也走同一工厂', session.includes("'chapter-rewrite'") && session.includes('aiRewriteChapter({'))
ok('工厂不落盘（模块级变量）', !/localStorage|putSetting|db\.save/.test(session.slice(session.indexOf('let creativeAcpTextFor'), session.indexOf('let creativeAcpTextFor') + 400)))
const hook = read('src/components/creative/useCreativeWritingModel.ts')
ok('界面按 ACP 就绪注册工厂', hook.includes('setCreativeAcpTextFor') && hook.includes('acpGatedText'))
ok('开跑条件改为写作就绪', /canStart = writingReady/.test(hook))
const setup = read('src/components/creative/CreativeSetupSection.tsx')
ok('未就绪提示区分 ACP 未连接', /acpWriting \? '请先在模型设置中连接 ACP Agent'/.test(setup))
const bridge = read('src/lib/agentHost/acpBridge.ts')
for (const task of ['creative-bible', 'creative-outline', 'autocontinue', 'chapter-rewrite']) ok(`任务标识登记 ${task}`, bridge.includes(`'${task}'`))
const main = read('electron/main.cjs')
for (const task of ['creative-bible', 'creative-outline', 'autocontinue', 'chapter-rewrite']) ok(`主进程放行 ${task}`, main.includes(`'${task}'`))

console.log(`\nACP_CREATIVE ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
