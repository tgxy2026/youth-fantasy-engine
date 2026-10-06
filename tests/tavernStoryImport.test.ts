/**
 * 酒馆「故事 / 词条 / 剧本」文本导入导出 · 单测
 *
 * 覆盖：正常解析（多词条多剧本）、标记缺失/重复、各种分隔符、概率与状态收口、
 * 裸行归属、上限告警、CRLF/BOM 归一化、**导出→导入往返**、模板自身可解析。
 */
import {
  parseStoryImport, serializeStoryImport, IMPORT_TEMPLATE, MARK, SCRIPT_KEYS,
  type ParsedStoryImport,
} from '../src/lib/tavern/storyImport'
import { STORY_NAME_MAX, STORY_SETTING_MAX } from '../src/lib/tavern/story'
import { SCRIPT_FIELD_MAX } from '../src/lib/tavern/script'
import { emptyWorldEntry } from '../src/lib/tavern/worldBook'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 断言解析成功并取回 data（失败时抛，便于测试里直接读字段） */
function mustParse(text: string): ParsedStoryImport {
  const r = parseStoryImport(text)
  if (!r.ok) throw new Error('预期解析成功，实际失败：' + r.issues.map(i => i.message).join(' / '))
  return r.data
}

const SAMPLE = `${MARK.story}约会大作战

${MARK.setting}
时代：现代。
规则：存在精灵与灵力。

${MARK.entry}精灵
触发：精灵、灵力
正文：从邻界来的存在。

${MARK.entry}AST
触发：AST,来禅高中
概率：0.5
正文：对抗精灵的组织。

${MARK.script}第一次相遇
情境：放学后的教室。
开场白：你怎么还在这儿？
你的位置：同班同学
这一场的目标：搭上话
不要发生：打起来`

function main() {
  // ---------- 1) 基本解析 ----------
  {
    const d = mustParse(SAMPLE)
    ok('1a 故事名解析正确', d.storyName === '约会大作战', d.storyName)
    ok('1b 世界设定多行原样保留', d.setting.includes('时代：现代。') && d.setting.includes('规则：存在精灵与灵力。'))
    ok('1c 词条数量 = 2', d.entries.length === 2, String(d.entries.length))
    ok('1d 词条名正确', d.entries[0].title === '精灵' && d.entries[1].title === 'AST')
    ok('1e 触发词按顿号拆开', d.entries[0].keys.join('|') === '精灵|灵力', d.entries[0].keys.join('|'))
    ok('1f 触发词也认英文逗号', d.entries[1].keys.join('|') === 'AST|来禅高中', d.entries[1].keys.join('|'))
    ok('1g 概率解析', d.entries[1].prob === 0.5, String(d.entries[1].prob))
    ok('1h 词条正文正确', d.entries[1].body === '对抗精灵的组织。', d.entries[1].body)
    ok('1i 剧本数量 = 1', d.scripts.length === 1, String(d.scripts.length))
    ok('1j 剧本六栏正确',
      d.scripts[0].name === '第一次相遇' && d.scripts[0].situation === '放学后的教室。'
      && d.scripts[0].opening === '你怎么还在这儿？' && d.scripts[0].playerRole === '同班同学'
      && d.scripts[0].goal === '搭上话' && d.scripts[0].taboo === '打起来')
    ok('1k 干净样例无告警', parseStoryImport(SAMPLE).ok && (parseStoryImport(SAMPLE) as { issues: unknown[] }).issues.length === 0)
  }

  // ---------- 2) 批量：多词条 + 多剧本 ----------
  {
    const t = `${MARK.story}测试\n\n${MARK.entry}A\n正文：a\n\n${MARK.entry}B\n正文：b\n\n${MARK.entry}C\n正文：c\n\n${MARK.script}S1\n情境：s1\n\n${MARK.script}S2\n情境：s2\n\n${MARK.script}S3\n情境：s3`
    const d = mustParse(t)
    ok('2a 三条词条都进来', d.entries.length === 3, String(d.entries.length))
    ok('2b 三份剧本都进来', d.scripts.length === 3, String(d.scripts.length))
    ok('2c 顺序保持书写顺序', d.entries.map(e => e.title).join('') === 'ABC' && d.scripts.map(s => s.name).join('') === 'S1S2S3')
  }

  // ---------- 3) 缺 〖故事〗 / 多个 〖故事〗 ----------
  {
    const r1 = parseStoryImport(`${MARK.setting}\n内容`)
    ok('3a 缺故事名 ⇒ error（要求按模板来）', !r1.ok && r1.issues.some(i => i.level === 'error'))
    const r2 = parseStoryImport(`${MARK.story}甲\n\n${MARK.setting}\nA\n\n${MARK.story}乙\n\n${MARK.setting}\nB`)
    ok('3b 出现两个故事 ⇒ error', !r2.ok, JSON.stringify(r2.issues.map(i => i.level)))
    ok('3c 报错文案点明「一次只能导一个」',
      !r2.ok && r2.issues.some(i => i.message.includes('一次只能导入一个故事')),
      !r2.ok ? r2.issues.map(i => i.message).join('|') : '')
  }

  // ---------- 4) 空内容 ----------
  {
    const r = parseStoryImport(`${MARK.story}只有名字`)
    ok('4a 只有故事名、没内容 ⇒ error', !r.ok)
  }

  // ---------- 5) 空模板 / 空块的处理 ----------
  {
    const rTpl = parseStoryImport(IMPORT_TEMPLATE)
    ok('5a 空模板 ⇒ 明确报「什么都没读到」（提示作者要填内容）',
      !rTpl.ok && rTpl.issues.some(i => i.message.includes('什么都没读到')),
      rTpl.issues.map(i => i.message).join('|'))
    ok('5b 空模板也提示「没写故事名」', rTpl.issues.some(i => i.message.includes('没写故事名')))

    // 填了故事名 + 世界设定，但词条与剧本都还是空的 ⇒ 空块必须被丢弃
    const partial = `${MARK.story}部分填写\n\n${MARK.setting}\n设定内容\n\n${MARK.entry}\n触发：\n正文：\n\n${MARK.script}\n情境：`
    const d = mustParse(partial)
    ok('5c 空的词条被丢掉（不产生空条目）', d.entries.length === 0, String(d.entries.length))
    ok('5d 空的剧本被丢掉（只写了键名没写内容）', d.scripts.length === 0, String(d.scripts.length))
    ok('5e 模板里四类标记都在', [MARK.story, MARK.setting, MARK.entry, MARK.script].every(m => IMPORT_TEMPLATE.includes(m)))
  }

  // ---------- 6) 概率与状态收口 ----------
  {
    const d = mustParse(`${MARK.story}S\n\n${MARK.entry}A\n概率：1.5\n正文：x\n\n${MARK.entry}B\n概率：-1\n正文：y\n\n${MARK.entry}C\n概率：abc\n正文：z`)
    ok('6a 概率 >1 收口到 1', d.entries[0].prob === 1, String(d.entries[0].prob))
    ok('6b 概率 <0 收口到 0', d.entries[1].prob === 0, String(d.entries[1].prob))
    ok('6c 概率非数字 ⇒ 回落 1 并告警', d.entries[2].prob === 1)
    const d2 = mustParse(`${MARK.story}S\n\n${MARK.entry}A\n状态：休眠\n正文：x`)
    ok('6d 状态「休眠」认得出', d2.entries[0].state === 'off', String(d2.entries[0].state))
    const r3 = parseStoryImport(`${MARK.story}S\n\n${MARK.entry}A\n状态：睡眠\n正文：x`)
    ok('6e 状态认不出 ⇒ 只是告警、不报错', r3.ok && r3.issues.some(i => i.level === 'warn'))
  }

  // ---------- 7) 裸行归属（不丢字） ----------
  {
    const d = mustParse(`${MARK.story}S\n\n${MARK.entry}A\n第一行\n第二行`)
    ok('7a 词条里没有键名的裸行并入正文', d.entries[0].body === '第一行\n第二行', JSON.stringify(d.entries[0].body))
    const d2 = mustParse(`${MARK.story}S\n\n${MARK.script}P\n情境：第一句\n续写第二句`)
    ok('7b 剧本里裸行续写到上一个键', d2.scripts[0].situation === '第一句\n续写第二句', JSON.stringify(d2.scripts[0].situation))
  }

  // ---------- 8) 上限告警（如实报告，不静默） ----------
  {
    const longName = 'x'.repeat(STORY_NAME_MAX + 5)
    const r1 = parseStoryImport(`${MARK.story}${longName}\n\n${MARK.setting}\n有内容`)
    ok('8a 故事名超上限 ⇒ 告警', r1.ok && r1.issues.some(i => i.level === 'warn' && i.message.includes('故事名')))

    const longSet = '字'.repeat(STORY_SETTING_MAX + 10)
    const r2 = parseStoryImport(`${MARK.story}S\n\n${MARK.setting}\n${longSet}`)
    ok('8b 世界设定超上限 ⇒ 告警', r2.ok && r2.issues.some(i => i.message.includes('世界设定')))

    const longGoal = '字'.repeat(SCRIPT_FIELD_MAX.goal + 10)
    const r3 = parseStoryImport(`${MARK.story}S\n\n${MARK.script}P\n这一场的目标：${longGoal}`)
    ok('8c 剧本某栏超上限 ⇒ 告警且点名是哪一栏', r3.ok && r3.issues.some(i => i.message.includes('这一场的目标')))
  }

  // ---------- 9) CRLF / BOM 归一化 ----------
  {
    const crlf = '\uFEFF' + SAMPLE.replace(/\n/g, '\r\n')
    const d = mustParse(crlf)
    ok('9a CRLF + BOM 也能解析', d.storyName === '约会大作战' && d.entries.length === 2)
  }

  // ---------- 10) 导出 → 导入 往返 ----------
  {
    const src = {
      name: '往返测试',
      setting: '设定第一行\n设定第二行',
      entries: [
        emptyWorldEntry({ id: 'e1', title: '甲', body: '甲正文', keys: ['甲', '甲二'], prob: 0.5, order: 3 }),
        emptyWorldEntry({ id: 'e2', title: '乙', body: '乙正文', keys: [], prob: 1, order: 0, constant: true }),
        emptyWorldEntry({ id: 'e3', title: '丙', body: '丙正文', keys: ['丙'], prob: 1, order: 0, recursive: false }),
        emptyWorldEntry({ id: 'e4', title: '丁', body: '丁正文', keys: ['丁'], prob: 1, order: 0, state: 'off' }),
      ],
      scripts: [
        { name: '本一', situation: '情境一', opening: '开场一', playerRole: '位置一', goal: '目标一', taboo: '禁忌一' },
      ],
    }
    const text = serializeStoryImport(src)
    const d = mustParse(text)
    ok('10a 往返：故事名一致', d.storyName === '往返测试', d.storyName)
    ok('10b 往返：世界设定一致', d.setting === src.setting, JSON.stringify(d.setting))
    ok('10c 往返：词条条数一致', d.entries.length === 4, String(d.entries.length))
    ok('10d 往返：词条字段逐个一致',
      d.entries[0].keys.join('|') === '甲|甲二' && d.entries[0].prob === 0.5 && d.entries[0].order === 3
      && d.entries[0].body === '甲正文')
    ok('10e 往返：常驻（无触发词）保持无触发词', d.entries[1].keys.length === 0)
    ok('10f 往返：引荐（recursive=false）被写成「状态：引荐」', d.entries[2].state === 'ref', String(d.entries[2].state))
    ok('10g 往返：休眠被写成「状态：休眠」并读回', d.entries[3].state === 'off', String(d.entries[3].state))
    ok('10h 往返：剧本六栏一致',
      d.scripts[0].name === '本一' && d.scripts[0].situation === '情境一' && d.scripts[0].taboo === '禁忌一')
    ok('10i 往返：二次序列化与第一次逐字相同（幂等）', serializeStoryImport(src) === text)
  }

  // ---------- 11) 标记常量与剧本键名（防各处再抄一份字面量） ----------
  {
    ok('11a MARK 四个标记齐全', [MARK.story, MARK.setting, MARK.entry, MARK.script].every(s => s.startsWith('〖')))
    ok('11b SCRIPT_KEYS 覆盖剧本五栏（名称单列）', SCRIPT_KEYS.length === 5
      && SCRIPT_KEYS.map(k => k.key).join(',') === 'situation,opening,playerRole,goal,taboo')
    ok('11c 模板里四种标记都在', [MARK.story, MARK.setting, MARK.entry, MARK.script].every(m => IMPORT_TEMPLATE.includes(m)))
  }

  console.log(`\ntavernStoryImport: ${pass} passed, ${fail} failed`)
}

main()
