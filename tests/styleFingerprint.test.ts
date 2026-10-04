// ============ 文风指纹（2.8.0 · 台账 #015）============
//
// 本用例盯五件事（对齐方案 §3.8）：
//   ① `analyzeStyleMetrics` **确定性**（同一文本跑两遍逐字一致 —— 它是"本地统计打底"的那一半）；
//   ② `buildFingerprintNote`：空档返回 ''（整层不注入）、有档含档名与关键段；
//   ③ 空文本 / 过短文本：不崩、不产半成品档（抛带中文原因的错）；
//   ④ 🔴 **立场红线**：提示词里不得出现「过检测 / 降 AI 率 / 规避检测」这类反检测话术；
//   ⑤ 三处注入点顺序（源码断言）：文风档插在去 AI 味纪律**之前**，deAi 必须仍是最后一项。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../src/lib/db'
import {
  analyzeStyleMetrics, extractFingerprint, buildFingerprintNote,
  loadFingerprints, saveFingerprints, loadActiveFingerprint,
  loadActiveFingerprintId, saveActiveFingerprintId, upsertFingerprint,
  removeFingerprint, activeFingerprintNote, invalidateFingerprintCache,
  countPunctuation, countFourCharRuns, countDialogueWords,
  MIN_SAMPLE_WORDS, STYLE_FINGERPRINT_PROMPTS, type StyleProfile,
} from '../src/lib/styleFingerprint'
import type { AIProvider } from '../src/lib/ai'
import { __resetMockStores } from './mock-memory'

type ChatLike = typeof import('../src/lib/ai').chat

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function read(rel: string): string {
  try { return readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

const SAMPLE_A = '他没有回头。风从巷口灌进来，吹得灯笼乱晃。'
  + '她攥紧了袖口，指节发白。“你走吧。”她说，声音很轻，像是怕吵醒什么。'
  + '他停了一下，还是走了。巷子里的脚步声一点点远去，最后只剩下风。'
  + '她站在原地，很久没有动。莫名其妙的，眼睛就酸了。'
  + '“其实……我早就知道了。”她低声说，声音里有种说不出的疲惫。'
  + '灯灭了。整条巷子沉进黑里，只有远处一声更夫的梆子，空落落地响。'
  + '她终于蹲了下来，把脸埋进膝盖。眼泪掉在青石板上，砸出一小片深色。'
  + '第二天清早，卖豆浆的老汉推车经过，看见她还在那儿坐着，一动不动。'
  + '“姑娘？”老汉喊了一声。她抬起头，眼睛红得吓人，却笑了笑：“没事。”'
  + '然后她站起来，拍掉身上的灰，往巷子另一头走去。那里有一扇门，虚掩着。'
  + '她推门进去，门轴发出一声长长的呻吟，像是等了很久终于有人来了。'

const SAMPLE_B = '他说：今天赢了。她问：怎么赢的？他说：靠运气。'
  + '她笑了，说：运气也是本事。他挠挠头，说：那我这本事，一年用不上一次。'
  + '她说：那就攒着。他说：攒着也不能下崽。她说：能换一顿饭。'
  + '两人都笑了。窗外下雨，雨点砸在铁皮雨棚上，噼里啪啦。'
  + '他说：明天还去吗？她说：去。他说：那可可先睡了。她说：睡吧。'
  + '灯关了。雨还在下，铁皮雨棚响了一整夜，像谁在楼上不停地倒豆子。'

async function seedModel() {
  const p: AIProvider = {
    id: 'a', name: 'a', type: 'ollama', baseUrl: 'http://localhost:11434',
    apiKey: '', model: 'm', local: true, contextWindow: 32768,
  }
  await db.setMeta('aiProviders', [p])
  await db.setMeta('aiActiveProviderId', 'a')
  await db.setMeta('aiConfigMigratedToGlobal', true)
}

/** 假 chat：返回一段合法 JSON（用于提炼成功路径） */
const fakeChat = (async () => JSON.stringify({
  summary: '短句为主，对白密集，情绪藏在动作里，很少直说什么感受。',
  traits: ['短句为主', '对白密集', '少形容词'],
  dos: ['保持短句节奏', '用动作写情绪'],
  donts: ['别写长段抒情', '别堆形容词'],
})) as unknown as ChatLike

const mk = (v: Partial<StyleProfile>): StyleProfile => ({
  id: 'p1', name: '甲档', createdAt: 1, source: 'analyzed', sampleChars: 200,
  metrics: {
    sentenceCount: 10, avgSentenceLen: 12, sentenceLenSpread: 0.5,
    dialogueRatio: 0.4, punctuationDensity: 30, idiomDensity: 5, repeatedWords: [],
  },
  aiSummary: '短句、对话多', traits: ['短句'], dos: ['保持节奏'], donts: ['别抒情'],
  ...v,
})

async function main() {
  // ---------- ① 本地统计：确定性 ----------
  __resetMockStores()
  {
    const a1 = await analyzeStyleMetrics([SAMPLE_A])
    const a2 = await analyzeStyleMetrics([SAMPLE_A])
    ok('同一文本跑两遍结果逐字段一致（确定性）', JSON.stringify(a1) === JSON.stringify(a2))
    ok('句数 > 0', a1.sentenceCount > 0, String(a1.sentenceCount))
    ok('平均句长 > 0', a1.avgSentenceLen > 0, String(a1.avgSentenceLen))
    ok('对话占比落在 0~1', a1.dialogueRatio >= 0 && a1.dialogueRatio <= 1, String(a1.dialogueRatio))
    ok('标点密度 > 0', a1.punctuationDensity > 0, String(a1.punctuationDensity))
    ok('多段文本合并统计（B 段含大量对白 ⇒ 占比明显更高）',
      (await analyzeStyleMetrics([SAMPLE_B])).dialogueRatio > a1.dialogueRatio)
  }

  // ---------- ①b 三个本地计数器的边界 ----------
  {
    ok('空串标点数 = 0', countPunctuation('') === 0)
    ok('空串四字格 = 0', countFourCharRuns('') === 0)
    ok('空串对话字数 = 0', countDialogueWords('') === 0)
    ok('孤立四字格计 1', countFourCharRuns('莫名其妙。') === 1)
    ok('嵌在长串里的四字格不计（近似口径，如实）', countFourCharRuns('他说莫名其妙地笑了') === 0)
    const empty = await analyzeStyleMetrics([])
    ok('空输入 ⇒ 全 0 且不崩', empty.sentenceCount === 0 && empty.dialogueRatio === 0 && empty.repeatedWords.length === 0)
    // 🔴 对白两种写法都要算（2026-10-04 实测踩坑：只认引号时，冒号式文本的「对话占比」恒为 0）
    ok('冒号式对白也被计入', countDialogueWords('他说：今天赢了。') === 4, String(countDialogueWords('他说：今天赢了。')))
    ok('引号式与冒号式不重复计（同一句只算一次）',
      countDialogueWords('他说：“今天赢了。”') === countDialogueWords('“今天赢了。”'))
  }

  // ---------- ② buildFingerprintNote ----------
  {
    ok('🔴 空档返回空串（整层不注入）', buildFingerprintNote(null) === '')
    const note = buildFingerprintNote(mk({}))
    ok('含档名', note.includes('甲档'))
    ok('含「用词倾向」', note.includes('用词倾向'))
    ok('含「宜」', note.includes('宜'))
    ok('含「忌」', note.includes('忌'))
    ok('含量化特征', note.includes('量化特征'))
    const withNote = buildFingerprintNote(mk({ note: '对白要短' }))
    ok('作者补充出现在末段（优先级最高）', withNote.trim().endsWith('对白要短'))
  }

  // ---------- ③ 过短 / 空文本不产档 ----------
  {
    __resetMockStores()
    await seedModel()
    let threw = ''
    try { await extractFingerprint([], { chatFn: fakeChat }) } catch (e) { threw = String((e as Error).message) }
    ok('空文本抛带中文原因的错', threw.includes('太短'), threw)
    let threw2 = ''
    try { await extractFingerprint(['太短了'], { chatFn: fakeChat }) } catch (e) { threw2 = String((e as Error).message) }
    ok('过短文本同样拒绝', threw2.includes('太短'), threw2)
    ok('阈值常量被写进错误提示', threw.includes(String(MIN_SAMPLE_WORDS)), threw)
  }

  // ---------- ④ 提炼成功路径（注入假 chat） ----------
  {
    __resetMockStores()
    await seedModel()
    const fp = await extractFingerprint([SAMPLE_A], { name: '冷硬白描', chatFn: fakeChat })
    ok('档名取自入参', fp.name === '冷硬白描')
    ok('来源标为 analyzed', fp.source === 'analyzed')
    ok('样本字符数 > 0', fp.sampleChars > 0, String(fp.sampleChars))
    ok('量化特征已填', fp.metrics.sentenceCount > 0)
    ok('AI 归纳已填', fp.aiSummary.length > 0)
    ok('traits / dos / donts 都有内容', fp.traits.length > 0 && fp.dos.length > 0 && fp.donts.length > 0)
    ok('id 非空', !!fp.id)
    ok('落盘后可被 buildFingerprintNote 用', buildFingerprintNote(fp).includes('冷硬白描'))
  }

  // ---------- ⑤ 🔴 立场红线：不许出现反检测话术 ----------
  {
    const text = STYLE_FINGERPRINT_PROMPTS[0].read()
    for (const bad of ['过检测', '降 AI 率', '降低AI率', '绕过检测', '逃过检测', '洗掉 AI 痕迹', '规避检测', '检测率']) {
      ok(`提示词不含「${bad}」`, !text.includes(bad))
    }
    ok('提示词明确「只学风格、不得照搬原文句子」', text.includes('不得照搬原文句子'))
    ok('提示词要求返回 JSON', text.includes('JSON'))
    ok('提示词登记 id 为 style-fingerprint', STYLE_FINGERPRINT_PROMPTS[0].meta.id === 'style-fingerprint')
  }

  // ---------- ⑥ 存储与启用（全局 meta + 内存缓存） ----------
  {
    __resetMockStores()
    invalidateFingerprintCache()
    ok('空库 ⇒ 空列表', (await loadFingerprints()).length === 0)
    ok('空库 ⇒ 未启用', (await loadActiveFingerprintId()) === '')
    ok('空库 ⇒ 当前档 null', (await loadActiveFingerprint()) === null)
    ok('空库 ⇒ 注入文本为空串', (await activeFingerprintNote()) === '')

    await saveFingerprints([mk({}), mk({ id: 'p2', name: '乙档' })])
    ok('写入后读回 2 份', (await loadFingerprints()).length === 2)

    await saveActiveFingerprintId('p2')
    invalidateFingerprintCache()
    const act = await loadActiveFingerprint()
    ok('启用后取到的是那一份', act?.id === 'p2', String(act?.id))
    ok('注入文本含被启用档的档名', (await activeFingerprintNote()).includes('乙档'))

    // 脏数据归一：缺字段的档不该让整表塌掉
    await saveFingerprints([{ id: 'bad' } as unknown as StyleProfile, mk({ id: 'p3' })])
    const ls = await loadFingerprints()
    ok('脏档被归一后仍可用', ls.length === 2 && ls.some(x => x.id === 'bad' && x.name === '（未命名文风档）'))

    // 指向不存在的档 ⇒ 视为未启用（不抛）
    await saveActiveFingerprintId('p9')
    invalidateFingerprintCache()
    ok('启用了一个不存在的 id ⇒ 当前档 null', (await loadActiveFingerprint()) === null)

    // 删除当前启用档 ⇒ 自动停用
    await saveActiveFingerprintId('p3')
    await removeFingerprint('p3')
    ok('删掉当前启用档后自动停用', (await loadActiveFingerprintId()) === '')
  }

  // ---------- ⑥b upsert 覆盖而非追加 ----------
  {
    __resetMockStores()
    await upsertFingerprint(mk({ id: 'u1', name: '旧名' }))
    await upsertFingerprint(mk({ id: 'u1', name: '新名' }))
    const ls = await loadFingerprints()
    ok('同 id upsert 是覆盖', ls.length === 1 && ls[0].name === '新名', JSON.stringify(ls.map(x => x.name)))
  }

  // ---------- ⑦ 三处注入点（源码断言） ----------
  {
    const rw = read('src/lib/aiTasks/rewrite.ts')
    const rwLine = rw.split('\n').find(l => l.includes('CHAPTER_REWRITE_BASE, CHAPTER_REWRITE_ACTION_RULES')) ?? ''
    ok('整章改写调用了 activeFingerprintNote()', rw.includes('await activeFingerprintNote()'))
    ok('整章改写：文风档插在去味规则之前',
      rwLine.indexOf('fpNote') > 0 && rwLine.indexOf("deAiGenerateRule('full')") > rwLine.indexOf('fpNote'), rwLine.trim().slice(0, 200))
    ok('整章改写：空档时数组里不塞空串', rwLine.includes("...(fpNote ? [fpNote] : [])"))

    const ac = read('src/lib/autoContinue.ts')
    const bs = ac.slice(ac.indexOf('function buildSysPrompt'), ac.indexOf('// ============ 去 AI 味儿'))
    const deAt = bs.indexOf("deAiGenerateRule('full')")
    const fpAt = bs.indexOf("...(fpNote ? ['', fpNote] : []),")
    ok('续写：buildSysPrompt 收了 fpNote 形参', ac.includes('function buildSysPrompt(target: number, chapterNo?: number, fpNote?: string)'))
    ok('续写：文风档插在去味规则之前', fpAt > 0 && deAt > fpAt, `${fpAt} / ${deAt}`)
    const lastItem = bs.slice(deAt, bs.indexOf('].join', deAt))
    ok('续写：去味规则仍是最后一项（中间没有别的条目）', lastItem.trim() === "deAiGenerateRule('full'),", JSON.stringify(lastItem.trim()))
    ok('续写：三处调用点都传了文风档', (ac.match(/await activeFingerprintNote\(\)/g) ?? []).length === 3,
      String((ac.match(/await activeFingerprintNote\(\)/g) ?? []).length))

    const il = read('src/lib/aiTasks/inline.ts')
    const ilFp = il.indexOf('if (fpNote) layers.push(fpNote)')
    const ilDe = il.indexOf('layers.push(DEAI_INLINE_RULE)')
    ok('伴写：无档不 push（`if (fpNote)`）', ilFp > 0)
    ok('伴写：文风档在去味规则之前 push', ilFp > 0 && ilDe > ilFp, `${ilFp} / ${ilDe}`)
  }

  // ---------- ⑧ 四处注册接到位 ----------
  {
    const tasks = read('src/lib/aiTasks.ts')
    ok('门面 import 了 STYLE_FINGERPRINT_PROMPTS', tasks.includes("from './styleFingerprint'"))
    ok("PROMPT_ORDER 里登记了 'style-fingerprint'", tasks.includes("'style-fingerprint',"))
    ok('PROMPT_SETS 里挂上了', tasks.includes('STYLE_FINGERPRINT_PROMPTS,'))
    ok('数据源表里登记了 style-fingerprint', read('src/lib/aiDataSources.ts').includes("'style-fingerprint':"))
    ok('界面挂了 AIDataSourceNote（否则「表里没人引用的条目」会被闸门拦下）',
      read('src/components/StyleProfileDialog.tsx').includes('<AIDataSourceNote feature="style-fingerprint" />'))
  }

  console.log(`\nstyleFingerprint: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

void main()
