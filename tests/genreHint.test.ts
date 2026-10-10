// ============ 「作品题材要不要告诉 AI」项目级开关（3.0 · 社区反馈）============
//
// 背景：2.7.1 起 `Project.genre` 会经 `aiContext` 的「作品概览」块**无条件**注入成
// 「类型：东方修真」—— 而题材的最初定位只是「决定开书定位组各页签的字段名与示例」。
// 社区作者反馈"选的题材会影响 AI 生成的内容"，核查确认属实（注入点唯一，见
// `aiContext.ts` 的 `genreLineForAI(proj.genre)`）。
//
// 处置：默认**不再**注入 + 项目级开关 + 披露（`AI_OVERVIEW_NOTE`）。
//
// 本用例盯三件事，都是**会造成实际后果**的：
//   ① 纯函数边界：开关关 / 题材空 / 老自由文本归位 —— 少一条就可能把空行或脏值发出去；
//   ② 默认口径：没设过开关的项目，上下文里**不能**出现「类型：」（默认必须是关）；
//   ③ 项目隔离：开关是项目级（`settingsKV` 带 `<pid>::` 前缀）—— A 开了不能让 B 也带上。
//      🔴 这条最要紧：写成全局 meta 时本用例会红，而界面上表现为"改了 A、B 行为也变"。
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/app/seedData'
import { buildProjectContext } from '../src/lib/ai/aiContext'
import {
  DEFAULT_GENRE_TO_AI, genreLineOf, getGenreToAI, setGenreToAI, getGenreToAIFor, setGenreToAIFor,
} from '../src/lib/ai/aiGenreHint'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 上下文里是否出现「作品概览」的题材行（`类型：` 后紧跟值；「类型赛道：」不算） */
const hasGenreLine = (text: string, pack: string) => text.includes(`类型：${pack}`)

async function main() {
  __resetMockStores()

  // ---------- 1) 纯函数（genreLineOf） ----------
  ok('出厂默认值是「关」', DEFAULT_GENRE_TO_AI === false)
  ok('开关关 → 不输出（即使题材有值）', genreLineOf('都市异能', false) === '')
  ok('开关开 + 题材为空 → 不输出（不留空行）', genreLineOf('', true) === '')
  ok('开关开 + undefined → 不输出', genreLineOf(undefined, true) === '')
  ok('开关开 + 空格串 → 不输出', genreLineOf('   ', true) === '')
  ok('开关开 + 标准包名 → 类型：都市异能', genreLineOf('都市异能', true) === '类型：都市异能')
  ok('开关开 + 老自由文本 → 别名归位', genreLineOf('东方玄幻', true) === '类型：东方修真')
  ok('开关开 + 复合描述 → 模糊归位', genreLineOf('仙侠·升级流', true) === '类型：东方修真')
  ok('开关开 + 认不出的值 → 落默认包', genreLineOf('随便写的赛道', true) === '类型：东方修真')

  // ---------- 2) 项目级读写往返 ----------
  const pid = await createDemoProject()
  db.setCurrentProject(pid)
  ok('新项目的开关默认为关', (await getGenreToAI()) === false)
  await setGenreToAI(true)
  ok('写入后可读回', (await getGenreToAI()) === true)
  await setGenreToAI(false)
  ok('关掉后可读回', (await getGenreToAI()) === false)

  // ---------- 3) 上下文默认口径：不带题材 ----------
  await db.updateProject({ id: pid, genre: '都市异能' })
  const BIG = 200000

  const off = await buildProjectContext({ budget: BIG })
  ok('默认（开关关）上下文不含「类型：都市异能」', !hasGenreLine(off.text, '都市异能'))
  // 前提：作品信息表的「类型赛道」字段确实在上下文里（它是另一路，且**不受本开关影响**）
  ok('前提：「类型赛道」字段该发就发（与本开关无关）', off.text.includes('类型赛道'))
  ok('前提：作品概览仍在（只是没了题材那一行）', off.sections.includes('作品概览') && off.text.includes('书名：'))

  await setGenreToAI(true)
  const on = await buildProjectContext({ budget: BIG })
  ok('开关开 → 上下文含「类型：都市异能」', hasGenreLine(on.text, '都市异能'))

  // ---------- 4) 项目隔离（最容易写错的一条） ----------
  // 🔴 必须用 createProject 建一本**新书**，不能再用 createDemoProject：
  //    后者内部会先 deleteProject 把已有的示范项目删掉（连它的 settingsKV 一起清），
  //    于是第 3 步写下的开关被连带删除 ⇒ 本用例会误报"项目隔离失效"（实测踩过）。
  // 🔴 `createProject` 返回的是 **Project 对象**（不是 id）—— 直接拿它当 id 用会让
  //    currentProjectId 变成 "[object Object]"，于是 getProject 取不到项目、
  //    「作品概览」整段消失 ⇒ 本用例会以一堆假通过蒙混过去（实测踩过）。
  const p2 = await db.createProject('测试用第二本书', '西方奇幻')
  const pid2 = p2.id
  db.setCurrentProject(pid2)
  await db.updateProject({ id: pid2, genre: '西方奇幻' })
  ok('另一项目默认不带（没跟着 A 一起开）', !hasGenreLine((await buildProjectContext({ budget: BIG })).text, '西方奇幻'))
  ok('按 pid 读那本仍是「开」（各记各的）', (await getGenreToAIFor(pid)) === true)
  ok('按 pid 读这本是「关」', (await getGenreToAIFor(pid2)) === false)
  await setGenreToAIFor(pid2, true)
  ok('按 pid 打开后，这本也带题材', hasGenreLine((await buildProjectContext({ budget: BIG })).text, '西方奇幻'))

  // ---------- 5) 边界：题材为空时开了开关也不留「类型：」 ----------
  // 只看「作品概览」那一段：设定资料段里本来就可能有以「类型」开头的字段（如「类型赛道」），
  // 拿整篇 text 搜「类型：」会误伤（渲染成「类型赛道：…」时不命中，但字段值里可能带冒号）。
  const overviewOf = (text: string) => {
    const i = text.indexOf('〖作品概览〗')
    if (i < 0) return ''
    const j = text.indexOf('〖', i + 1)
    return text.slice(i, j < 0 ? undefined : j)
  }
  await db.updateProject({ id: pid2, genre: '' })
  const empty = await buildProjectContext({ budget: BIG })
  ok('开关开但题材为空 → 作品概览里没有题材行', !overviewOf(empty.text).includes('类型：'),
    JSON.stringify(overviewOf(empty.text)))
  // 反向前提：同一次装配里，有题材时那一行确实在概览段内（证明上面的判定位置没找错）
  await db.updateProject({ id: pid2, genre: '武侠江湖' })
  const filled = await buildProjectContext({ budget: BIG })
  ok('前提：概览段定位正确（有题材时该行在段内）', overviewOf(filled.text).includes('类型：武侠江湖'))

  if (fail) { console.log(`\n${fail} 条失败 / 共 ${pass + fail}`); process.exit(1) }
  console.log(`\n全部通过：${pass} 条`)
}

main().catch(e => { console.error(e); process.exit(1) })
