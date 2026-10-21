// 3.2.0 · 图片拖拽上传 · 单测
//
// 盯五件事：
//   ① 拖进来的东西「是不是文件」判得准 —— 判错会把章节拖拽调序 / 正文选区拖动一起弄坏；
//   ② 格式判定覆盖三种真实来源：正常带 MIME、网盘客户端给空 MIME（靠扩展名）、MIME 别名（jpg↔jpeg）；
//   ③ 拒绝理由分类正确（文件夹 / 空文件 / 不是图片），且点名文件 —— 作者要据此决定下一步；
//   ④ 多拖只取第一张，且如实报出「用了哪张、另有几张」；
//   ⑤ **接线不漏**：全仓 7 处图片入口都得接上（漏一处不会报错，只会"这一处拖不进去"）。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  acceptLabel, hasDroppedFilePayload, hasFilePayload, matchAccept, planImageDrop, type DroppedFileLike,
} from '@/lib/media/imageDrop'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const f = (name: string, type: string, size = 1024): DroppedFileLike => ({ name, type, size })
const AVATAR = 'image/png,image/jpeg,image/webp,image/gif'
const MAP = 'image/png,image/jpeg,image/webp'

function main() {
  // ---------- 一、是不是「拖文件」 ----------
  {
    ok('① 带 Files 的拖拽认作文件', hasFilePayload(['Files', 'text/plain']))
    ok('① 章节树拖拽调序（自定义 types）不算文件', !hasFilePayload(['application/x-yfe-chapter']))
    ok('① 正文拖动选区（text/plain）不算文件', !hasFilePayload(['text/plain']))
    ok('① types 缺失/为空一律不算（宁可不拦，也不误拦）',
      !hasFilePayload(undefined) && !hasFilePayload(null) && !hasFilePayload([]))
    ok('① drop 的 types 为空时按实际文件列表兜底',
      hasDroppedFilePayload([], 1) && hasDroppedFilePayload(undefined, 2) && !hasDroppedFilePayload([], 0))
    ok('① 大小写不敏感以外不做联想：小写 files 不认（浏览器恒为首字母大写 Files）',
      !hasFilePayload(['files']))
  }

  // ---------- 二、accept 说明文案 ----------
  {
    ok('② 具名 MIME ⇒ 可读短名', acceptLabel(AVATAR) === 'PNG / JPG / WebP / GIF', acceptLabel(AVATAR))
    ok('② 通配 image/* ⇒ "图片"', acceptLabel('image/*') === '图片', acceptLabel('image/*'))
    ok('② 只写了扩展名 ⇒ 原样亮出来（不硬编成"图片"）', acceptLabel('.png,.jpg') === 'PNG / JPG', acceptLabel('.png,.jpg'))
    ok('② 空串 ⇒ 空说明（调用方会退回通用文案）', acceptLabel('') === '')
  }

  // ---------- 三、格式判定 ----------
  {
    ok('③ 正常 PNG 过', matchAccept(f('a.png', 'image/png'), AVATAR))
    ok('③ 空 MIME 靠扩展名兜底（网盘客户端常见）', matchAccept(f('封面.JPG', ''), AVATAR))
    ok('③ MIME 别名 jpg↔jpeg 互通',
      matchAccept(f('a.jpg', 'image/jpg'), AVATAR) && matchAccept(f('a.jpg', 'image/jpeg'), 'image/jpg'))
    ok('③ image/* 只认 image 前缀', matchAccept(f('a.webp', 'image/webp'), 'image/*') && !matchAccept(f('a.txt', 'text/plain'), 'image/*'))
    ok('③ 不在 accept 里的格式不过（GIF 不在 MAP 的范围内）', !matchAccept(f('a.gif', 'image/gif'), MAP))
    ok('③ 非图片一律不过', !matchAccept(f('a.txt', 'text/plain'), 'image/*') && !matchAccept(f('a.pdf', 'application/pdf'), AVATAR))
  }

  // ---------- 四、整次拖拽的结论 ----------
  {
    const one = planImageDrop([f('a.png', 'image/png')], AVATAR)
    ok('④ 单张合格图 ⇒ accept 且 extra=0',
      one.kind === 'accept' && one.file.name === 'a.png' && one.extra === 0)

    const many = planImageDrop([f('1.png', 'image/png'), f('2.png', 'image/png'), f('3.png', 'image/png')], AVATAR)
    ok('④ 多拖 ⇒ 用第一张，并如实报出另有 2 张',
      many.kind === 'accept' && many.file.name === '1.png' && many.extra === 2,
      JSON.stringify(many))

    const empty = planImageDrop([], AVATAR)
    ok('④ 一个文件都没有 ⇒ 拒绝且理由可读',
      empty.kind === 'reject' && /没读到文件/.test(empty.reason), empty.kind === 'reject' ? empty.reason : '')

    const folder = planImageDrop([f('新建文件夹', '', 0)], AVATAR)
    ok('④ 文件夹 ⇒ 专门提示"拖文件夹不行"（而不是笼统说不是图片）',
      folder.kind === 'reject' && /文件夹/.test(folder.reason), folder.kind === 'reject' ? folder.reason : '')

    const zero = planImageDrop([f('a.png', 'image/png', 0)], AVATAR)
    ok('④ 空文件 ⇒ 点名 + 说清是空文件',
      zero.kind === 'reject' && /空文件/.test(zero.reason) && zero.reason.includes('a.png'),
      zero.kind === 'reject' ? zero.reason : '')

    const wrong = planImageDrop([f('大纲.txt', 'text/plain')], AVATAR)
    ok('④ 格式不符 ⇒ 点名文件 + 说清这处收什么',
      wrong.kind === 'reject' && wrong.reason.includes('大纲.txt') && wrong.reason.includes('PNG'),
      wrong.kind === 'reject' ? wrong.reason : '')

    // 纯函数不该改动入参（DataTransfer.files 是活对象，改它会连带影响后续处理器）
    const list = [f('b.png', 'image/png'), f('c.png', 'image/png')]
    planImageDrop(list, AVATAR)
    ok('④ 不改动入参数组也不排序（顺序＝作者拖动顺序）',
      list.map(x => x.name).join(',') === 'b.png,c.png')
  }

  // ---------- 五、接线不漏 ----------
  {
    const root = process.cwd()
    const read = (p: string) => readFileSync(path.join(root, p), 'utf8')

    const zones: [string, string, number][] = [
      ['头像（角色卡 / 我的档案共用）', 'src/components/common/AvatarPicker.tsx', 1],
      ['项目中心 · 封面（新建 + 编辑两处）', 'src/components/app/ProjectHub.tsx', 2],
      ['图鉴详情 · 主图', 'src/components/atlas/AtlasDetail.tsx', 1],
      ['地图编辑器 · 底图', 'src/components/world/GeoMapEditor.tsx', 1],
      ['看板娘设置', 'src/components/settings/MascotSettingsDialog.tsx', 1],
      // 立绘两格在 3.2.0 拆成独立组件（CharacterSheet 已顶到 1200 行硬上限）
      ['角色卡 · 立绘两格', 'src/components/world/CharacterPortraitSlots.tsx', 2],
    ]
    for (const [label, file, want] of zones) {
      const src = read(file)
      const got = (src.match(/useImageDrop\(/g) ?? []).length
      ok(`⑤ ${label}：接线 ${want} 处`, got === want, `实测 ${got}`)
      ok(`⑤ ${label}：拖拽处理器摊到了容器上`, src.includes('dropProps'))
    }

    const hook = read('src/components/common/ImageDropZone.tsx')
    // enter / over 判 types；drop 以实际 files 列表兜底（types 可能已被浏览器清空）
    ok('⑤ 进/悬停/落 三处都先判「是不是文件」',
      (hook.match(/hasFilePayload\(e\.dataTransfer\?\.types\)/g) ?? []).length === 2 &&
      hook.includes('hasDroppedFilePayload(e.dataTransfer?.types, e.dataTransfer?.files.length ?? 0)'))
    // 🔴 dragleave 反而**不能**判 types：实测空数组，判了就会漏减计数 ⇒ 覆盖层卡死（实机踩过）
    ok('⑤ dragleave 不以 types 为判据（否则空 types 时覆盖层卡住不走）',
      !/onDragLeave[\s\S]{0,240}hasFilePayload\(/.test(hook) && hook.includes('if (depth.current === 0) return'))
    ok('⑤ 拖出窗口 / 按 Esc 结束拖拽时能自动复位',
      hook.includes("addEventListener('dragend'") && hook.includes("addEventListener('drop'"))
    ok('⑤ 进出用计数（boolean 会在子元素间闪）',
      hook.includes('depth.current += 1') && hook.includes('depth.current === 0'))
    ok('⑤ drop 里 stopPropagation（弹窗内嵌套时不被外层再吃一次）',
      /onDrop[\s\S]{0,400}stopPropagation/.test(hook))
    ok('⑤ disabled 时仍然吃掉浏览器默认行为，但不收文件',
      /if \(disabled\) return/.test(hook) && hook.indexOf("e.stopPropagation()") < hook.indexOf('if (disabled) return'))
    ok('⑤ 覆盖层不拿鼠标（pointer-events-none），否则自己把自己闪掉',
      /pointer-events-none absolute inset-0/.test(hook))
    ok('⑤ 覆盖层层号走 Z 真源，不写裸 z-10',
      hook.includes('Z.pageHandle') && !/className=\{`[^`]*\bz-10\b/.test(hook))

    const guard = read('src/lib/app/dropGuard.ts')
    ok('⑤ 全局兜底只在拖文件时拦（拖到页面空白处不会把整页顶掉）',
      guard.includes('hasFilePayload') && guard.includes('hasDroppedFilePayload') && guard.includes("addEventListener('drop'"))
    ok('⑤ 兜底已挂载到入口', read('src/main.tsx').includes('installFileDropGuard()'))

    ok('⑤ 角色卡：立绘两格由独立组件承载（拆出去后别把渲染点一起删了）',
      read('src/components/world/CharacterSheet.tsx').includes('<CharacterPortraitSlots'))

    // 拖拽与「点按钮选图」必须是同一条通路：不能出现拖拽专用的第二条处理函数
    for (const [label, file] of zones) {
      const src = read(file)
      ok(`⑤ ${label}：拖拽复用既有的 pick 函数，没有另写一条落库通路`,
        /onFile[,:]/.test(src) && !/onDrop[\s\S]{0,600}(saveTableRow|readAsDataURL)/.test(src))
    }
  }

  console.log(`\n▶ imageDrop: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
