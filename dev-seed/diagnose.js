/* eslint-disable */
/**
 * 【dev 专用】诊断：当前这个页面「能不能看到那批测试数据」，以及看不到的原因。
 *
 * 用法（在 http://localhost:5199/ 的 Console 里）：
 *
 *     await import('/dev-seed/diagnose.js?' + Date.now())
 *
 * 🔴 **必须带 `?' + Date.now()`**：ESM 模块会被浏览器缓存，第二次同名 import 不会重新执行
 *    （现象是「敲了什么都不打印」，容易误判成脚本坏了）。带上它每次都重新跑。
 *
 * 它会打印一段报告。**第一行是 origin** —— 正常应该是 `http://localhost:5199`。
 * 如果它是别的（`file://`、别的端口、局域网 IP…），那就是**另一个源、另一份 IndexedDB**，
 * 注入的数据当然不在这一份里。
 * （`127.0.0.1:5199` 已被 dev server 302 到 `localhost:5199`，两个写法进的是同一份库。）
 */
const idx = await import('/src/lib/tavern/story.ts')
const store = await import('/src/lib/tavern/store.ts')
const db = await import('/src/lib/db.ts')

const out = []
const say = (k, v) => { out.push(`${k}：${v}`) }

const EXPECTED = 'http://localhost:5199'
say('origin', location.origin + (location.origin === EXPECTED ? '  ✅ 正确' : `  ⚠️ 不是 ${EXPECTED} —— 你在另一个源上，那是另一份库`))
say('href', location.href)

// 当前项目（没进项目的话，项目级数据是不完整的）
let pid = ''
try { pid = String((await db.getMeta('lastProject', '')) || '') } catch { pid = '(读不到)' }
say('当前项目 id（meta.lastProject）', pid || '(空 —— 你可能还停在「项目中心」，先点进一本书)')

let storyCount = 0, hitStory = null
try {
  const stories = await idx.listStories()
  storyCount = stories.length
  hitStory = stories.find(s => s.name === '奉阳大学') ?? null
  say('故事总数', storyCount)
  say('有「奉阳大学」吗', hitStory ? `✅ 有（id=${hitStory.id}）` : '❌ 没有')
  if (stories.length) say('故事名一览', stories.map(s => s.name).join(' / '))
} catch (e) { say('读故事失败', String(e)) }

let chars = []
try {
  chars = await store.listFreeChars()
  say('角色卡总数', chars.length)
  say('卡名一览', chars.map(c => c.name).join(' / ') || '(空)')
  const unbound = chars.filter(c => !(c.storyId || ''))
  say('其中未归属（自由状态）', unbound.length)
} catch (e) { say('读角色卡失败', String(e)) }

let sessions = 0
try { sessions = (await store.listFreeSessions()).length } catch { /* 读不到就算了 */ }
say('自由对话会话数', sessions)

// 结论与下一步
out.push('')
if (hitStory && chars.some(c => c.name === '楚楠')) {
  out.push('▶ 结论：数据**在**这一份库里。若界面看不到，刷新一次（F5）再看。')
} else if (storyCount === 0 && chars.length === 0) {
  out.push('▶ 结论：这一份库是**空的**。两种可能：')
  out.push('   a) 你还没执行注入 → 敲：await import(\'/dev-seed/fengyang.js?\' + Date.now())')
  out.push('   b) 你注入到**另一个源**去了（对照第一行的 origin；127.0.0.1 现在会自动跳到 localhost）')
} else {
  out.push('▶ 结论：库里有数据，但没有这批测试数据 —— 执行注入：await import(\'/dev-seed/fengyang.js?\' + Date.now())')
}
out.push('')
out.push('ℹ️ 重启 dev server（后台服务）**不影响**这里的任何数据：')
out.push('   数据存在浏览器的 IndexedDB 里，跟服务端无关；服务端只负责把代码送过来。')

console.log('\n===== 酒馆 dev 数据诊断 =====\n' + out.join('\n') + '\n============================')
