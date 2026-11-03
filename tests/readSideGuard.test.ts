// ============ 3.2.0 · 读侧守护用例 ============
//
// ⑧ 简报不改栏目名就丢资料：buildInlineBriefing 应包含未改名字段的数据
// ⑩ 模板没绑状态不得关闭酒馆聊天：runRoundEnd 应处理无模板绑定的会话

import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { buildInlineBriefing } from '@/lib/ai/aiContext'
import { runRoundEnd } from '@/lib/tavern/roundEnd'
import { saveFreeSession, saveFreeChar, createFreeSession } from '@/lib/tavern/store'
import { saveProviders, saveActiveId } from '@/lib/ai'
import { emptyFreeCharacter } from '@/lib/tavern/types'
import type { ChatFn } from '@/lib/tavern/provider'
import type { FreeSession, FreeCharacter, TavernMessage } from '@/lib/tavern/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-read-guard'
const STUB_PROVIDER = { id: 'stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }

// ───────────────── ⑧ 简报不改栏目名就丢资料 ─────────────────
async function caseBriefingNoRename() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  // 1. 建项目，不采用任何模板（用默认 schema 字段名）
  // 2. 写一条角色卡数据（用默认字段名「姓名」「身份定位」）
  const rec = {
    id: 'r1',
    projectId: PID,
    tabId: 'char-main',
    name: '林昭',
    data: {
      '角色档案::姓名': '林昭',
      '角色档案::定位': '主角',
    },
    order: 0,
  }
  await db.saveCardRecord(rec)

  // 3. 写一条术语表数据（用默认字段名「名称」「定义（一句话）」）
  const row = {
    id: 't1',
    projectId: PID,
    tabId: 'terms',
    name: '玄脉',
    data: {
      '名称': '玄脉',
      '定义（一句话）': '修行体系',
    },
    order: 0,
  }
  await db.saveTableRow(row)

  // 4. 调用 buildInlineBriefing，检查输出是否包含未改名字段的数据
  const ctx = await buildInlineBriefing({ focusChapterId: undefined })
  ok('⑧ 简报生成成功', ctx.length > 0, ctx)

  // 5. 验证：简报应包含「姓名：林昭」和「主角」（身份定位的值）
  //    注意：buildInlineBriefing 只带 char-main 和 terms 两个页签
  ok('⑧ 简报包含未改名字段「姓名：林昭」', ctx.includes('林昭'), ctx)
  ok('⑧ 简报包含未改名字段的值「主角」', ctx.includes('主角'), ctx)
  ok('⑧ 简报包含术语「玄脉」', ctx.includes('玄脉'), ctx)
  ok('⑧ 简报包含术语定义「修行体系」', ctx.includes('修行体系'), ctx)

  // 6. 验证：简报不应包含其他项目的残留数据
  ok('⑧ 简报不含其他项目残留', !ctx.includes('其他项目'), ctx)
}

// ───────────────── ⑩ 模板没绑状态不得关闭酒馆聊天 ─────────────────
async function caseRoundEndNoTemplate() {
  __resetMockStores()
  await db.setCurrentProject(PID)
  await saveProviders([{ ...STUB_PROVIDER }])
  await saveActiveId(STUB_PROVIDER.id)

  // 1. 建一个自由模式会话（用 store 工厂 —— 手写 FreeSession 字面量会漏掉 model/params 等必填项）
  const base = await createFreeSession(['c1'], '测试会话', { providerId: STUB_PROVIDER.id }, {})
  const session: FreeSession = {
    ...base,
    messages: [
      { id: 'm1', role: 'user', content: '你好', at: Date.now() },
      { id: 'm2', role: 'assistant', content: '你好！', at: Date.now() + 1, speakerId: 'c1' },
    ] satisfies TavernMessage[],
  }
  await saveFreeSession(session)

  // 2. 建一个在场角色卡（空白工厂 + 覆盖名字），不绑定任何模板
  const char: FreeCharacter = {
    ...emptyFreeCharacter(),
    id: 'c1',
    name: '测试角色',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await saveFreeChar(char)

  // 3. 造一个「假 AI 通道」，返回合法六栏档案文本
  const mockMemoryText = [
    '〖一、长期摘要〗',
    '测试角色在便利店与用户初次见面，气氛友好。',
    '',
    '〖二、关键事实〗',
    '- 与用户初次见面',
    '',
    '〖三、关系状态〗',
    '- 用户：初次见面，印象友好',
    '',
    '〖四、未爆的雷〗',
    '暂无',
    '',
    '〖五、纪念日与待办〗',
    '暂无',
    '',
    '〖六、最近日记〗',
    '- 10-20：与用户初次见面，在便利店聊了几句。',
  ].join('\n')

  // 🔴 ChatFn 是真实 `chat` 的签名（带 options/signal）。测试只关心"喂什么、回什么"，
  //    所以这里显式窄化成注入点期望的形状，而不是硬塞 `as never` 把类型检查关掉。
  const chatFn: ChatFn = (async (
    _cfg: unknown,
    msgs: { role: string; content: string }[],
  ) => {
    const sys = msgs[0]?.content ?? ''
    if (!sys.includes('六栏')) {
      throw new Error('提示词缺少六栏说明，模型可能输出格式错误')
    }
    return mockMemoryText
  }) as unknown as ChatFn

  // 4. 调用 runRoundEnd，验证不因无模板而崩溃
  const result = await runRoundEnd({
    session,
    cards: [char],
    varKeys: [],
    vars: session.vars,
    maxStep: 10,
    nameOf: (id) => (id === 'c1' ? '测试角色' : '角色'),
    chatFn,
  })

  ok('⑩ runRoundEnd 无模板绑定不崩溃', result !== null, JSON.stringify(result))
  ok('⑩ 返回结果包含 endedAt', typeof result.endedAt === 'number' && result.endedAt > 0, JSON.stringify(result.endedAt))
  ok('⑩ 返回结果包含 memories 数组', Array.isArray(result.memories), JSON.stringify(result.memories))
  ok('⑩ 返回结果包含 varChanges 数组', Array.isArray(result.varChanges), JSON.stringify(result.varChanges))
  ok('⑩ 返回结果包含 proposals 数组', Array.isArray(result.proposals), JSON.stringify(result.proposals))
  ok('⑩ 返回结果包含 warnings 数组', Array.isArray(result.warnings), JSON.stringify(result.warnings))
  ok('⑩ memoryDegraded 为布尔值', typeof result.memoryDegraded === 'boolean', JSON.stringify(result.memoryDegraded))

  // 6. 验证：记忆已正确写入
  const mem = result.memories[0]
  ok('⑩ 记忆包含长期摘要', mem?.longTerm?.includes('初次见面'), JSON.stringify(mem?.longTerm))
  ok('⑩ 记忆包含关系状态', mem?.relation?.includes('友好'), JSON.stringify(mem?.relation))
}

async function main() {
  await caseBriefingNoRename()
  await caseRoundEndNoTemplate()
  console.log(`\nreadSideGuard: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
