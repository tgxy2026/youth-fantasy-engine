// ============ 酒馆模式 · 剧情模式上下文档位（方案 §4.2）============
//
// 这一组断言盯的是**整个剧情模式成立与否的那条线**：
//   「角色视角」必须把作者侧资料（全书总纲 / 分卷大纲 / 伏笔追踪…）彻底挡在上下文之外。
//   带进去 = 剧透 = AI 变成「知道结局的演员」，「测试角色真实反应」这个目的直接归零。
// 用示范项目的数据跑（老大指定）。
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/seedData'
import { buildProjectContext, buildChapterDigest } from '../src/lib/aiContext'
import { TABS } from '../src/lib/schema'
import { flattenChapters } from '../src/lib/chapterSeq'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const nameOf = (id: string) => TABS.find(t => t.id === id)?.name ?? id

async function main() {
  __resetMockStores()
  const pid = await createDemoProject()
  db.setCurrentProject(pid)

  const BIG = 200000 // 预算给足，保证「带没带」只取决于档位，而不是被预算裁掉

  // ---------- 1) 先摸清示范项目里实际有哪些资料（自适应，不靠猜） ----------
  // ⚠️ 示范项目里「全书总纲」「世界设定」等表恰好是空的，而空段会被 push 跳过 ——
  // 所以断言必须基于「实际带上来的段落」构造，否则测的是自己的想象而不是代码。
  const base = await buildProjectContext({ budget: BIG })
  const AUTHOR_SIDE = ['master', 'volume-outline', 'chapter-outline', 'chapter-master', 'foreshadow', 'hookpoints', 'subplots', 'ideas']
  const COMMON_SIDE = ['worldbase', 'char-main', 'relations', 'terms', 'nations', 'geography']
  const authorPresent = AUTHOR_SIDE.filter(id => base.sections.includes(nameOf(id)))
  const commonPresent = COMMON_SIDE.filter(id => base.sections.includes(nameOf(id)))
  ok('示范项目里确实存在作者侧资料（后续断言的前提）', authorPresent.length > 0,
    '作者侧=' + authorPresent.map(nameOf).join('、'))
  ok('示范项目里确实存在角色常识类资料（后续断言的前提）', commonPresent.length > 0,
    '常识=' + commonPresent.map(nameOf).join('、'))
  ok('默认档位下这些资料全部照常带入（既有 AI 功能不受影响）',
    authorPresent.every(id => base.sections.includes(nameOf(id))) &&
    commonPresent.every(id => base.sections.includes(nameOf(id))))

  // ---------- 2) 角色视角：作者侧一段都不能漏 ----------
  const cv = await buildProjectContext({ budget: BIG, viewMode: 'character-view' })
  ok('角色视角文本里不出现「全书总纲」字样', !cv.text.includes(nameOf('master')))
  const leaked = authorPresent.filter(id => cv.sections.includes(nameOf(id)))
  ok('角色视角下作者侧资料一段都不带（防剧透的核心）', leaked.length === 0,
    '漏=' + leaked.map(nameOf).join('、'))
  const missingCommon = commonPresent.filter(id => !cv.sections.includes(nameOf(id)))
  ok('角色视角仍带角色「常识」（世界/角色/关系/名词/势力）', missingCommon.length === 0,
    '丢=' + missingCommon.map(nameOf).join('、'))

  // ---------- 3) 导演视角：作者侧照带（但仍受锚点约束） ----------
  const dv = await buildProjectContext({ budget: BIG, viewMode: 'director-view' })
  ok('导演视角带作者侧资料', authorPresent.every(id => dv.sections.includes(nameOf(id))))

  // ---------- 4) 锚点裁剪：章节清单只到锚点章 ----------
  const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  const flat = [...flattenChapters(vols, chs), ...chs.filter(c => !vols.some(v => v.id === c.volumeId))]
  ok('示范项目章节数足够做锚点测试（≥3 章）', flat.length >= 3, `实际=${flat.length}`)

  if (flat.length >= 3) {
    const anchor = flat[2]                 // 第 3 章作锚点
    const later = flat[flat.length - 1]    // 最后一章
    const digestAll = await buildChapterDigest()
    const digestCut = await buildChapterDigest(200, anchor.id)

    ok('锚点裁剪：锚点章本身仍在清单里', digestCut.includes(anchor.title || '未命名章节'))
    ok('锚点裁剪：锚点之后的章不再出现', !digestCut.includes(later.title || '未命名章节'),
      `锚点=${anchor.title} 之后=${later.title}`)
    ok('锚点裁剪后的清单比全量短', digestCut.length < digestAll.length)
    ok('锚点裁剪：锚点之前的内容保持完整', digestCut.length > 0 && digestAll.startsWith(digestCut.split('\n')[0]))

    // 锚点不存在时：安全兜底，不裁剪（宁可多带，也不要把上下文清空）
    const digestBad = await buildChapterDigest(200, 'no-such-chapter-id')
    ok('锚点不存在时不裁剪（安全兜底）', digestBad.length === digestAll.length)

    // buildProjectContext 的章节清单同样受锚点约束
    const ctxCut = await buildProjectContext({ budget: BIG, viewMode: 'character-view', anchorChapterId: anchor.id })
    ok('角色视角 + 锚点：清单同样截断到锚点', !ctxCut.text.includes(`${later.title}（`))
  }

  // ---------- 5) 知情者过滤（secrets 事实边界） ----------
  const secretRows = await db.getTableRows('secrets')
  ok('示范项目含知情权限数据', secretRows.length > 0, `实际=${secretRows.length} 行`)
  if (secretRows.length > 0) {
    const knower = String(secretRows[0].data?.['知情者'] ?? '').split(/[、,，/｜|]/)[0].trim()
    ok('能取到第一个知情者姓名', !!knower, `获得=${JSON.stringify(knower)}`)
    if (knower) {
      const noFilter = await buildProjectContext({ budget: BIG, viewMode: 'character-view' })
      const filtered = await buildProjectContext({ budget: BIG, viewMode: 'character-view', knowerName: knower })
      const secName = nameOf('secrets')
      ok('不传知情者时 secrets 全量带入', noFilter.sections.includes(secName))
      // 过滤后该角色知情的条目必须还在
      const firstSecret = String(secretRows[0].data?.['秘密内容'] ?? '').slice(0, 12)
      ok('知情者的条目仍在上下文里', !firstSecret || filtered.text.includes(firstSecret),
        `查=${JSON.stringify(firstSecret)}`)
      ok('知情者过滤后文本不更长（确实剔掉了他不知情的条目）', filtered.text.length <= noFilter.text.length,
        `${filtered.text.length} vs ${noFilter.text.length}`)
    }
  }

  // ---------- 6) 档位与锚点可组合 ----------
  {
    const combo = await buildProjectContext({ budget: BIG, viewMode: 'character-view', anchorChapterId: flat[0].id })
    ok('角色视角 + 锚点可同时生效', combo.sections.length > 0 && !combo.text.includes(nameOf('master')))
  }

  console.log(`\ntavernContext: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
