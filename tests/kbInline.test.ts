// ============ 参考资料注入降级 + 临时附件（3.0.3）============
//
// 钉住两件事：
//   ① `buildKbBlock` **没有焦点章**时不再整段放弃 —— 退用 `fallbackQuery`（项目级文本）。
//      这一条不钉住，"挂了资料却读不到"的静默失效会随时回来（29 个装配点里有 16 个曾中招）。
//   ② 一次性临时附件的多实例互不干预 —— 空列表不得清掉别人的文件。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/app/seedData'
import { buildKbBlock } from '../src/lib/search/kbInject'
import {
  clearTempDocs, getTempDocs, renderTempDocs, setTempDocs,
  TEMP_DOC_PER_CHARS,
} from '../src/lib/ai/tempDocs'

/** 读项目内源码文本（用于"源码纪律"类断言，防重构时被改回去） */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`) }
}

console.log('【3.0.3 参考资料注入降级 + 临时附件】\n')

// ---------- ① buildKbBlock 的项目级降级 ----------
console.log('  ── ① 没有焦点章时也能召回 ──')

// 🔴 buildKbBlock 第一行就是 `db.getCurrentProjectId()`，没项目直接返回空串 ——
// 所以必须先建一个项目（否则测的是"没有项目"的分支，而不是本次要修的降级）。
{
  const pid = await createDemoProject()
  db.setCurrentProject(pid)
  ok('已建测试项目', !!db.getCurrentProjectId(), pid)
}
{
  // 无焦点章 + 有 fallbackQuery ⇒ 应当发出召回（不要再 return ''）
  let asked = ''
  const block = await buildKbBlock({
    focusChapterId: undefined,
    fallbackQuery: '书名：测试书\n简介：一本测试用的书',
    limit: 2,
    deps: {
      resolveConfig: async () => null,
      recall: (async (q: string) => { asked = q; return [] }) as never,
    },
  })
  ok('无焦点章且 fallbackQuery 为空的旧行为已修：不再提前返回', typeof asked === 'string',
    asked ? `（实际发起了召回，query 长度 ${asked.length}）` : '（没有发起召回）')
  ok('召回 query 用的正是 fallbackQuery（不是焦点章）', asked.includes('测试书'), asked.slice(0, 30))
  ok('召回为空时返回空串（调用方据此不 push）', block === '')
}

{
  // 有焦点章 ⇒ 仍优先用焦点章文本（口径与语义召回一致）
  let asked = ''
  await buildKbBlock({
    focusChapterId: 'ch-1',
    fallbackQuery: '项目级文本',
    deps: {
      loadChapters: async () => [{ id: 'ch-1', title: '第一章 雨夜', summary: '主角遇到神秘人', content: '正文内容' }],
      resolveConfig: async () => null,
      recall: (async (q: string) => { asked = q; return [] }) as never,
    },
  })
  ok('有焦点章时优先用焦点章文本（与语义召回同一取法）',
    asked.includes('第一章 雨夜') && asked.includes('神秘人'), asked.slice(0, 30))
}

{
  // 二者皆空 ⇒ 仍然不该发请求
  let called = false
  const block = await buildKbBlock({
    focusChapterId: undefined,
    fallbackQuery: '   ',
    deps: {
      resolveConfig: async () => null,
      recall: (async () => { called = true; return [] }) as never,
    },
  })
  ok('焦点章与 fallbackQuery 都为空 ⇒ 不发召回（省一次请求）', called === false)
  ok('  并且返回空串', block === '')
}

// ---------- ①-B 走真实 recallKnowledge（不 mock recall）----------
// 上面的用例 mock 了 recall；这里**不 mock recall**，用真实的两级降级链路。
// 🔴 必须先装内存 kb 后端：Node 环境没有 indexedDB，默认后端 getBody 会静默返回空串，
//    于是召回「看着没报错、却什么都捞不到」——正是本项目反复强调的「静默降级」陷阱。
console.log('  ── ①-B 真实召回（不 mock recall） ──')
{
  const kbMod = await import('../src/lib/search/knowledgeBase')
  const docsMap = new Map()
  const bodyMap = new Map()
  kbMod.setKbBackend({
    list: async () => [...docsMap.values()],
    put: async (d) => { docsMap.set(d.id, d) },
    del: async (id) => { docsMap.delete(id); bodyMap.delete(id) },
    getBody: async (id) => bodyMap.get(id) ?? '',
    putBody: async (id, text) => { bodyMap.set(id, text) },
    delBody: async (id) => { bodyMap.delete(id) },
    clearProject: async () => { docsMap.clear(); bodyMap.clear() },
  })

  const pidNow = db.getCurrentProjectId()
  const SENTINEL = 'SENTINEL_KB_INLINE_ZQ7'
  await kbMod.importDoc({
    projectId: pidNow,
    title: '世界观纲要_LIVE',
    text: `世界名为艾尔达，魔法名为符文术，所有力量源于初始之火。${SENTINEL}`,
    sourceType: 'txt',
    enabled: true,
  })
  ok('参考资料已导入并默认启用(enabled:true)', (await kbMod.listDocs(pidNow)).every(d => d.enabled))

  // 无焦点章 + 项目级降级 query ⇒ 真实召回（未配嵌入 ⇒ 走关键词降级）
  const block = await buildKbBlock({
    focusChapterId: undefined,
    fallbackQuery: '世界观 魔法 符文 初始之火',
    limit: 2,
  })
  ok('真实召回拿到了这篇资料', typeof block === 'string' && block.length > 0, `段长 ${block.length}`)
  ok('资料正文（哨兵串）真的进了可注入文本', block.includes(SENTINEL))
  ok('段头会说明是「按需捞出的片段」（不与设定混淆）', /参考|片段|挂载/.test(block))
}

// ---------- ①-C 装配器真的把参考资料段放进结果 ----------
console.log('  ── ①-C 装配器端到端（buildProjectContext） ──')
{
  const { buildProjectContext } = await import('../src/lib/ai/aiContext')
  const built = await buildProjectContext({ budget: 6000, includeChapterList: false })
  ok('装配结果含〖参考资料〗段', /〖参考资料〗/.test(built.text), built.sections.join(' / '))
  ok('参考资料正文真的进了上下文', built.text.includes('SENTINEL_KB_INLINE_ZQ7'))
  ok('该段记进了 sections（「上下文查看」能看见）', built.sections.some(s => /参考资料/.test(s)))

  // 临时附件走装配器
  const { setTempDocs, clearTempDocs } = await import('../src/lib/ai/tempDocs')
  setTempDocs('live-test-owner', [{ name: '临时附件.md', text: 'SENTINEL_TEMP_QQQ 一次性附件内容' }])
  const built2 = await buildProjectContext({ budget: 6000, includeChapterList: false })
  ok('装配结果含〖本次附加文件〗段', /〖本次附加文件〗/.test(built2.text))
  ok('临时附件正文真的进了上下文', built2.text.includes('SENTINEL_TEMP_QQQ'))
  ok('附加文件排在最前（作者显式给的，绝不被预算挤掉）',
    built2.sections.length > 0 && built2.sections[0] === '本次附加文件',
    '首个段=' + built2.sections[0] + '｜顺序=' + built2.sections.slice(0, 2).join('>')
    + '｜附件@' + built2.text.indexOf('〖本次附加文件〗') + ' 参考@' + built2.text.indexOf('〖参考资料〗'))
  clearTempDocs('live-test-owner')

  // 纯解析类显式关闭后不该出现这两段
  const off = await buildProjectContext({ budget: 6000, includeChapterList: false, kb: false })
  ok('kb:false 时装配结果不含〖参考资料〗', !/〖参考资料〗/.test(off.text))
}

// ---------- ② 临时附件的多实例规则 ----------
console.log('\n  ── ② 一次性附件：多实例互不干预 ──')

{
  const A = 'panel-A'
  const B = 'panel-B'
  clearTempDocs(A); clearTempDocs(B)
  ok('初始为空', getTempDocs().length === 0)

  // A 挂载时的空列表不得清掉 B 的文件
  setTempDocs(B, [{ name: 'b.md', text: 'B 的内容' }])
  setTempDocs(A, [])
  ok('A 挂载时的空列表不会清掉 B 的文件', getTempDocs().length === 1 && getTempDocs()[0].name === 'b.md')

  // A 自己卸载只清自己
  clearTempDocs(A)
  ok('A 卸载不清别人的', getTempDocs().length === 1)

  // 后附加的接管
  setTempDocs(A, [{ name: 'a.txt', text: 'A 的内容' }])
  ok('A 附加后接管', getTempDocs()[0].name === 'a.txt')

  // A 卸载清掉自己那份
  clearTempDocs(A)
  ok('持有者卸载即清空', getTempDocs().length === 0)

  clearTempDocs(B)
}

// ---------- ③ 渲染上限与诚实告知 ----------
console.log('\n  ── ③ 渲染上限与诚实告知 ──')
{
  const longDoc = { name: 'big.txt', text: 'x'.repeat(TEMP_DOC_PER_CHARS + 500) }
  const out = renderTempDocs([longDoc])
  ok('单份超限被截断并如实说明', out.includes('其余已略'))
  ok('截断后长度不超过上限 + 头尾余量', out.length < TEMP_DOC_PER_CHARS + 200)

  // 合计上限的触发点是"再进一份就超过 4 万字"：两份各 2 万字只用到 40007 字（< 40000？不，
  // 40007 > 40000 —— 但判定发生在**进入第二份前**，那时 used 才 20007，故第二份仍进得来）。
  // ⇒ 要触发丢弃需要**第三份**：前两份已把 used 推到 40007，第三份进门前即被判超限。
  const three = [
    { name: '1.txt', text: 'y'.repeat(TEMP_DOC_PER_CHARS) },
    { name: '2.txt', text: 'z'.repeat(TEMP_DOC_PER_CHARS) },
    { name: '3.txt', text: 'w'.repeat(TEMP_DOC_PER_CHARS) },
  ]
  const out3 = renderTempDocs(three)
  ok('合计超限时多出的那份被丢弃并列出名单', out3.includes('未带入') && out3.includes('3.txt'))
  ok('前两份仍完整带入', out3.includes('1.txt') && out3.includes('2.txt'))

  ok('空清单返回空串', renderTempDocs([]) === '')
  const mixed = renderTempDocs([{ name: 'ok.txt', text: '有内容' }, { name: 'empty.txt', text: '   ' }])
  ok('空内容条目仍照常渲染（picker 侧已过滤，这里只保证不崩）', mixed.includes('ok.txt'))
}

// ---------- ④ 源码纪律：装配器真的用上了降级 ----------
console.log('\n  ── ④ 源码纪律（防止重构时被改回去） ──')
{
  const ai = read('src/lib/ai/aiContext.ts')
  ok('装配器向 buildKbBlock 传 fallbackQuery', /fallbackQuery:\s*projectLevelQuery/.test(ai))
  ok('参考资料注入不再要求 focusChapterId', !/kb !== false && opts\.focusChapterId/.test(ai))
  ok('伴写关了相关章节召回（relatedChapterLimit: 0）', /relatedChapterLimit:\s*0/.test(ai))
  ok('伴写关了语义召回（semantic: false）', /semantic:\s*false/.test(ai))
  ok('伴写给参考资料设了小额预算（kbMaxChars）', /kbMaxChars:\s*400/.test(ai))

  // 纯解析/整理类必须显式关掉
  const tbl = read('src/lib/ai/tableImportAI.ts')
  const org = read('src/lib/search/organizeRows.ts')
  ok('tableImportAI 显式 kb:false（纯解析，不该带资料）', /kb:\s*false/.test(tbl))
  ok('organizeRows 显式 kb:false（纯整理，不该带资料）', /kb:\s*false/.test(org))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
