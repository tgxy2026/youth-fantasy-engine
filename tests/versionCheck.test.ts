// ============ 检查更新 · 纯函数单测（2.6.3）============
//
// 钉住三件最容易翻车的事：
//   ① 版本比较必须**逐段按数字** —— 字符串比较会把 2.6.10 判成小于 2.6.2；
//   ② 安装包直链要从 assets 里挑 .exe，源码 zip / tar.gz 不能算；
//   ③ 更新说明来自 Gitee（外部输入）→ mdLite 只输出纯文本块，标签字符必须被当普通文字。
import { normalizeVersion, compareVersion, pickInstallerUrl } from '../src/lib/versionCheck'
import { parseMarkdownBlocks, stripInline } from '../src/lib/mdLite'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 版本解析 ----------
{
  ok('v2.6.3 → 2.6.3', normalizeVersion('v2.6.3') === '2.6.3', String(normalizeVersion('v2.6.3')))
  ok('大写 V 也认', normalizeVersion('V2.6.3') === '2.6.3')
  ok('无前缀也认', normalizeVersion('2.6.3') === '2.6.3')
  ok('带后缀只取三段', normalizeVersion('2.6.3-beta.1') === '2.6.3')
  ok('「开发版」→ null（dev 环境不参与比较）', normalizeVersion('开发版') === null)
  ok('空串 → null', normalizeVersion('') === null)
}

// ---------- 版本比较（核心）----------
{
  ok('🔴 2.6.10 > 2.6.2（字符串比较会判错）', compareVersion('2.6.10', '2.6.2') === 1, String(compareVersion('2.6.10', '2.6.2')))
  ok('2.6.3 > 2.6.2', compareVersion('2.6.3', '2.6.2') === 1)
  ok('2.7.0 > 2.6.99', compareVersion('2.7.0', '2.6.99') === 1)
  ok('3.0.0 > 2.99.99', compareVersion('3.0.0', '2.99.99') === 1)
  ok('相等 → 0', compareVersion('2.6.3', '2.6.3') === 0)
  ok('v 前缀不影响比较', compareVersion('v2.6.3', '2.6.3') === 0)
  ok('更小 → -1', compareVersion('2.6.2', '2.6.3') === -1)
  ok('任一侧非法 → null', compareVersion('开发版', '2.6.3') === null && compareVersion('2.6.3', 'x') === null)
}

// ---------- 安装包直链挑选 ----------
{
  const assets = [
    { name: 'v2.6.2.zip', browser_download_url: 'https://x/archive/v2.6.2.zip' },
    { name: '青春幻想引擎-Setup-2.6.2.exe', browser_download_url: 'https://x/download/Setup-2.6.2.exe' },
    { name: 'v2.6.2.tar.gz', browser_download_url: 'https://x/archive/v2.6.2.tar.gz' },
  ]
  ok('挑出 Setup.exe', pickInstallerUrl(assets) === 'https://x/download/Setup-2.6.2.exe', pickInstallerUrl(assets))
  ok('只有源码包 → 空串', pickInstallerUrl([assets[0], assets[2]]) === '')
  ok('assets 不是数组 → 空串', pickInstallerUrl(undefined) === '' && pickInstallerUrl({}) === '')
  ok('无直链字段 → 空串', pickInstallerUrl([{ name: 'a.exe' }]) === '')
}

// ---------- mdLite ----------
{
  const blocks = parseMarkdownBlocks(
    '## 青春幻想引擎 v2.6.3\n\n正文一段。\n\n### 重点\n- 第一项 **加粗**\n- 第二项 `代码`\n\n> 引用一行\n\n---\n\n收尾段。',
  )
  const types = blocks.map(b => b.type)
  ok('切出 h2 / p / h3 / li×2 / quote / p', types.join(',') === 'h2,p,h3,li,li,quote,p', types.join(','))
  ok('标题文本已去标记', blocks[0].text === '青春幻想引擎 v2.6.3', blocks[0].text)
  ok('列表项去加粗/代码标记', blocks[3].text === '第一项 加粗' && blocks[4].text === '第二项 代码',
    blocks[3].text + ' | ' + blocks[4].text)
  ok('分割线被忽略（不产生空块）', blocks.every(b => b.text.length > 0))
  ok('引用块内容正确', blocks[5].text === '引用一行', blocks[5].text)

  ok('stripInline 去掉链接只留文字', stripInline('见 [更新说明](https://x) 末尾') === '见 更新说明 末尾')
  ok('stripInline 丢弃图片', stripInline('![封面](https://x/a.png) 后') === '后', stripInline('![封面](https://x/a.png) 后'))
  ok('🔴 HTML 标签字符只当普通文字（不走 innerHTML）',
    stripInline('<script>alert(1)</script>') === '<script>alert(1)</script>')
  ok('空输入 → 空块数组', parseMarkdownBlocks('').length === 0)
}

console.log(`\nversionCheck: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
