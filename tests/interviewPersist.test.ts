// ============ 对话引导会话存档（3.1.3）============
//
// 这条链路上"错了也不报错"的地方比想象中多，所以逐条钉住：
//   ① 键生成 —— 空 scope 不能变成 `interview::`（那会让所有"不该存档"的试聊共用一个槽位）；
//   ② 三条丢弃规则 —— 已填回表单 / 空会话 / 过期，都要**连库一起清掉**，
//      否则孤儿键会一直躺着，还会被备份带走；
//   ③ 串行落盘 —— 手快连发两轮时，后写的不能被前写的覆盖掉（界面 3 轮、重开 2 轮）；
//   ④ 结构损坏 —— 旧版本 / 半截写入不能把界面卡死，一律当"没有存档"。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import {
  INTERVIEW_ARCHIVE_TTL_MS, archiveAgeLabel, clearInterviewArchive,
  interviewKeyOf, loadInterviewArchive, saveInterviewArchive,
  type InterviewArchive,
} from '../src/lib/creative/interviewStore'
import type { InterviewState } from '../src/lib/creative/interview'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
const pid = 'interview-persist-test'
db.setCurrentProject(pid)

const st = (turns: number, filled: Record<string, string> = {}): InterviewState => ({
  turns: Array.from({ length: turns }, (_, i) => (i % 2 === 0
    ? { role: 'ai' as const, text: `问题${i}` }
    : { role: 'user' as const, text: `回答${i}` })),
  filled,
  done: false,
})

const mkArchive = (s: InterviewState, extra: Partial<InterviewArchive> = {}): InterviewArchive => ({
  state: s,
  updatedAt: Date.now(),
  applied: false,
  subject: '主要角色',
  ...extra,
})

/** 直接读库（验证"清掉了"这件事，而不是只信 load 返回 null） */
async function rawOf(scope: string): Promise<unknown> {
  return db.getSetting<unknown>(interviewKeyOf(scope), null)
}

// ---------- ① 键生成 ----------
{
  ok('① 空 scope → 不存档（空串）', interviewKeyOf('') === '', JSON.stringify(interviewKeyOf('')))
  ok('① 纯空白 scope 同样不存档', interviewKeyOf('   ') === '')
  ok('① 正常 scope 加 interview:: 前缀', interviewKeyOf('outline::abc') === 'interview::outline::abc',
    interviewKeyOf('outline::abc'))
  ok('① 负向：不自己拼项目 id（那是 db 门面的事）', !interviewKeyOf('x').includes(pid))
}

// ---------- ② 序列化往返 ----------
{
  const scope = 'roundtrip'
  const s = st(3, { 姓名: '陈渊', 性格缺陷: '怕黑' })
  const saved = await saveInterviewArchive(scope, mkArchive(s))
  ok('② 保存返回 true', saved === true)
  const got = await loadInterviewArchive(scope)
  ok('② 读回来了', !!got)
  ok('② turns 逐字一致', JSON.stringify(got?.state.turns) === JSON.stringify(s.turns))
  ok('② filled 逐字一致', JSON.stringify(got?.state.filled) === JSON.stringify(s.filled))
  ok('② done 一致', got?.state.done === s.done)
  ok('② subject 一致', got?.subject === '主要角色')
}

// ---------- ③ 过期清理（7 天） ----------
{
  const scope = 'expired'
  const old = Date.now() - INTERVIEW_ARCHIVE_TTL_MS - 60_000
  await saveInterviewArchive(scope, mkArchive(st(2), { updatedAt: old }))
  ok('③ 过期前确实在库里', (await rawOf(scope)) !== null)
  const got = await loadInterviewArchive(scope)
  ok('③ 8 天前的存档不恢复', got === null)
  ok('③ 负向：过期的键被真删掉（不是只返回 null）', (await rawOf(scope)) === null)

  // 边界：刚好 6 天 23 小时仍要能恢复
  const freshScope = 'almost-expired'
  await saveInterviewArchive(freshScope, mkArchive(st(2), { updatedAt: Date.now() - INTERVIEW_ARCHIVE_TTL_MS + 3600_000 }))
  const fresh = await loadInterviewArchive(freshScope)
  ok('③ 临界内（6 天 23 小时）仍恢复', !!fresh)
}

// ---------- ④ applied 标记 ----------
{
  const scope = 'applied'
  await saveInterviewArchive(scope, mkArchive(st(4), { applied: true }))
  ok('④ 已填回表单的存档不恢复', (await loadInterviewArchive(scope)) === null)
  ok('④ 负向：同样要真删（否则下次还会被读出来再丢弃）', (await rawOf(scope)) === null)
}

// ---------- ⑤ 空会话 ----------
{
  const scope = 'empty'
  await saveInterviewArchive(scope, mkArchive(st(0)))
  ok('⑤ 空会话不提示（不恢复）', (await loadInterviewArchive(scope)) === null)
  ok('⑤ 负向：空会话的键也清掉', (await rawOf(scope)) === null)

  // 只有 AI 开场白、作者一个字没答 —— 同样不算会话（否则会提示"聊到第 0 轮"，很怪）
  const onlyAi = 'only-ai'
  await saveInterviewArchive(onlyAi, mkArchive({
    turns: [{ role: 'ai', text: '先聊聊你的主角？' }], filled: {}, done: false,
  }))
  ok('⑤ 只有 AI 开场、作者没回答 → 不恢复', (await loadInterviewArchive(onlyAi)) === null)
  ok('⑤ 负向：这条也清掉', (await rawOf(onlyAi)) === null)
}

// ---------- ⑥ 串行落盘 ----------
{
  const scope = 'serial'
  const first = mkArchive(st(2, { 标记: '第一次' }))
  const second = mkArchive(st(4, { 标记: '第二次' }))
  // 故意**不 await 第一次**，紧跟着写第二次 —— 模拟作者手快连发两轮
  const p1 = saveInterviewArchive(scope, first)
  const p2 = saveInterviewArchive(scope, second)
  await Promise.all([p1, p2])
  const got = await loadInterviewArchive(scope)
  ok('⑥ 两次连写后库里是第二次的内容', got?.state.filled?.['标记'] === '第二次', String(got?.state.filled?.['标记']))
  ok('⑥ 轮数也是第二次的（4 轮，不是 2 轮）', got?.state.turns.length === 4, String(got?.state.turns.length))
}

// ---------- ⑥b 作用域隔离（验收 7：两个弹窗互不串） ----------
{
  const a = 'scope::char-main'
  const b = 'scope::worldbase'
  await saveInterviewArchive(a, mkArchive(st(2, { 姓名: '甲的对话' }), { subject: '主要角色' }))
  await saveInterviewArchive(b, mkArchive(st(6, { 世界: '乙的对话' }), { subject: '世界设定' }))
  const ra = await loadInterviewArchive(a)
  const rb = await loadInterviewArchive(b)
  ok('⑥b 两个作用域各自独立', ra?.state.filled?.['姓名'] === '甲的对话' && rb?.state.filled?.['世界'] === '乙的对话')
  ok('⑥b 主语也各自独立', ra?.subject === '主要角色' && rb?.subject === '世界设定')
  ok('⑥b 轮数不串', ra?.state.turns.length === 2 && rb?.state.turns.length === 6)
  await clearInterviewArchive(a)
  ok('⑥b 清掉一个不影响另一个', (await loadInterviewArchive(a)) === null && (await loadInterviewArchive(b)) !== null)
}

// ---------- ⑦ 清理与幂等 ----------
{
  const scope = 'clear'
  await saveInterviewArchive(scope, mkArchive(st(2)))
  await clearInterviewArchive(scope)
  ok('⑦ 清理后读不到', (await loadInterviewArchive(scope)) === null)
  await clearInterviewArchive(scope) // 再删一次
  ok('⑦ 重复清理不炸（幂等）', true)

  // 清理要排在未完成的写入之后：先发写、立刻发清 → 最终应是"没有"
  const scope2 = 'clear-after-write'
  void saveInterviewArchive(scope2, mkArchive(st(3)))
  await clearInterviewArchive(scope2)
  ok('⑦ 先写后清 ⇒ 最终库里为空（写入不能把刚删的存档又写回来）', (await rawOf(scope2)) === null)
}

// ---------- ⑧ 损坏数据 ----------
{
  const scope = 'broken'
  await db.setSetting(interviewKeyOf(scope), { state: { turns: 'not-an-array' }, updatedAt: Date.now() })
  ok('⑧ 结构损坏 → 当没有存档', (await loadInterviewArchive(scope)) === null)
  ok('⑧ 负向：损坏的那条被清掉', (await rawOf(scope)) === null)

  const scope2 = 'broken-string'
  await db.setSetting(interviewKeyOf(scope2), '一个字符串')
  ok('⑧ 完全不是对象 → 当没有存档', (await loadInterviewArchive(scope2)) === null)
}

// ---------- ⑧b R03 回归：排队期间切项目，存档必须落在发起时的那本书上 ----------
//
// 病根复盘：save/del 排了队（好意），但队列里跑的是 `setSetting` —— 它拼的是**执行那一刻**
// 的当前项目。作者在第 A 本发起保存、还没落库就切到第 B 本 ⇒ 存档进了 B（验收实测
// writtenToA=false / writtenToB=true），B 的同名存档还被顶掉。清理路径同理会删错书。
{
  const pidA = 'r03-A'
  const pidB = 'r03-B'
  const scope = 'r03-scope'
  const rawFor = (p: string, s: string) => db.getSettingFor<unknown>(p, interviewKeyOf(s), null)

  // 两本书各自先有一份存档
  await saveInterviewArchive(scope, mkArchive(st(2), { subject: 'B 原本的对话' }), pidB)
  await saveInterviewArchive(scope, mkArchive(st(2), { subject: 'A 原本的对话' }), pidA)

  // 🔴 在 A 上发起保存，**不 await** 就切到 B —— 这正是验收复现的时序
  db.setCurrentProject(pidA)
  const pending = saveInterviewArchive(scope, mkArchive(st(3), { subject: 'A 新写的对话' }))
  db.setCurrentProject(pidB)
  await pending

  const inA = await loadInterviewArchive(scope, Date.now(), pidA)
  const inB = await loadInterviewArchive(scope, Date.now(), pidB)
  ok('⑧b 发起时的项目（A）存到了 A', inA?.subject === 'A 新写的对话', String(inA?.subject))
  ok('⑧b 目标项目（B）的存档没有被覆盖', inB?.subject === 'B 原本的对话', String(inB?.subject))
  ok('⑧b 库里 B 的键仍是原值', (await rawFor(pidB, scope)) !== null)

  // 清理路径：删 B 的时候"当前项目"是 A
  db.setCurrentProject(pidA)
  await clearInterviewArchive(scope, pidB)
  ok('⑧b 指定 pid 清理 ⇒ 删的是 B 那条', (await rawFor(pidB, scope)) === null)
  ok('⑧b 负向：A 那条没被误删', (await rawFor(pidA, scope)) !== null)

  // 两本书的队列互不阻塞：并发各写各的
  db.setCurrentProject(pidA)
  const pA = saveInterviewArchive(scope, mkArchive(st(5), { subject: 'A 并发' }), pidA)
  const pB = saveInterviewArchive(scope, mkArchive(st(7), { subject: 'B 并发' }), pidB)
  await Promise.all([pA, pB])
  ok('⑧b 两本项目各自排队、互不串写',
    (await loadInterviewArchive(scope, Date.now(), pidA))?.subject === 'A 并发'
    && (await loadInterviewArchive(scope, Date.now(), pidB))?.subject === 'B 并发')

  // 读到过期存档后的清理也必须落在"读的那本"上
  db.setCurrentProject(pidB)
  await saveInterviewArchive(scope, mkArchive(st(2), { updatedAt: Date.now() - INTERVIEW_ARCHIVE_TTL_MS - 1000 }), pidA)
  const expired = await loadInterviewArchive(scope, Date.now(), pidA)
  ok('⑧b 过期存档不恢复', expired === null)
  ok('⑧b 负向：过期清理删的是 A（读的那本），B 不受影响',
    (await rawFor(pidA, scope)) === null && (await rawFor(pidB, scope)) !== null)

  db.setCurrentProject(pid)
}

// ---------- ⑨ 时间文案 ----------
{
  const now = 1_700_000_000_000
  ok('⑨ 30 秒内 → 刚刚', archiveAgeLabel(now - 30_000, now) === '刚刚')
  ok('⑨ 5 分钟 → 5 分钟前', archiveAgeLabel(now - 5 * 60_000, now) === '5 分钟前')
  ok('⑨ 3 小时 → 3 小时前', archiveAgeLabel(now - 3 * 3600_000, now) === '3 小时前')
  ok('⑨ 2 天 → 2 天前', archiveAgeLabel(now - 2 * 86400_000, now) === '2 天前')
  ok('⑨ 负向：时钟回拨（未来时间）不显示负数', archiveAgeLabel(now + 60_000, now) === '刚刚')
}

// ---------- ⑩ 源码闸 ----------
{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/lib/creative/interviewStore.ts', 'utf8')
  ok('⑩ lib 层不 import 任何 component', !/from '@\/components\//.test(src))
  ok('⑩ 走 db 门面（不直接 import ./db/meta）', /from '@\/lib\/db'/.test(src) && !/db\/meta/.test(src))
  ok('⑩ 负向：没有自己拼存储键（pid 一律交给 db 的 For 系接口）',
    !/currentProjectId\}\$\{|\$\{currentProjectId\}/.test(src))
  // 3.1.3 · R03：读、写、删三处都必须带 pid —— 用 current 系就是"排队期间切项目会串写"
  ok('⑩ R03：三处读写删全走显式 pid 接口',
    /setSettingFor[<(]/.test(src) && /getSettingFor[<(]/.test(src) && /delSettingFor[<(]/.test(src))
  ok('⑩ 负向：不再出现不带 pid 的 setSetting/delSetting 调用',
    !/await setSetting\(/.test(src) && !/await delSetting\(/.test(src))
  ok('⑩ R03：队列键带项目（两本书各排各的队）', /`\$\{pid\}::\$\{scope\}`/.test(src))
}

console.log(`\n—— interviewPersist 用例结束：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exit(1)
