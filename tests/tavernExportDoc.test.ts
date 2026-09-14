// ============ 酒馆模式 · 文档导出（B5）============
//
// 这一层的价值在于「带得走」：推演完的东西留在软件里，作者没法拿去改稿、存档、发人。
// 导出是**纯逻辑**（不碰 DOM、不碰库），所以能被完整测到 —— 只有最后一跳下载动作才需要真浏览器。
//
// 测试重点：
//   ① 行分类与界面渲染**同源**（classifyTavernLine）—— 两边漂移是本项目踩过多次的坑；
//   ② 说话人署名：用户演的角色署角色名，多 AI 时按 speakerId 认人；
//   ③ 隐藏消息：默认导出并标出，关掉时确实被排除；
//   ④ 两种格式都吃到同一份 DocModel（改一处两边都变）；
//   ⑤ HTML 必须**自包含 + 转义**（正文里的 <script> 不能变成真标签）。
import {
  classifyTavernLine, tavernLines, plotDocModel, freeDocModel, reportDocModel,
  toMarkdown, toHtml, renderDoc, docFileName, plotSpeakerOf,
} from '../src/lib/tavern/exportDoc'
import type { TavernMessage, TavernSession, TavernReport, FreeSession } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const msg = (o: Partial<TavernMessage> & { id: string }): TavernMessage =>
  ({ role: 'assistant', content: '', at: 0, ...o })

const session: TavernSession = {
  id: 's1', title: '分手前夜', mode: 'immersive',
  anchorChapterId: 'c1', anchorChapterLabel: '第十二章 · 雨',
  cast: [
    { cardId: 'k1', role: 'user', tabId: 'char-main', name: '洛汐' },
    { cardId: 'k2', role: 'ai', tabId: 'char-main', name: '苏念' },
  ],
  scene: { place: '旧书店', time: '雨夜', present: ['洛汐', '苏念'], description: '雨敲着铁皮檐。' },
  messages: [
    msg({ id: 'm1', content: '【雨点砸在遮阳棚上】\n你来了。' }),
    msg({ id: 'm2', role: 'user', content: '（把伞收起）\n我来还书。' }),
    msg({ id: 'm3', content: '〔她背对着门〕\n不必了。', hidden: true, edited: true }),
    msg({ id: 'm4', role: 'system', content: '这条不该出现' }),
  ],
  model: { providerId: 'p' }, params: {},
  createdAt: 0, updatedAt: 0,
}

const report: TavernReport = {
  id: 'r1', projectId: 'p1', sessionId: 's1', sessionTitle: '分手前夜',
  anchorChapterId: 'c1', anchorChapterLabel: '第十二章 · 雨',
  cast: session.cast, mode: 'immersive',
  overview: '这场戏成立。',
  findings: [
    { id: 'f1', level: '存疑', targetTabId: '', detail: '她的反应偏冷。' },
    { id: 'f2', level: '矛盾', targetTabId: 'char-main', targetRecordId: 'k2', targetLabel: '苏念', detail: '境界对不上。', suggestion: '改成练气三层。' },
    { id: 'f3', level: '漏洞', targetTabId: 'relations', targetRecordId: 'x', targetLabel: '洛汐-苏念', detail: '关系缺交代。' },
  ],
  createdAt: 0,
}

function main() {
  // ---------- 1) 行分类（与界面渲染同源） ----------
  {
    ok('（动作）→ action', classifyTavernLine('（她把伞收起）') === 'action')
    ok('半角括号也算动作', classifyTavernLine('(she nods)') === 'action')
    ok('【环境】→ ambient', classifyTavernLine('【雨敲着铁皮檐】') === 'ambient')
    ok('〔状态〕→ state', classifyTavernLine('〔她背对着门〕') === 'state')
    ok('其余 → 对白', classifyTavernLine('你来了。') === 'speech')
    ok('前导空白不影响判定', classifyTavernLine('   （收伞）') === 'action')
    ok('tavernLines 去空行 + trim', JSON.stringify(tavernLines(' 甲 \n\n 乙  \n')) === JSON.stringify(['甲', '乙']))
    ok('空内容 → 空数组', tavernLines('').length === 0 && tavernLines('  \n \n').length === 0)
  }

  // ---------- 2) 剧情推演：模型 ----------
  {
    const doc = plotDocModel(session)
    ok('标题取会话名', doc.title === '分手前夜', doc.title)
    ok('meta 含推演类型', doc.meta.includes('沉浸推演'), doc.meta.join('|'))
    ok('meta 含叙事锚点', doc.meta.some(m => m.includes('第十二章')), doc.meta.join('|'))
    ok('meta 含「你演 / AI 演」', doc.meta.some(m => m === '你演：洛汐') && doc.meta.some(m => m === 'AI 演：苏念'), doc.meta.join('|'))
    ok('meta 含场景', doc.meta.some(m => m.includes('旧书店')), doc.meta.join('|'))
    ok('统计条数不含 system（4 条消息里 1 条是 system）', doc.meta.some(m => m === '3 条对话'), doc.meta.join('|'))

    const msgs = doc.blocks.filter(b => b.type === 'msg')
    ok('system 消息不进文档', msgs.length === 3, String(msgs.length))
    ok('开场描述单独成一段', doc.blocks.some(b => b.type === 'section' && b.text === '开场'))

    const first = msgs[0] as Extract<typeof doc.blocks[number], { type: 'msg' }>
    ok('AI 消息署 AI 角色名', first.speaker === '苏念', first.speaker)
    ok('AI 消息 side=ai', first.side === 'ai')
    ok('行被拆开（环境与对白分开）', JSON.stringify(first.lines) === JSON.stringify(['【雨点砸在遮阳棚上】', '你来了。']), JSON.stringify(first.lines))

    const second = msgs[1] as Extract<typeof doc.blocks[number], { type: 'msg' }>
    ok('用户消息署他演的角色名', second.speaker === '洛汐', second.speaker)
    ok('用户消息 side=user', second.side === 'user')

    const third = msgs[2] as Extract<typeof doc.blocks[number], { type: 'msg' }>
    ok('隐藏消息默认仍然导出', !!third.hidden && third.speaker === '苏念')
    ok('改过的消息带标记', third.edited === true)
    ok('脚注说明含隐藏条数', doc.foot.some(f => f.includes('1 条已隐藏')), doc.foot.join('|'))

    // 关掉隐藏
    const noHidden = plotDocModel(session, { includeHidden: false })
    const nh = noHidden.blocks.filter(b => b.type === 'msg')
    ok('关掉后隐藏消息被排除', nh.length === 2, String(nh.length))
    ok('关掉后脚注换一种说法', noHidden.foot.some(f => f.includes('没有导出')), noHidden.foot.join('|'))
    ok('关掉后统计条数也跟着变（从 3 减到 2）', noHidden.meta.some(m => m === '2 条对话'), noHidden.meta.join('|'))

    // 不带元信息
    const bare = plotDocModel(session, { withMeta: false })
    ok('withMeta=false → meta 为空', bare.meta.length === 0)
    ok('withMeta=false → 开场段也不附', !bare.blocks.some(b => b.type === 'section' && b.text === '开场'))
    ok('withMeta=false → 正文照样有', bare.blocks.filter(b => b.type === 'msg').length === 3)
  }

  // ---------- 3) 多 AI 按 speakerId 认人 ----------
  {
    const multi: TavernSession = {
      ...session,
      cast: [
        { cardId: 'k1', role: 'user', tabId: 'char-main', name: '洛汐' },
        { cardId: 'k2', role: 'ai', tabId: 'char-main', name: '苏念' },
        { cardId: 'k3', role: 'ai', tabId: 'char-main', name: '楚楠' },
      ],
      messages: [
        msg({ id: 'a', content: '我来。', speakerId: 'k3' }),
        msg({ id: 'b', content: '别。', speakerId: 'k2' }),
        msg({ id: 'c', content: '没人认领的一句' }),
      ],
    }
    const sp = plotSpeakerOf(multi)
    const msgs = plotDocModel(multi).blocks.filter(b => b.type === 'msg') as Extract<
      ReturnType<typeof plotDocModel>['blocks'][number], { type: 'msg' }>[]
    ok('多 AI：按 speakerId 认人', msgs[0].speaker === '楚楠' && msgs[1].speaker === '苏念', `${msgs[0].speaker}/${msgs[1].speaker}`)
    ok('多 AI：没 speakerId 时回落到第一个 AI（不显示空名）', msgs[2].speaker === '苏念', msgs[2].speaker)
    ok('plotSpeakerOf 对用户一律给用户角色名', sp(msg({ id: 'u', role: 'user' })).label === '洛汐')
  }

  // ---------- 4) 自由对话 ----------
  {
    const free: FreeSession = {
      id: 'fs1', title: '雨天的书店', charIds: ['k2', 'k9'],
      userCharId: 'k1',
      scene: { place: '书店', time: '雨夜', present: [], description: '雨很大。' },
      messages: [
        msg({ id: 'f1', role: 'user', content: '在吗。' }),
        msg({ id: 'f2', content: '在。', speakerId: 'k2' }),
      ],
      model: { providerId: 'p' }, params: {},
      lastActiveAt: 0, createdAt: 0, updatedAt: 0,
    }
    const nameOf = (id: string) => ({ k1: '洛汐', k2: '苏念', k9: '楚楠' } as Record<string, string>)[id] ?? ''
    const speakerOf = (m: TavernMessage) => (m.role === 'user'
      ? { label: nameOf(m.speakerId ?? 'k1') || '你', side: 'user' as const }
      : { label: nameOf(m.speakerId ?? 'x') || '角色', side: 'ai' as const })

    const doc = freeDocModel(free, { nameOf, speakerOf, userLabel: '洛汐' })
    ok('自由：meta 列出在场角色名（不是 id）', doc.meta.some(m => m === '在场：苏念、楚楠'), doc.meta.join('|'))
    ok('自由：meta 含场景', doc.meta.some(m => m.includes('书店')), doc.meta.join('|'))
    const msgs = doc.blocks.filter(b => b.type === 'msg') as Extract<typeof doc.blocks[number], { type: 'msg' }>[]
    ok('自由：用户署自己演的角色名', msgs[0].speaker === '洛汐', msgs[0].speaker)
    ok('自由：AI 按 speakerId 署名', msgs[1].speaker === '苏念', msgs[1].speaker)
    ok('自由：不传 speakerOf 也能出文档（回落到「你 / 角色」）',
      freeDocModel(free).blocks.filter(b => b.type === 'msg').length === 2)
  }

  // ---------- 5) 报告 ----------
  {
    const tabName = (id: string) => ({ 'char-main': '主角', relations: '角色关系' } as Record<string, string>)[id] ?? id
    const doc = reportDocModel(report, tabName)
    ok('报告标题带「推演报告」', doc.title === '分手前夜 · 推演报告', doc.title)
    ok('报告 meta 含锚点', doc.meta.some(m => m.includes('第十二章')), doc.meta.join('|'))
    const sections = doc.blocks.filter(b => b.type === 'section').map(b => (b as { text: string }).text)
    ok('分组顺序＝矛盾 → 漏洞 → 存疑（重到轻）',
      sections.join('>') === '概览>矛盾 · 1 条>漏洞 · 1 条>存疑 · 1 条', sections.join('>'))
    const items = doc.blocks.filter(b => b.type === 'items').flatMap(b => (b as { items: { tag?: string; title?: string; text: string; sub?: string }[] }).items)
    ok('finding 带上表的中文名', items.some(i => i.title === '主角 · 苏念'), JSON.stringify(items.map(i => i.title)))
    ok('建议进 sub', items.some(i => i.sub === '建议：改成练气三层。'))
    ok('指不回条目的那条没有 title（仍是存疑）', items.some(i => i.tag === '存疑' && !i.title))
    ok('报告脚注保留「只诊断」口径', doc.foot.some(f => f.includes('不会写回')), doc.foot.join('|'))

    const empty = reportDocModel({ ...report, findings: [] }, tabName)
    ok('无问题时给一句「自洽」而不是空列表', empty.blocks.some(b => b.type === 'note'))
    ok('无问题时不再有 items 块', !empty.blocks.some(b => b.type === 'items'))

    const noMeta = reportDocModel(report, tabName, { withMeta: false })
    ok('报告 withMeta=false → meta 为空', noMeta.meta.length === 0)
  }

  // ---------- 6) Markdown 渲染 ----------
  {
    const md = toMarkdown(plotDocModel(session))
    ok('md 一级标题', md.startsWith('# 分手前夜'), md.split('\n')[0])
    ok('md 元信息走引用块', md.includes('> 沉浸推演'))
    ok('md 说话人加粗', md.includes('**苏念**'))
    ok('md 隐藏消息标出来', md.includes('已隐藏 · 未进上下文') && md.includes('改过'))
    ok('md 段落两两隔空行（不然（动作）会和对白糊成一段）', md.includes('（把伞收起）\n\n我来还书。'))
    ok('md 阶段小标题用 ##', md.includes('## 开场'))
    ok('md 脚注前有分隔线', md.includes('\n---\n'))
    ok('md 连续空行被压掉（不会出现三个换行）', !/\n{3}/.test(md))
    ok('md 以换行收尾', md.endsWith('\n'))

    // 行首会改变 Markdown 结构的字符要被转义
    const tricky = toMarkdown(plotDocModel({
      ...session,
      messages: [msg({ id: 't1', content: '# 不是标题\n> 不是引用\n1. 不是列表' })],
      scene: { ...session.scene, description: '' },
    }, { withMeta: false }))
    ok('行首 # 被转义', tricky.includes('\\# 不是标题'), tricky)
    ok('行首 > 被转义', tricky.includes('\\> 不是引用'))
    ok('行首 1. 被转义', tricky.includes('1\\. 不是列表'), tricky)
  }

  // ---------- 7) HTML 渲染 ----------
  {
    const html = toHtml(plotDocModel(session))
    ok('html 有 doctype 与 lang', html.startsWith('<!DOCTYPE html>') && html.includes('<html lang="zh-CN">'))
    ok('html 带 charset', html.includes('<meta charset="utf-8">'))
    ok('html 标题在 <title> 里', html.includes('<title>分手前夜</title>'))
    ok('🔴 html 自包含：不引任何外部资源',
      !/<(script|link|img)[^>]*(src|href)=/i.test(html) && !/https?:\/\//.test(html))
    ok('样式内联在 <style> 里', html.includes('<style>') && html.includes('</style>'))
    ok('对白行没有额外 class', html.includes('<p class="line speech">你来了。</p>'))
    ok('环境行标 ambient', html.includes('<p class="line ambient">【雨点砸在遮阳棚上】</p>'))
    ok('动作行标 action', html.includes('<p class="line action">（把伞收起）</p>'))
    ok('状态行标 state', html.includes('<p class="line state">〔她背对着门〕</p>'))
    ok('用户消息加 user 类（排版上区分你 / Ta）', html.includes('class="msg user"'))
    ok('隐藏消息加 hidden 类与徽标', html.includes('msg ai hidden') && html.includes('已隐藏 · 未进上下文'))
    ok('有深浅色自适应', html.includes('prefers-color-scheme'))
    ok('有打印样式', html.includes('@media print'))

    // 转义（XSS 是这里唯一的真实风险：正文里可能有任意符号）
    const evil = toHtml(plotDocModel({
      ...session,
      title: '<script>alert(1)</script>',
      messages: [msg({ id: 'e1', content: '他说 <b>不</b> & "算了"' })],
      scene: { ...session.scene, description: '' },
    }, { withMeta: false }))
    ok('标题里的标签被转义', evil.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !evil.includes('<script>'))
    ok('正文里的尖括号与 & 被转义', evil.includes('&lt;b&gt;不&lt;/b&gt; &amp;'))
  }

  // ---------- 8) 出口：文件名与格式 ----------
  {
    const md = renderDoc(plotDocModel(session), 'markdown')
    ok('md 文件名带 .md', md.filename === '分手前夜.md', md.filename)
    ok('md 的 mime 对', md.mime.startsWith('text/markdown'))
    const html = renderDoc(plotDocModel(session), 'html')
    ok('html 文件名带 .html', html.filename === '分手前夜.html', html.filename)
    ok('html 的 mime 对', html.mime.startsWith('text/html'))

    ok('文件名去掉非法字符', docFileName('a/b:c*d?e"f<g>h|i', '.md') === 'a_b_c_d_e_f_g_h_i.md', docFileName('a/b:c*d?e"f<g>h|i', '.md'))
    ok('空标题兜底', docFileName('', '.md') === '未命名.md' && docFileName('   ', '.html') === '未命名.html')
    ok('超长标题截断到 60 字', docFileName('长'.repeat(200), '.md').length === 60 + 3)
    ok('ext 没点也认', docFileName('甲', 'md') === '甲.md')
    ok('渲染两种格式吃的是同一份模型（标题一致）',
      renderDoc(plotDocModel(session), 'markdown').content.includes(plotDocModel(session).title))
  }

  console.log(`\ntavernExportDoc: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
