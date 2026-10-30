// ============ 3.3.1 · P4：手册资源混版本的保护（规划 §4.4） ============
//
// 规划原文要求四件事，这批用例一件一件守：
//   ① 手册目录、正文和索引使用同一构建版本；
//   ② 网页残留旧资源导致版本不一致时，**停止据此生成 AI 回答**；
//   ③ 给出**重新加载帮助资源的入口**；
//   ④ 保留可读的匹配版本文章，且会话旧回答**携带当时内容版本**，不能悄悄替换引用原文。
//
// 🔴 这里的判据是「外壳（index.html）与内容包（JS）是不是同一次构建」——
//    `isHelpContentConsistent()` 查不到它：那种不一致发生在模块之外，两边各自内部都自洽。
import fs from 'node:fs'
import path from 'node:path'
import {
  CONTENT_VERSION, HELP_ARTICLES, HELP_BUILD_ID, HELP_BUILD_META, HELP_BUILD_MISMATCH_NOTICE,
  HELP_INDEX, HELP_RELOAD_LABEL, buildHelpIndex, checkHelpBuild,
} from '../src/lib/help'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

/** 造一个只够本判据用的假 document（不做 DOM，只回答「有没有那个 meta」） */
function fakeDoc(content: string | null) {
  return {
    querySelector: (selector: string) => {
      if (!selector.includes(HELP_BUILD_META)) return null
      return content === null ? null : { getAttribute: () => content }
    },
  } as unknown as Document
}

// ---------- ① 判据本身：三种情形 ----------
{
  ok('JS 包带构建标识（不是空串，dev 也会注入）', !!HELP_BUILD_ID && HELP_BUILD_ID.length >= 3, HELP_BUILD_ID)

  const same = checkHelpBuild(fakeDoc(HELP_BUILD_ID))
  ok('外壳标识与内容包相同 ⇒ 视为同一次构建', same.aligned && same.shell === HELP_BUILD_ID, JSON.stringify(same))

  const diff = checkHelpBuild(fakeDoc('3.3.1+20260101000000'))
  ok('🔴 外壳与内容包不同 ⇒ 判为混版本', !diff.aligned, JSON.stringify(diff))
  ok('判为混版本时两边标识都能读到（便于排查）', diff.shell !== null && diff.bundle === HELP_BUILD_ID)

  const missing = checkHelpBuild(fakeDoc(null))
  ok('🔴 读不到外壳标识时**不**判坏（桌面版 file:// 与老 HTML 没有这个 meta）',
    missing.aligned && missing.shell === null, JSON.stringify(missing))

  ok('没有 document 时按一致处理（纯逻辑层不崩）', checkHelpBuild(null).aligned)
  ok('文案里写清了「为什么停下」与「怎么办」',
    /版本不一致/.test(HELP_BUILD_MISMATCH_NOTICE) && /重新加载/.test(HELP_BUILD_MISMATCH_NOTICE))
  ok('重新加载按钮文案只有一个来源', HELP_RELOAD_LABEL === '重新加载帮助资源')
}

// ---------- ② 目录 / 正文 / 索引同版本 ----------
{
  const versions = new Set(HELP_INDEX.map(entry => entry.contentVersion))
  ok('🔴 每条索引都带内容版本，且只有一个值', versions.size === 1 && versions.has(CONTENT_VERSION),
    [...versions].join('、'))
  ok('索引条数与正文段落数一致（索引不是另一份手写清单）',
    HELP_INDEX.length === HELP_ARTICLES.reduce((sum, article) => sum + article.sections.length, 0),
    `${HELP_INDEX.length}`)
  ok('重新生成索引得到同样的版本标记',
    buildHelpIndex(HELP_ARTICLES).every(entry => entry.contentVersion === CONTENT_VERSION))
}

// ---------- ③ 答疑：混版本时**不发请求**（这是规划 §4.4 的硬要求） ----------
{
  const src = read('src/lib/aiTasks/helpAsk.ts')
  const guardAt = src.indexOf('checkHelpBuild()')
  const requestAt = src.indexOf("resolveProviderFor('utility')")
  ok('🔴 答疑里版本闸在取模型之前（混版本时连模型都不该取）', guardAt >= 0 && requestAt > guardAt,
    `guard=${guardAt} request=${requestAt}`)
  ok('🔴 混版本返回独立的 stale 结果，不混进「没配模型 / 手册没写」的措辞',
    /kind: 'stale'/.test(src))
  ok('stale 只带文案与版本信息，不带任何模型输出', /kind: 'stale'; message: string; build: HelpBuildState/.test(src))
  ok('回答带着生成那一刻的内容版本（旧回答要能说明自己基于哪一版）',
    /contentVersion: CONTENT_VERSION/.test(src) && /contentVersion: number/.test(src))
  ok('回答返回前再查一次外壳版本（请求期间换版本不能静默沿用）',
    (src.match(/checkHelpBuild\(\)/g) ?? []).length >= 2)
}

// ---------- ④ 界面：入口与措辞 ----------
{
  const panel = read('src/components/help/AskPanel.tsx')
  const center = read('src/components/help/HelpCenter.tsx')

  ok('🔴 问 AI 面板在混版本时给出「重新加载帮助资源」按钮', /HELP_RELOAD_LABEL/.test(panel))
  ok('🔴 查手册页也给出同一个入口（不用切到问 AI 才看到）', /HELP_RELOAD_LABEL/.test(center))
  ok('重新加载就是整页刷新（局部重建只会变成一半新一半旧）',
    /window\.location\.reload\(\)/.test(panel) && /window\.location\.reload\(\)/.test(center))
  ok('混版本横幅有稳定锚点（探针按它判断）',
    /data-help-build-mismatch/.test(panel) && /data-help-build-mismatch/.test(center))
  ok('横幅承诺「文章仍可阅读」（不能让人以为手册也坏了）',
    /仍可阅读|仍可正常阅读/.test(panel) && /仍可阅读/.test(center))
  ok('回答下方标出手册版本，版本过期时提示重新提问',
    /回答只依据内置手册（v\{result\.contentVersion\}/.test(panel)
    && /result\.contentVersion !== CONTENT_VERSION/.test(panel))
  ok('🔴 旧回答的依据仍按「当时的原文快照」校验（不悄悄替换引用原文）',
    /helpSourceSnapshot\(source\.articleId, source\.sectionId\) !== result\.sourceSnapshots\[key\]/.test(panel))
}

// ---------- ⑤ 构建侧：标识必须真的被写进 HTML 与 JS ----------
{
  const vite = read('vite.config.ts')
  const html = read('index.html')

  ok('🔴 构建配置 define 了 __HELP_BUILD__', /__HELP_BUILD__: JSON\.stringify\(helpBuild\)/.test(vite))
  ok('🔴 构建配置把同一个标识写进 index.html 的 meta', /name="yfe-help-build"/.test(vite))
  ok('构建标识每次构建都不同（含启动时刻，不是纯版本号）',
    /const helpBuild = `\$\{appVersion\}\+\$\{new Date\(\)/.test(vite))
  ok('dev 下靠 transform 插件替换（define 在 dev 不生效，注释里写明过同一坑）',
    /src\/lib\/help\/buildInfo\.ts/.test(vite) && /__HELP_BUILD__/.test(vite))
  ok('入口 HTML 本身不带死值（标识由插件注入，避免两处写死）',
    !html.includes('yfe-help-build'))
}

console.log(`\n—— helpBuildGuard 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
