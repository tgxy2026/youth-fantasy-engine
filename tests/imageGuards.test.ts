// UX13 源码闸：作者自己的图片必须走「可见降级 + 可真重试」的 SafeImage，不许裸 `<img>`。
//
// 为什么值得设闸：裸 `<img>` 失败时浏览器画破图标，作者分不清「图坏了」还是「软件坏了」，
// 也没有再试一次的入口；而这类退化**不会让任何用例变红**，只有专门扫源码才能拦住。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

let assertions = 0
const ok = (name: string, passed: boolean) => { assert.ok(passed, name); assertions++; console.log('PASS ' + name) }

const safeImage = read('src/components/common/SafeImage.tsx')

ok('🔴 SafeImage 失败落可读占位（结构锚点 data-image-failure）',
  /data-image-failure=""[\s\S]{0,400}图片没能加载/.test(safeImage))
ok('🔴 占位与 img 共用同一套 className ⇒ 有图无图同尺寸',
  /className=\{className\}/.test(safeImage) && /className=\{`\$\{className\} flex flex-col/.test(safeImage))
ok('🔴 重试换新节点（key 带 attempt），不是重挂同一个失败节点',
  /key=\{`\$\{src\}#\$\{attempt\}`\}/.test(safeImage) && /setAttempt\(current => current \+ 1\)/.test(safeImage))
ok('重试失败态随 src 变化清掉（重新上传后不该一直显示占位）',
  /useEffect\(\(\) => \{ setFailed\(false\); setAttempt\(0\) \}, \[src\]\)/.test(safeImage))
ok('占位把「没能加载」读给读屏（role=img + aria-label）',
  /role="img"/.test(safeImage) && /aria-label=\{`\$\{alt \|\| '图片'\}：没能加载`\}/.test(safeImage))

const consumers = [
  ['src/components/atlas/AtlasCard.tsx', '图鉴卡片主图'],
  ['src/components/atlas/AtlasDetail.tsx', '图鉴详情大图'],
  ['src/components/world/CharacterPortraitSlots.tsx', '角色立绘'],
  ['src/components/world/CharacterProfileHeader.tsx', '档案缩略图'],
  ['src/components/app/ProjectHub.tsx', '项目封面'],
]
// 内置看板娘（`mascotCustom || jiewenjiGufeng`）是随包资源，不属于作者自己的图：
// 它失败时给「图片没能加载」的文字占位反而更突兀，故**刻意**保持裸 img。
const builtinDecorative = /src=\{mascotCustom \|\| jiewenjiGufeng\}/
for (const [file, what] of consumers) {
  const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
  const leftovers = (source.match(/<img\s+src=\{/g) ?? []).filter(() => true)
  const allowed = file.endsWith('ProjectHub.tsx') && builtinDecorative.test(source) ? 1 : 0
  ok(`🔴 ${what}走 SafeImage（${path.basename(file)}）`,
    source.includes('components/common/SafeImage') && /<SafeImage[\s\S]{0,200}src=/.test(source)
    && leftovers.length === allowed)
}

// 头像密度极高（列表 / 气泡 / 在场者），塞按钮反而挤 ⇒ 只要求「坏了退回首字」，不要求重试入口
const avatar = read('src/components/common/Avatar.tsx')
ok('🔴 头像加载失败退回首字，不画破图标', /onError=\{\(\) => setFailed\(true\)\}/.test(avatar) && /if \(src && !failed\)/.test(avatar))

console.log(`\nimageGuards: ${assertions} assertions passed`)
