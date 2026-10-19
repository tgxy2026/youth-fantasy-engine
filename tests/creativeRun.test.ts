// ============ 「接着已有内容写」端到端回归（本地假模型，不联网 / 不耗额度） ============
//
// 为什么必须有这一层（2026-09-19 复现事故）：
//   这条链路原先只靠前端实机验证兜底 —— 真模型、几分钟、还烧额度，于是下面这个缺陷
//   在项目里躺了很久没人发现：
//     · `aiWorkflow` 调 `runAutoContinue` 时**没传 `onBodyToken`** ⇒ 非流式请求
//       ⇒ 长文必撞 `CHAT_TIMEOUT_MS`(180s) ⇒ 第 1 章就失败；
//     · 同时**没转发 `onLog`** ⇒ 失败原因被吞进内存，界面上只剩一句绿色的
//       「创作完成：写了 0 章」。
//   实测证据：老大那条会话的 `log` 是**空数组**、`result`/`progress` 全空 —— 正是这个黑洞。
//
// 本文件锁四件事：① 真的能写出章节；② 生成正文必须走**流式**（防回退成非流式）；
//   ③ 失败原因必须经 `onRunLog` 露出来（不再黑洞）；④ 选「只做大纲规划」时不许写正文。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { commitOutline, loadChapterOutlines, runCreativeWriting } from '../src/lib/ai/aiWorkflow'
import { startFakeOllama, fakeProvider, FAKE_PROVIDER_ID } from './fake-ollama'
import type { OutlineResult } from '../src/lib/ai/aiTasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const SENT = '夜色像水一样漫过城墙，他握紧了手里的短刃，呼吸压得极低，远处的灯火明明灭灭。'
const PARA = `他沿着墙根往前挪了半步，脚下的碎石发出极轻的一声响。${SENT}`
const BODY = Array.from({ length: 10 }, (_, i) => `（${i + 1}）${PARA}`).join('\n')

/**
 * 续排大纲用的假模型返回值（`aiPlanOutline` 吃 JSON）。
 * 1 卷 + 1 章的规模，够验证"从第 4 章起接着排"。
 */
const EXT_OUTLINE_JSON = JSON.stringify({
  volumes: [{
    title: '第二卷 星海', positioning: '接着第二卷', stage: '筑基→金丹', scope: '星海',
    opening: '离宗远行', climax1: '初战告捷', turn: '同伴背叛', climax2: '决死一战',
    ending: '携秘而归', events: '起→承→转→合', subplots: '支线',
  }],
  chapters: [{
    title: '续章', event: '新事件', function: '推进主线', cast: '主角', hook: '新钩子', scenes: ['场景X'],
  }],
})

/** 造 1 卷 + N 章细纲 */
function mkOutline(count: number, volTitle: string): OutlineResult {
  return {
    volumes: [{
      title: volTitle, positioning: '定位', stage: '炼气→筑基', scope: '云州',
      opening: '卷首', climax1: '高潮一', turn: '转折', climax2: '高潮二', ending: '卷末',
      events: '起→承→转→合', subplots: '支线', chapterRange: '',
    }],
    chapters: Array.from({ length: count }, (_, i) => ({
      no: i + 1, title: `章名${i + 1}`, event: `事件${i + 1}`, fn: '推进',
      cast: '主角', hook: `钩子${i + 1}`, scenes: ['场景A', '场景B'],
    })),
  }
}

/** 把内存库指向假模型 */
async function useFake(port: number) {
  await db.setMeta('aiProviders', [fakeProvider(port)])
  await db.setMeta('aiActiveProviderId', FAKE_PROVIDER_ID)
}

const isBodyCall = (sys: string) => /续写助手/.test(sys)

// ---------- ① 端到端：已有细纲 + 0 正文 → 点「接着写」真的能写出章节 ----------
{
  __resetMockStores()
  db.setCurrentProject('run-pid-1')
  // WQ1-2 适配：连写自检三项走 `json` 分支。未传 json 时假模型默认返回 `[]`，
  // 但**空响应体会让 chat 层报"未返回内容"** ⇒ 新契约下自检 failed ⇒ 暂停连写
  // （这正是要防的"失败吞成通过"的反面被修正后的行为，见 ①-b）。
  // 主链路用例必须显式给 json 一个**合法空结果**，自检才判定"审了没问题"继续写。
  const fake = await startFakeOllama({ body: BODY, json: '[]' })
  await useFake(fake.port)
  await commitOutline(mkOutline(3, '第一卷 星宿初醒'))
  ok('播种：细纲 3 章 / 正文 0 章',
    (await loadChapterOutlines()).size === 3 && (await db.getAllChapters()).length === 0)

  const runLogs: string[] = []
  const res = await runCreativeWriting({}, {
    chapters: 2, targetWords: 600, useOutline: true, target: 'full',
    onRunLog: line => runLogs.push(line),
  }).catch(e => { runLogs.push('抛出：' + (e as Error).message); return null })

  const chs = await db.getAllChapters()
  ok('🟢 真的写出了 2 章（修复前这里是 0 章）', chs.length === 2, String(chs.length))
  ok('返回结果里也是 2 章', res?.chapters.length === 2, String(res?.chapters.length))
  ok('章号从第 1 章连续起排', chs.map(c => c.title).join(',').includes('第1章') && chs.map(c => c.title).join(',').includes('第2章'),
    chs.map(c => c.title).join(' / '))
  ok('🔴 生成正文走的是**流式**（防回退：非流式必撞 180s 墙）',
    fake.calls.filter(c => isBodyCall(c.sys)).length >= 2 && fake.calls.filter(c => isBodyCall(c.sys)).every(c => c.stream),
    JSON.stringify(fake.calls.filter(c => isBodyCall(c.sys)).map(c => c.stream)))
  ok('日志里有落库记录（不再黑洞）', runLogs.some(l => /已保存/.test(l)), runLogs.join(' | ').slice(0, 200))
  const vols = await db.getAllVolumes()
  ok('章节落在播种的那个卷里', chs.every(c => c.volumeId === vols[0].id))
  fake.close()
}

// ---------- ①-b WQ1-2 回归防线：正文正常但自检请求失败 ⇒ 必须暂停，不得落库 ----------
//
// 旧契约：selfRefine 的三项审校 `.catch(() => [])` 把请求失败吞成"无问题"
// ⇒ 自检失败却显示通过、正文照常落库。新契约：必选项失败 ⇒ 暂停连写、本章不保存。
{
  __resetMockStores()
  db.setCurrentProject('run-pid-1b')
  // body 正常（能生成正文），仅 json 分支空响应 ⇒ 三项自检全部 failed
  const fake = await startFakeOllama({ body: BODY, json: '__JSON_EMPTY__' })
  await useFake(fake.port)
  await commitOutline(mkOutline(3, '第一卷 自检失败'))

  const runLogs: string[] = []
  await runCreativeWriting({}, {
    chapters: 2, targetWords: 600, useOutline: true, target: 'full',
    onRunLog: line => runLogs.push(line),
  }).catch(() => {})

  ok('🔴 WQ1-2：自检请求失败 ⇒ 一章都不落库（旧契约会照常保存）',
    (await db.getAllChapters()).length === 0, String((await db.getAllChapters()).length))
  ok('🔴 WQ1-2：日志明说"编辑自检未完成 / 已暂停"（不当成通过）',
    runLogs.some(l => /编辑自检未完成/.test(l)) && runLogs.some(l => /已暂停连写/.test(l)),
    runLogs.join(' | ').slice(0, 200))
  fake.close()
}

// ---------- ② 失败必须看得见：模型返回空 → 日志里有原因，而不是"绿色成功 + 0 章" ----------
{
  __resetMockStores()
  db.setCurrentProject('run-pid-2')
  const fake = await startFakeOllama({ body: '__EMPTY__' })
  await useFake(fake.port)
  await commitOutline(mkOutline(3, '第一卷 空返回'))

  const runLogs: string[] = []
  const res = await runCreativeWriting({}, {
    chapters: 1, targetWords: 600, useOutline: true, target: 'full',
    onRunLog: line => runLogs.push(line),
  }).catch(e => { runLogs.push('抛出：' + (e as Error).message); return null })

  ok('模型返空 → 0 章落库', (await db.getAllChapters()).length === 0)
  ok('🔴 失败原因经 onRunLog 露出来了（防回退：原先被吞成空日志）',
    runLogs.some(l => /失败|未返回内容|异常/.test(l)), JSON.stringify(runLogs).slice(0, 300))
  ok('结果对象如实报告 0 章，界面据此才有资格报错', res?.chapters.length === 0, String(res?.chapters.length))
  fake.close()
}

// ---------- ③ 选「只做大纲规划」→ 从「已排到哪」接着排，且一章正文都不写 ----------
//
// 🔴 2026-09-20 口径变更（老大确认）：「续排起点看**已有细纲最大章号 + 1**，不看正文写到哪」。
//    旧口径下这个场景（细纲 3 章、正文 0 章）会算出 fromNo = 1 → 命中"第 1 章已有细纲、
//    无需续排"→ **直接收工**，于是"想接着往下排"根本排不动 —— 长篇分批规划整条路被堵死。
{
  __resetMockStores()
  db.setCurrentProject('run-pid-3')
  // ⚠️ 大纲任务的 system 提示词里含「JSON」二字 ⇒ 假模型走 `json` 分支，
  //    所以大纲 JSON 必须传给 `json`（传给 `body` 会拿到默认的 `[]`，表现为"模型没有产出细纲"）。
  const fake = await startFakeOllama({ body: EXT_OUTLINE_JSON, json: EXT_OUTLINE_JSON })
  await useFake(fake.port)
  await commitOutline(mkOutline(3, '第一卷 只规划'))

  const reports: string[] = []
  const runLogs: string[] = []
  const res = await runCreativeWriting({}, {
    target: 'outline', volumes: 1, chaptersPerVolume: 1, useOutline: true,
    onProgress: p => reports.push(p.message),
    onRunLog: line => runLogs.push(line),
  }).catch(e => { runLogs.push('抛出：' + (e as Error).message); return null })

  const outs = await loadChapterOutlines()
  ok('🔴 续排起点＝已有细纲最大章号 + 1（旧口径会算出第 1 章并直接收工）',
    reports.some(m => /续排第 2 卷（第 4 章起/.test(m)) || outs.has(4),
    reports.join(' | ') + ' ｜ 细纲章号：' + [...outs.keys()].join(','))
  ok('细纲 3 → 4 张（新的那张排在第 4 章）', outs.size === 4 && outs.has(4), [...outs.keys()].join(','))
  ok('🔴 选了「只做大纲规划」就一章正文都不写（防回退：原先照样进连写）',
    fake.calls.filter(c => isBodyCall(c.sys)).length === 0,
    '正文请求 ' + fake.calls.filter(c => isBodyCall(c.sys)).length + ' 次')
  ok('正文确实没落库', (await db.getAllChapters()).length === 0)
  ok('结果标记为「只做大纲」', res?.outlineOnly === true, String(res?.outlineOnly))
  fake.close()
}

console.log(`\n—— creativeRun 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
