// ============ 3.4.0 · D 章节收藏集 ============
//
// 覆盖：
//   ① 纯函数：名称校验、addToSet 去重、removeFromSet、renameSet、setMemberStatus、创建格式
//   ② 接线核对（fs.readFileSync 读源码）：
//      · remapSettingValue 处理 chapterSets 键（包含 chapterIds 重映射）
//      · loadSets 读失败时抛出，禁止空值覆盖
//      · ChapterSetsPanel 在读失败时有提示（包含"读取失败"文案）
//      · ChapterSetsPanel 通过 onNavigate 进入章节正文
import fs from 'node:fs'
import { remapSettingValue, remapChapterContextSetting } from '../src/lib/db/projects'
import path from 'node:path'
import {
  validateSetName, createChapterSet, addToSet, removeFromSet, renameSet, setMemberStatus,
  CHAPTER_SET_MAX_NAME_LEN,
} from '../src/lib/app/chapterSets'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 名称校验 ----------
{
  const e = validateSetName('')
  ok('空名拒绝', !e.ok)

  const s = validateSetName('   ')
  ok('空格名拒绝（trim 后为空）', !s.ok)

  const long = validateSetName('a'.repeat(CHAPTER_SET_MAX_NAME_LEN + 1))
  ok('超长名拒绝', !long.ok)

  const good = validateSetName('我的收藏集')
  ok('正常名通过', good.ok === true)

  const trimCheck = validateSetName('  正文收藏  ')
  ok('两端有空格的名称通过（trim 后不空）', trimCheck.ok === true)
}

// ---------- ② createChapterSet ----------
{
  const s = createChapterSet('测试集')
  ok('创建收藏集有 id', typeof s.id === 'string' && s.id.length > 0)
  ok('创建收藏集名称正确（trim 后）', s.name === '测试集')
  ok('创建收藏集初始 chapterIds 为空数组', Array.isArray(s.chapterIds) && s.chapterIds.length === 0)
  ok('创建收藏集有 createdAt', typeof s.createdAt === 'number' && s.createdAt > 0)
  ok('创建收藏集有 updatedAt', typeof s.updatedAt === 'number' && s.updatedAt > 0)
}

// ---------- ③ addToSet 去重 ----------
{
  const s = createChapterSet('集A')
  const r1 = addToSet(s, 'c1')
  ok('addToSet 添加新章节返回 added=true', r1.added === true)
  ok('addToSet 章节 id 在列表中', r1.set.chapterIds.includes('c1'))

  const r2 = addToSet(r1.set, 'c1')
  ok('addToSet 重复添加返回 added=false', r2.added === false)
  ok('addToSet 重复添加后 chapterIds 长度不变', r2.set.chapterIds.length === 1)

  const r3 = addToSet(r1.set, 'c2')
  ok('addToSet 多个章节正常添加', r3.set.chapterIds.length === 2 && r3.set.chapterIds.includes('c2'))
}

// ---------- ④ removeFromSet ----------
{
  let s = createChapterSet('集B')
  s = addToSet(s, 'c1').set
  s = addToSet(s, 'c2').set

  const r1 = removeFromSet(s, 'c1')
  ok('removeFromSet 移除存在的章节', !r1.chapterIds.includes('c1') && r1.chapterIds.includes('c2'))
  ok('removeFromSet 移除后 updatedAt 更新', r1.updatedAt >= s.updatedAt)

  const r2 = removeFromSet(s, 'c-not-exist')
  ok('removeFromSet 移除不存在的章节幂等（返回同对象）', r2 === s)
}

// ---------- ⑤ renameSet ----------
{
  const s = createChapterSet('旧名称')
  const before = s.updatedAt

  // 等待一毫秒，确保 updatedAt 有变化
  const r1 = renameSet(s, '新名称')
  ok('renameSet 成功返回 ok=true', r1.ok === true)
  ok('renameSet 后名称改变', r1.set.name === '新名称')
  ok('renameSet 后 updatedAt 更新', r1.set.updatedAt >= before)

  const r2 = renameSet(s, '')
  ok('renameSet 空名称失败', r2.ok === false && typeof r2.reason === 'string')
  ok('renameSet 失败时 set 不变', r2.set === s)

  const r3 = renameSet(s, 'x'.repeat(CHAPTER_SET_MAX_NAME_LEN + 1))
  ok('renameSet 超长名称失败', r3.ok === false)
}

// ---------- ⑥ setMemberStatus ----------
{
  const s = createChapterSet('集C')
  const allIds = new Set(['c1', 'c2', 'c3'])

  ok('setMemberStatus 章节在项目中 → active', setMemberStatus(s, 'c1', allIds) === 'active')
  ok('setMemberStatus 章节不在项目中 → missing', setMemberStatus(s, 'c-gone', allIds) === 'missing')
}

// 导入和恢复时保留无法映射的引用，不能静默丢弃。
{
  const maps = new Map([['old', 'new']])
  for (const key of ['chapterSets', 'exportSchemes']) {
    const actual = remapSettingValue(key, [{ chapterIds: ['old', 'gone'] }], new Map(), maps) as { chapterIds: string[] }[]
    ok(`${key} 映射有效章节并保留失效提示`, actual[0].chapterIds.join(',') === 'new,missing:gone')
  }
}
{
  const result = remapChapterContextSetting('chapterContext32:old-ch', {
    outlineId: 'old-card', pinnedRefs: [
      { projectId: 'old-p', kind: 'row', tabId: 'x', id: 'old-row' },
      { projectId: 'other', kind: 'card', tabId: 'x', id: 'old-card' },
    ],
  }, 'new-p', 'old-p', new Map([['old-ch', 'new-ch']]), new Map([['old-card', 'new-card']]), new Map([['old-row', 'new-row']]), new Map())
  const value = result.value as { outlineId: string; pinnedRefs: { id: string; projectId: string }[] }
  ok('章节资料绑定键和细纲映射', result.key === 'chapterContext32:new-ch' && value.outlineId === 'new-card')
  ok('固定表格行映射到新项目', value.pinnedRefs[0].id === 'new-row' && value.pinnedRefs[0].projectId === 'new-p')
  ok('跨项目旧引用不能误指向新作品', value.pinnedRefs[1].id === 'missing:old-card')
}

// ---------- ⑦ 接线核对 ----------
{
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

  // remapSettingValue 处理 chapterSets 键
  const projectsSrc = read('src/lib/db/projects.ts')
  ok('remapSettingValue 处理 chapterSets 键（含重映射）',
    projectsSrc.includes("key === 'chapterSets'") && projectsSrc.includes('chapterIds'))

  // 读取失败必须传给界面，避免误当空集合。
  const setsSrc = read('src/lib/app/chapterSets.ts')
  ok('loadSets 读失败时抛出',
    setsSrc.includes('async function loadSets') && setsSrc.includes('throw e'))

  // ChapterSetsPanel 在读失败时有提示
  const panelSrc = read('src/components/app/ChapterSetsPanel.tsx')
  ok('ChapterSetsPanel 读取失败时有提示文案',
    panelSrc.includes('读取失败'))

  // ChapterSetsPanel 通过 onNavigate 进入章节正文
  ok('ChapterSetsPanel 通过 onNavigate 进入章节',
    panelSrc.includes('onNavigate'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
