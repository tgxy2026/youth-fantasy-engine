// ============ 3.3.3 · A1 重复与表达观察 ============
//
// 钉住：
//   ① 范围只有「当前章 + 前面最多 N 章」，不含后续章；空章跳过并如实计数；
//   ② 完全重复给**可定位区间**（章 id / 起止 / 逐字引文），引文必须与原文一致；
//   ③ 近似重复单列为候选，不混进"确定重复"；
//   ④ 忽略有作用域（组 id 含文本指纹）、可撤销；正文一变指纹与组 id 都变；
//   ⑤ 缓存/忽略记录是本机专属，不随项目包或云同步走。
import { __resetMockStores, memoryOps } from './mock-memory'
import {
  ALGORITHM_VERSION, analyzeRepetition, diceSimilarity, gramSpans, ignoreKeyOf, normalizeForCompare,
  paragraphSpans, quoteMatches, scopeChapters, scopeFingerprint, sentenceSpans, stableHash,
  type ChapterInput,
} from '../src/lib/audit/repetition'
import {
  activeIgnoreKeys, clearRepetitionCache, ignoreRepetitionGroup,
  loadRepetitionCache, saveRepetitionCache, unignoreRepetitionGroup,
} from '../src/lib/audit/repetitionStore'
import { isLocalOnlyMetaKey } from '../src/lib/storage/sensitiveMeta'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-a1-repetition'

function ch(id: string, order: number, content: string, title = `第${order + 1}章`): ChapterInput {
  return { id, order, content, title }
}

async function main() {
  __resetMockStores()

  // ───────────────── ① 基本切分与标准化 ─────────────────
  {
    ok('标准化忽略标点/空白/全半角',
      normalizeForCompare('他 ， 说：“走吧！”') === normalizeForCompare('他说:走吧'))
    const s = sentenceSpans('第一句。第二句！\n第三句')
    ok('句子切分保留原文区间', s.length === 3 && s[1].raw === '第二句！' && s[1].start === 4)
    const para = paragraphSpans('第一段\n\n第二段\n第三段')
    ok('段落切分跳过空行', para.length === 3 && para[2].raw === '第三段')
    const grams = gramSpans('青岚宗山门青岚宗山门青岚宗山门')
    ok('三字词组计数（同一章 3 次）', (grams.get('青岚宗')?.length ?? 0) === 3)
    ok('dice 相似度对称且同串为 1', diceSimilarity('abcde', 'abcde') === 1 && diceSimilarity('abcde', 'abxde') >= 0.5)
    ok('dice 对一字符之差给出高分', diceSimilarity('他站在山门前久久没有说话', '他站在山门旁久久没有说话') >= 0.8)
  }

  // ───────────────── ② 范围与覆盖 ─────────────────
  {
    const chapters = [
      ch('c1', 0, '第一章的正文内容足够长，用来参与比对。'),
      ch('c2', 1, ''),
      ch('c3', 2, '第三章正文也足够长，用来做范围测试。'),
      ch('c4', 3, '第四章是当前章，内容同样足够长。'),
      ch('c5', 4, '第五章在当前章之后，不应参与比对。'),
    ]
    ok('范围 = 当前章 + 前面 N 章', scopeChapters(chapters, 'c4', 1).map(c => c.id).join(',') === 'c3,c4')
    ok('范围 1–30 夹紧', scopeChapters(chapters, 'c4', 999).length === 4)
    ok('找不到当前章 ⇒ 空', scopeChapters(chapters, 'nope', 10).length === 0)

    const rep = analyzeRepetition({ chapters, currentChapterId: 'c4', range: 10 })
    ok('覆盖不含后续章', rep.coveredChapters === 3, String(rep.coveredChapters))
    ok('空章被跳过并如实计数', rep.skippedEmpty === 1, String(rep.skippedEmpty))
    ok('算法版本进指纹', rep.inputFingerprint.startsWith(`${ALGORITHM_VERSION}:`))
    ok('范围指纹与报告一致',
      scopeFingerprint(chapters, 'c4', 10) === rep.inputFingerprint)
    const changed = chapters.map(c => c.id === 'c1' ? { ...c, content: c.content + '改' } : c)
    ok('正文改一个字 ⇒ 指纹变', scopeFingerprint(changed, 'c4', 10) !== rep.inputFingerprint)
  }

  // ───────────────── ③ 完全重复：定位必须准确 ─────────────────
  {
    const dup = '他站在山门前，久久没有说话。'
    const chapters = [
      ch('a', 0, `开场一段。${dup}后面还有内容。`),
      ch('b', 1, `另一段。${dup}`),
    ]
    const rep = analyzeRepetition({ chapters, currentChapterId: 'b', range: 1 })
    const g = rep.groups.find(x => x.kind === 'sentence' && x.normalized.includes('站在山门前'))
    ok('跨章句重复被聚合为一组', !!g && g.count === 2 && g.chapters === 2, JSON.stringify(g))
    if (g) {
      ok('组 id 含标准化文本指纹', g.id.startsWith('sentence:') && g.id === `sentence:${stableHash(g.normalized)}`)
      ok('两处引文都能在原章逐字命中',
        g.occurrences.every(o => quoteMatches(chapters.find(c => c.id === o.chapterId)!.content, o)))
      ok('区间对得上（取出的就是引文）',
        g.occurrences.every(o => chapters.find(c => c.id === o.chapterId)!.content.slice(o.start, o.end) === dup))
    }
    ok('完全重复计入 exactGroups，不混入候选', rep.exactGroups >= 1 && rep.groups.every(x => !x.candidateOnly || x.kind === 'sentence'))
  }

  // ───────────────── ④ 词组重复与近似候选 ─────────────────
  {
    const chapters = [
      ch('g1', 0, `${'青岚宗'.repeat(3)}的山门，${'青岚宗'.repeat(2)}的牌匾。`),
      ch('g2', 1, '他站在山门前，久久没有说话。'),
      ch('g3', 2, '他站在山门旁，久久没有说话。'),
    ]
    const rep = analyzeRepetition({ chapters, currentChapterId: 'g3', range: 2 })
    const gram = rep.groups.find(x => x.kind === 'gram' && x.text === '青岚宗')
    ok('词组重复跨章聚合（第一章 5 次 + 无别章）', !!gram && gram.count >= 3 && gram.chapters === 1, JSON.stringify(gram?.count))
    const near = rep.groups.find(x => x.candidateOnly)
    ok('近似句单列为候选（相似度 ≥ 0.8）', !!near && (near.similarity ?? 0) >= 0.8, JSON.stringify(near?.similarity))
    ok('候选不计入 exactGroups', rep.candidateGroups >= 1 && rep.exactGroups === rep.groups.filter(x => !x.candidateOnly).length)
    ok('候选排在确定重复之后', rep.groups.length > 1 && !rep.groups[0].candidateOnly)
  }

  // ───────────────── ⑤ 忽略与撤销（本机） ─────────────────
  {
    const dup = '这是一句会被重复使用的很长的话。'
    const chapters = [
      ch('i1', 0, `${dup}${dup}`),
      ch('i2', 1, `前缀。${dup}`),
    ]
    const pid = PID
    const before = analyzeRepetition({ chapters, currentChapterId: 'i2', range: 1 })
    const g = before.groups.find(x => x.kind === 'sentence')
    ok('先检测到重复组', !!g)
    if (g) {
      const records = await ignoreRepetitionGroup(pid, g, '这是刻意复沓', memoryOps)
      ok('忽略记录落在本机 meta 前缀', isLocalOnlyMetaKey('auditIgnore::x'))
      ok('忽略后 activeIgnoreKeys 含该组', activeIgnoreKeys(records).includes(ignoreKeyOf(g)))
      const after = analyzeRepetition({ chapters, currentChapterId: 'i2', range: 1, ignoredIds: activeIgnoreKeys(records) })
      ok('忽略后该组不再展示并计入 ignoredGroups',
        !after.groups.some(x => x.id === g.id) && after.ignoredGroups >= 1)
      const left = await unignoreRepetitionGroup(pid, ignoreKeyOf(g), memoryOps)
      ok('撤销后记录清空', left.length === 0)
      const again = analyzeRepetition({ chapters, currentChapterId: 'i2', range: 1, ignoredIds: activeIgnoreKeys(left) })
      ok('撤销后重新出现', again.groups.some(x => x.id === g.id))
    }

    // 正文一变，组 id 就变（旧忽略不会误伤新文本）
    const changed = analyzeRepetition({
      chapters: [ch('i1', 0, `完全不同的一句话。${dup}`), ch('i2', 1, '别的。')],
      currentChapterId: 'i2', range: 1,
    })
    ok('正文变化后不再出现同一组 id', !changed.groups.some(x => g && x.id === g.id))
  }

  // ───────────────── ⑥ 缓存：只在本机、指纹不对就不用 ─────────────────
  {
    const chapters = [ch('k1', 0, '第一句足够长的话。'), ch('k2', 1, '第二句足够长的话。')]
    const report = analyzeRepetition({ chapters, currentChapterId: 'k2', range: 1 })
    await saveRepetitionCache(PID, report, memoryOps)
    const loaded = await loadRepetitionCache(PID, memoryOps)
    ok('缓存能读回且带指纹', !!loaded && loaded.inputFingerprint === report.inputFingerprint)
    ok('缓存只存摘要（组数有上限）', (loaded?.groups.length ?? 0) <= 200)
    ok('缓存键登记为本机专属', isLocalOnlyMetaKey('auditRepetition::x'))
    const stale = analyzeRepetition({ chapters: [ch('k1', 0, '改过的第一句。'), chapters[1]], currentChapterId: 'k2', range: 1 })
    ok('正文变化后缓存指纹对不上', stale.inputFingerprint !== loaded?.inputFingerprint)
    await clearRepetitionCache(PID, memoryOps)
    ok('清缓存后读回 null', (await loadRepetitionCache(PID, memoryOps)) === null)
  }

  console.log(`\nREPETITION ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })