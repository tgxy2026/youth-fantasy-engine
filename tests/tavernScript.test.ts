// ============ 酒馆模式 · 剧本（自由对话专用：六栏 / 全局库 / 快照）============
//
// 这一层的风险有两处，测试就盯这两处：
//  ① **快照语义** —— 会话存的是副本而不是引用。剧本改了、删了，这一场都不能变样
//     （否则「上周那场戏的设定今天自己变了」根本查不出来）。
//  ② **注入边界** —— 「情境 / 你的位置 / 目标 / 不要发生」进 system；**名称与开场白不进**
//     （名称是给人看的，开场白走消息通道）。弄反了要么白占额度，要么模型以为用户已经说过那句。
import {
  listScripts, getScript, saveScript, createScript, deleteScript,
  snapshotOf, scriptToText, openingToMessage, scriptSceneLine, scriptDisplayName,
  isEmptySnapshot, isEmptyScriptFields, mergeScriptDraft, firstLine,
  parseScriptDraft, draftScript, emptyScript, EMPTY_SCRIPT_FIELDS,
  SCRIPT_MAX_CHARS,
} from '../src/lib/tavern/script'
import { buildFreeSystem } from '../src/lib/tavern/engine'
import * as store from '../src/lib/tavern/store'
import { saveProviders, saveActiveId } from '../src/lib/ai'
import { getTavernSettings } from '../src/lib/tavern/settings'
import type { ChatFn } from '../src/lib/tavern/engine'
import type { FreeCharacter, TavernScript } from '../src/lib/tavern/types'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const STUB_PROVIDER = { id: 'script-stub', name: '桩模型', type: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }

function makeFakeChat(reply: string): { chatFn: ChatFn } {
  const chatFn = (async (_p: unknown, _m: unknown) => reply) as unknown as ChatFn
  return { chatFn }
}

async function mkChar(name: string): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name,
    world: '现代都市 · 老城区一间凌晨还亮着灯的便利店',
    profile: {
      externals: '短发，围裙', core: '外冷内热', speech: '话少',
      relations: '独居', cannot: '不会说软话', knowledge: '不知道你的过去',
    },
    conduct: { perspective: '第一人称', bottomLine: '', paceLock: '', rating: '' },
    examples: '',
  })
}

function full(): Omit<TavernScript, 'id' | 'createdAt' | 'updatedAt' | 'draftedAt'> {
  return {
    name: '雨夜便利店',
    situation: '凌晨两点的便利店，外面在下雨。她刚把烟柜锁上。',
    opening: '【雨点砸在卷帘门上】\n（她把钥匙转了一圈）今天不卖了。',
    playerRole: '每天这个点来买烟的人，和她认识半年。',
    goal: '让她说出那件一直不肯说的事。',
    taboo: '不要提分手；不要让她离开便利店。',
  }
}

/** 六栏 → 完整 TavernScript（snapshotOf 需要 id 与时间戳，测试里不该到处手写） */
function sc(over: Partial<TavernScript> = {}): TavernScript {
  return { ...emptyScript(), ...full(), ...over }
}

async function main() {
  // ---------- 1) 渲染：谁进 system、谁不进 ----------
  {
    const snap = snapshotOf(sc({ id: 's1' }))
    const text = scriptToText(snap)
    ok('注入文本含情境', text.includes('情境：凌晨两点的便利店'))
    ok('注入文本含「你的位置」', text.includes('你在这一场里的位置'))
    ok('注入文本含目标', text.includes('这一场的目标：'))
    ok('注入文本含禁区', text.includes('不要发生：'))
    ok('🔴 名称不进注入文本（它是给人看的）', !text.includes('雨夜便利店'))
    ok('🔴 开场白不进注入文本（走消息通道）', !text.includes('卷帘门'))
    ok('四栏顺序固定（情境→位置→目标→禁区）',
      text.indexOf('情境：') < text.indexOf('你在这一场里的位置')
      && text.indexOf('你在这一场里的位置') < text.indexOf('这一场的目标：')
      && text.indexOf('这一场的目标：') < text.indexOf('不要发生：'), text)

    ok('开场白单独取出（原文不动）', openingToMessage(snap) === full().opening)
    ok('没写开场白 → 空串（不产出第一条消息）', openingToMessage(snapshotOf(sc({ opening: '' }))) === '')
    ok('空快照 → 空串（整层不出现）', scriptToText(null) === '' && scriptToText(snapshotOf(emptyScript())) === '')
    ok('isEmptySnapshot 认空/认有', isEmptySnapshot(snapshotOf(emptyScript())) && !isEmptySnapshot(snap))
    ok('isEmptyScriptFields 认空/认有',
      isEmptyScriptFields(EMPTY_SCRIPT_FIELDS) && !isEmptyScriptFields(full() as unknown as typeof EMPTY_SCRIPT_FIELDS))

    // 超上限截断（绝不能不声不响地吞）
    const huge = snapshotOf(sc({ situation: '场'.repeat(SCRIPT_MAX_CHARS + 500) }))
    const cut = scriptToText(huge)
    ok('超上限会截断并注明（不静默）',
      cut.length < SCRIPT_MAX_CHARS + 200 && cut.includes('已截断'), String(cut.length))

    ok('statusLine 用名字 + 情境首句', scriptSceneLine(snap).startsWith('雨夜便利店 · 凌晨两点的便利店'))
    ok('空快照的场景行是空串（状态栏好回落）', scriptSceneLine(snapshotOf(emptyScript())) === '')
    ok('缺名字给占位', scriptDisplayName(emptyScript()) === '（未命名剧本）')
    ok('firstLine 取首句并截断',
      firstLine('她说了一句话。后面还有。') === '她说了一句话'
      && firstLine('很长'.repeat(40), 10).endsWith('…'))
  }

  // ---------- 2) 合并 AI 草稿：空的不覆盖 ----------
  {
    const cur = { ...EMPTY_SCRIPT_FIELDS, name: '我自己起的名字', goal: '我自己写的目标' }
    const out = { ...EMPTY_SCRIPT_FIELDS, name: '', situation: 'AI 写的情境', goal: 'AI 写的目标', taboo: '' }
    const merged = mergeScriptDraft(cur, out)
    ok('AI 空着的栏保留作者原文（名字）', merged.name === '我自己起的名字', merged.name)
    ok('AI 写了的栏覆盖（情境）', merged.situation === 'AI 写的情境')
    ok('AI 写了目标就覆盖作者的', merged.goal === 'AI 写的目标', merged.goal)
    ok('AI 空着的禁区保持空', merged.taboo === '')
  }

  // ---------- 3) 解析 AI 起草结果 ----------
  {
    const good = parseScriptDraft('{"name":"雨夜","situation":"便利店","opening":"今天不卖了。","playerRole":"常客","goal":"问清楚","taboo":"别离开"}')
    ok('标准 JSON 能解出六栏', !!good && good.name === '雨夜' && good.taboo === '别离开')
    const fenced = parseScriptDraft('```json\n{"situation":"有围栏也认"}\n```')
    ok('带代码围栏也认（模型常这么干）', !!fenced && fenced.situation === '有围栏也认')
    const wrapped = parseScriptDraft('好的，这是剧本：\n{"situation":"裹了解释也认"}\n希望有用！')
    ok('裹了解释文字也认', !!wrapped && wrapped.situation === '裹了解释也认')
    ok('🔴 六栏全空 → null（不猜）', parseScriptDraft('{}') === null)
    ok('非 JSON → null', parseScriptDraft('我觉得这个剧本应该……') === null)
    ok('解析结果里的 name 截到 30 字', (parseScriptDraft(JSON.stringify({ name: '名'.repeat(50), goal: 'g' }))?.name ?? '').length === 30)
  }

  // ---------- 4) 起草：桩模型走通 / 空输入与乱答要抛错 ----------
  {
    __resetMockStores()
    await saveProviders([{ ...STUB_PROVIDER }])
    await saveActiveId(STUB_PROVIDER.id)

    const out = await draftScript({ seed: '雨夜便利店，她锁了烟柜', chatFn: makeFakeChat(JSON.stringify(full())).chatFn })
    ok('起草走通并解出六栏', out.name === '雨夜便利店' && out.goal.includes('说出'))

    let threw = false
    try { await draftScript({ seed: '   ', chatFn: makeFakeChat('{}').chatFn }) } catch { threw = true }
    ok('没写想法就直接抛错（不浪费一次调用）', threw)

    threw = false
    try { await draftScript({ seed: '随便', chatFn: makeFakeChat('我不会。').chatFn }) } catch { threw = true }
    ok('模型乱答 → 抛错（调用方保留作者原文）', threw)
  }

  // ---------- 5) 全局库 CRUD 与索引 ----------
  {
    __resetMockStores()
    ok('空库列出空数组', (await listScripts()).length === 0)

    const a = await createScript(full())
    const b = await createScript({ ...EMPTY_SCRIPT_FIELDS, name: '第二场', goal: '第二场的目标' })
    const list = await listScripts()
    ok('新建后列表有两条', list.length === 2, String(list.length))
    ok('索引项带 goalBrief（列表展示用）', list.some(x => x.goalBrief.includes('说出')))
    ok('索引项不塞全文（避免列表把全部剧本读进内存）',
      !Object.prototype.hasOwnProperty.call(list[0], 'situation'))

    const back = await getScript(a.id)
    ok('按 id 读回六栏', back?.situation === full().situation && back?.taboo === full().taboo)

    const renamed = await saveScript({ ...back!, name: '改了名', goal: '换了目标' })
    ok('保存会更新 updatedAt', renamed.updatedAt >= back!.updatedAt)
    const list2 = await listScripts()
    const row = list2.find(x => x.id === a.id)
    ok('索引跟着更新（名称与目标）',
      row?.name === '改了名' && (row?.goalBrief.includes('换了目标') ?? false))

    await deleteScript(b.id)
    const list3 = await listScripts()
    ok('删除后从索引消失', list3.length === 1 && !list3.some(x => x.id === b.id))
    ok('删除后读不到', (await getScript(b.id)) === null)
  }

  // ---------- 6) 引擎集成：快照进 system，开场白不进 ----------
  {
    __resetMockStores()
    const su = await mkChar('苏念')
    const st = await getTavernSettings()
    const s0 = await store.createFreeSession([su.id], '剧本集成测试', { providerId: '' }, {})
    const snap = snapshotOf(sc({ id: 'sc-1' }))
    const saved = await store.saveFreeSession({ ...s0, scriptId: 'sc-1', script: snap })
    const chars = [(await store.getFreeChar(su.id)) as FreeCharacter]

    const r = await buildFreeSystem(saved, chars, st)
    ok('🔴 system 里有「这一场」层', r.system.includes('〖这一场〗'), r.system.slice(0, 120))
    ok('目标写进了 system', r.system.includes('这一场的目标：让她说出那件一直不肯说的事'))
    ok('禁区写进了 system', r.system.includes('不要发生：不要提分手'))
    ok('scriptChars 与渲染长度一致', r.scriptChars === scriptToText(snap).length, `${r.scriptChars} vs ${scriptToText(snap).length}`)

    // 没有剧本的会话：整层不出现，且字符数为 0（「不填就不占额度」）
    // ⚠️ 必须**另建一个会话**：上面那份已经带上快照了，直接复用等于自己骗自己（第一次就这么写错了）
    const bare0 = await store.createFreeSession([su.id], '不带剧本', { providerId: '' }, {})
    const bare = await store.getFreeSession(bare0.id)
    const r2 = await buildFreeSystem(bare!, chars, st)
    ok('🔴 没设剧本时 system 里没有「这一场」层', !r2.system.includes('〖这一场〗'))
    ok('没设剧本时 scriptChars = 0', r2.scriptChars === 0)
    ok('设了剧本确实多出一层（长度正相关）', r.system.length > r2.system.length)

    // 快照语义：改剧本不影响已存会话
    const changed = await saveScript({ ...snap, scriptId: undefined as unknown as string, id: 'sc-1', createdAt: 1, updatedAt: 3, draftedAt: 0, goal: '全新目标' } as unknown as TavernScript)
    void changed
    const again = await buildFreeSystem((await store.getFreeSession(s0.id))!, chars, st)
    ok('🔴 剧本被改后，已存会话的 system 仍是旧快照', again.system.includes('让她说出那件一直不肯说的事'))
  }

  console.log('')
  console.log(`共 ${pass + fail} 条：PASS ${pass} · FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
