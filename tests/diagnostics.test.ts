/**
 * 诊断信息采集 · 单测（2026-10-06 补）
 *
 * 本文件最主要的价值**不是**测「有没有输出这几行」，而是**守住隐私红线**：
 * 诊断信息是要被作者复制粘贴到群里的，一旦混进作品内容 / 密钥 / 文件路径，
 * 就是一次真实的信息外泄。所以每条红线都配一条断言，将来有人加字段时会被拦下。
 */
import * as db from '../src/lib/db'
import { collectDiagnostics } from '../src/lib/diagnostics'
import { recordError, clearErrors } from '../src/lib/errorLog'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // 造一个项目，让「数据规模」那几行有真内容（项目名刻意取得有辨识度，供下面做红线断言）
  const SECRET_NAME = '不该出现在诊断里的书名探针'
  const p = await db.createProject(SECRET_NAME, '', '')
  db.setCurrentProject(p.id)

  const text = await collectDiagnostics()
  const lines = text.split('\n')

  // ---------- 1) 结构：该有的行都在 ----------
  {
    const need = ['版本', '生成时间', '运行形态', '存储', '项目数', '当前项目', 'AI']
    const missed = need.filter(k => !new RegExp('^' + k + '：', 'm').test(text))
    ok('1a 关键行齐全（版本/时间/形态/存储/项目数/当前项目/AI）', missed.length === 0, `缺: ${missed.join(',')}`)
    // ⚠️ 测试环境 build-test.mjs 注入的版本号是 'test'（不是真实版本）⇒ 只断言「展示口径」这一形态：
    //    v 开头（正式版）或「开发版」，别写死具体版本号
    ok('1b 版本行是展示口径（v 开头或「开发版」）', /^版本：(v\S+|开发版)$/m.test(text),
      (text.match(/^版本：.*$/m) || [])[0])
    ok('1c 项目数 ≥ 1（刚建了一个）', /^项目数：[1-9]\d*$/m.test(text), (text.match(/^项目数：.*$/m) || [])[0])
    ok('1d 当前项目行报了「卷/章/万字」三项', /^\d+ 卷 \/ \d+ 章 \/ 累计 [\d.]+ 万字$/.test(
      (text.match(/^当前项目：(.*)$/m) || [])[1] || ''), (text.match(/^当前项目：.*$/m) || [])[0])
    ok('1e 末尾有「可放心粘贴」的说明（告知读者这是安全内容）', /可放心粘贴/.test(text))
    ok('1f 行数在合理区间（不是空壳也不是长篇）', lines.length >= 6 && lines.length <= 30, String(lines.length))
  }

  // ---------- 2) 🔴 红线：绝不带作品内容 ----------
  {
    ok('2a 不含项目名（书名是作者隐私）', !text.includes(SECRET_NAME))
    ok('2b 不含章节正文式长句（整体长度可控）', text.length < 2000, String(text.length))
    ok('2c 不含「第 N 章」这类正文痕迹', !/第\s*\d+\s*章/.test(text))
  }

  // ---------- 3) 🔴 红线：绝不带密钥 / 地址 ----------
  {
    ok('3a 不含 apiKey / token / secret 字样', !/apiKey|api_key|\btoken\b|secret|password/i.test(text))
    ok('3b 不含任何 http(s) 地址（baseUrl 可能内嵌令牌）', !/https?:\/\//i.test(text))
    ok('3c 不含密钥式长串（32 位以上连续字母数字）', !/[A-Za-z0-9_-]{32,}/.test(text),
      (text.match(/[A-Za-z0-9_-]{32,}/) || [])[0])
    ok('3d AI 行只报数量与本地/云端分布', /^AI：(未配置模型（仅本地能力可用）|已配置 \d+ 个模型（本地 \d+ · 云端 \d+）)$/m.test(text),
      (text.match(/^AI：.*$/m) || [])[0])
  }

  // ---------- 4) 🔴 红线：绝不带文件路径 / 用户名 ----------
  {
    ok('4a 不含 Windows 盘符路径（C:\\...）', !/[A-Za-z]:\\/.test(text))
    ok('4b 不含用户目录片段', !/\\?Users\\?|\/home\/|\/Users\//i.test(text))
    ok('4c 不含本机用户名', !text.includes('18223'))
    ok('4d 不含 .json / .yfe 等数据文件名', !/\.(json|yfe|db)\b/i.test(text))
  }

  // ---------- 5) 幂等与稳定性 ----------
  {
    const again = await collectDiagnostics()
    const strip = (s: string) => s.replace(/^生成时间：.*$/m, '')
    ok('5a 两次采集除时间外完全一致（无随机/无序字段）', strip(again) === strip(text))
    ok('5b 采集不抛异常且可重复调用', typeof again === 'string' && again.length > 0)
  }

  // ---------- 6) 与 errorLog 的闭环：出错时诊断文本要带上线索 ----------
  {
    clearErrors()
    const clean = await collectDiagnostics()
    ok('6a 一次都没出错时，整段不出现（不占篇幅）', !/最近错误/.test(clean))

    recordError('window', new Error('测试用错误 A'), 'App.tsx:12')
    const dirty = await collectDiagnostics()
    ok('6b 有错误时出现「最近错误」段', /最近错误（1 条/.test(dirty), (dirty.match(/最近错误.*/) || [])[0])
    ok('6c 错误消息与来源都在（能定位）', dirty.includes('测试用错误 A') && dirty.includes('App.tsx:12'))
    ok('6d 🔴 错误段也不带盘符路径（来源只有文件名）', !/[A-Za-z]:\\/.test(dirty))
    ok('6e 提示了「可自行删掉这一段」（把选择权交给作者）', /粘贴前可自行删掉这一段/.test(dirty))
    clearErrors()
  }

  console.log(`\ndiagnostics: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error('diagnostics 测试自身异常:', e); process.exit(1) })
