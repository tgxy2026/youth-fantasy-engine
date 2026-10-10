// 3.0 · W2-2 按章审计留痕与失效 · 单测
//
// 盯三件事：
//   ① `checkAuditFresh` 的失效判据（🔴 指纹一致才算作数；改坏又改回原样也算改过）；
//   ② `toAuditRecord` 折算口径（只报数、不含全文）；
//   ③ 🔴 **源码闸** —— 面板只标注不自动重跑；留痕失败静默；复用 chapterFingerprint 不另发明。
import fs from 'node:fs'
import { checkAuditFresh, toAuditRecord, humanAgo, type ChapterAuditRecord } from '../src/lib/outline/chapterAudit'
import type { ChapterCheckReport } from '../src/lib/outline/chapterCheck'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type ChLike = { title: string; content: string; wordCount: number; updatedAt: number }
const ch = (over: Partial<ChLike> = {}): ChLike => ({
  title: '第1章 废脉', content: '正文内容', wordCount: 4, updatedAt: 1000, ...over,
})

/** 造一份最小报告（类型断言即可，本模块只读各数组长度） */
const report = (over: Partial<ChapterCheckReport> = {}): ChapterCheckReport => ({
  chapterId: 'c1', chapterTitle: '第1章 废脉',
  continuity: [], foreshadow: { codes: [], issues: [] },
  sensitive: [], typos: [], style: [], ...over,
} as ChapterCheckReport)

console.log('\n—— chapterAudit 用例开始 ——')

// ---------- ① checkAuditFresh ----------
{
  const base = ch()
  const rec = { ...toAuditRecord(report(), base, 5000), actionables: 0 } as ChapterAuditRecord

  ok('无记录 → 不 fresh，原因「还没有体检过」',
    checkAuditFresh(null, base).fresh === false && checkAuditFresh(null, base).reason === '还没有体检过')
  ok('undefined 同样处理', checkAuditFresh(undefined, base).fresh === false)

  ok('指纹一致 → fresh', checkAuditFresh(rec, base).fresh === true)

  ok('正文改了 → 不 fresh，原因「正文在上次体检后改过」',
    checkAuditFresh(rec, ch({ content: '改过的正文' })).reason === '正文在上次体检后改过')
  ok('字数变了 → 不 fresh', checkAuditFresh(rec, ch({ wordCount: 99 })).fresh === false)
  ok('🔴 updatedAt 变了（内容一样）→ 也算改过',
    checkAuditFresh(rec, ch({ updatedAt: 2000 })).fresh === false)
  ok('标题变了 → 不 fresh', checkAuditFresh(rec, ch({ title: '换个名' })).fresh === false)

  ok('记录缺指纹 → 不 fresh，给「记录不完整」',
    checkAuditFresh({ ...rec, fingerprint: '' }, base).reason.includes('不完整'))
}

// ---------- ② toAuditRecord ----------
{
  const rep = report({
    continuity: [{ id: 'x' } as never],
    foreshadow: { codes: ['F0001'], issues: [{ id: 'y' } as never, { id: 'z' } as never] },
    sensitive: [{ count: 3 } as never, { count: 1 } as never],
    typos: [{ count: 2 } as never],
    style: [{ id: 's1' } as never],
  })
  const r = toAuditRecord(rep, ch(), 7777)
  ok('counts 各类计数正确',
    r.counts.continuity === 1 && r.counts.foreshadow === 2 && r.counts.sensitive === 4
    && r.counts.typos === 2 && r.counts.style === 1, JSON.stringify(r.counts))
  ok('at 用传入时刻', r.at === 7777)
  ok('chapterId / chapterTitle 带上', r.chapterId === 'c1' && r.chapterTitle === '第1章 废脉')
  ok('🔴 只报数不存全文（记录里没有问题列表字段）',
    !('issues' in r) && !('sensitive' in r) && !('typos' in r))
  ok('指纹 = chapterFingerprint（与基准一致）', checkAuditFresh(r, ch()).fresh === true)
  ok('章题为空时回落 ch.title', toAuditRecord(report({ chapterTitle: '' }), ch(), 1).chapterTitle === '第1章 废脉')
}

// ---------- ③ humanAgo ----------
{
  const now = 10_000_000
  ok('1 分钟内 → 刚刚', humanAgo(now - 30_000, now) === '刚刚')
  ok('分钟级', humanAgo(now - 5 * 60_000, now) === '5 分钟前')
  ok('小时级', humanAgo(now - 3 * 3600_000, now) === '3 小时前')
  ok('天级', humanAgo(now - 2 * 86400_000, now) === '2 天前')
  ok('未来时间 / NaN 不炸，按「刚刚」',
    humanAgo(now + 9999, now) === '刚刚' && humanAgo(NaN, now) === '刚刚')
}

// ---------- ④ 🔴 源码闸 ----------
{
  const lib = fs.readFileSync('src/lib/outline/chapterAudit.ts', 'utf8')
  ok('🔴 复用 chapterFingerprint（不另发明指纹）', lib.includes('chapterFingerprint('))
  ok('🔴 走 settingsKV（getSetting/setSetting）+ 自带 pid 前缀说明',
    lib.includes('getSetting') && lib.includes('setSetting') && lib.includes("'chapterAudit'"))
  ok('🔴 只报数不存全文（注释明确 + 无 issues 字段）', lib.includes('不存问题全文') && !/issues\??:/.test(lib))
  ok('留痕失败静默（catch 空）', lib.includes('// 静默') || lib.includes('catch {\n    //'))

  const panel = fs.readFileSync('src/components/outline/ChapterCheckPanel.tsx', 'utf8')
  ok('面板跑完留痕', panel.includes('saveChapterAudit(rep, active'))
  ok('面板读留痕并判失效', panel.includes('loadChapterAuditStatus('))
  ok('🔴 不自动重跑（读留痕只用 useEffect，run 只由按钮触发）',
    !/useEffect\([^)]*run\(\)/.test(panel) && panel.includes('onClick={() => void run()}'))
  ok('过期时给醒目提示且提示要手动重跑', /已过期.*重新点「体检本章」/.test(panel))
  ok('过期标注用 alert 色（text-amber）', panel.includes('text-amber'))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
