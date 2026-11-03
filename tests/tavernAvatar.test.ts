// ============ 头像（批次 8）============
//
// 头像这层的风险不在"能不能显示"，而在**它会把什么写进库**：
// 桌面版整库一个 JSON、云同步载荷也是整库，一张原图 base64 进去就是几 MB。
// 所以这里重点测「收不收」「怎么裁」「没图时用什么」这三件确定性的事 ——
// 画布那一段在 Node 里跑不了，取景框的算术才是容易错的地方。
import {
  AVATAR_SIZE, AVATAR_MAX_INPUT_BYTES,
  isAcceptableAvatar, fitSquare, avatarLabel,
} from '../src/lib/media/imageAvatar'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function main() {
  // ---------- 1) 输入体检 ----------
  {
    ok('普通 PNG 通过', isAcceptableAvatar({ size: 200_000, type: 'image/png' }).ok)
    ok('JPEG 通过', isAcceptableAvatar({ size: 200_000, type: 'image/jpeg' }).ok)
    ok('WebP / GIF 通过',
      isAcceptableAvatar({ size: 1000, type: 'image/webp' }).ok && isAcceptableAvatar({ size: 1000, type: 'image/gif' }).ok)
    ok('非图片被拒（并给出能看懂的说明）', (() => {
      const r = isAcceptableAvatar({ size: 1000, type: 'application/pdf' })
      return r.ok === false && !!r.reason && r.reason.includes('图片')
    })())
    ok('没有 type 也被拒', isAcceptableAvatar({ size: 1000, type: '' }).ok === false)
    ok('空文件被拒', (() => {
      const r = isAcceptableAvatar({ size: 0, type: 'image/png' })
      return r.ok === false && !!r.reason
    })())
    ok('正好 4MB 通过（边界含）', isAcceptableAvatar({ size: AVATAR_MAX_INPUT_BYTES, type: 'image/png' }).ok)
    ok('超过 4MB 被拒（提示里写明上限）', (() => {
      const r = isAcceptableAvatar({ size: AVATAR_MAX_INPUT_BYTES + 1, type: 'image/png' })
      return r.ok === false && !!r.reason && r.reason.includes('4MB')
    })())
  }

  // ---------- 2) 居中裁方（不拉伸） ----------
  {
    const wide = fitSquare(1000, 400)
    ok('横图：取中间横条', wide.size === 400 && wide.sx === 300 && wide.sy === 0, JSON.stringify(wide))
    const tall = fitSquare(400, 1000)
    ok('竖图：取中间竖条', tall.size === 400 && tall.sx === 0 && tall.sy === 300, JSON.stringify(tall))
    const square = fitSquare(500, 500)
    ok('正方图：原样取', square.size === 500 && square.sx === 0 && square.sy === 0, JSON.stringify(square))
    const odd = fitSquare(101, 400)
    ok('奇数尺寸取整不越界', odd.size === 101 && odd.sx === 0 && odd.sy === 149, JSON.stringify(odd))
    const zero = fitSquare(0, 0)
    ok('0 尺寸兜底成 1（不抛也不产生 0 画布）', zero.size === 1 && zero.sx === 0 && zero.sy === 0, JSON.stringify(zero))
    const nan = fitSquare(NaN, NaN)
    ok('NaN 兜底成 1', nan.size === 1, JSON.stringify(nan))
    const tiny = fitSquare(1, 3000)
    ok('极端细长也不算出负数', tiny.size === 1 && tiny.sx === 0 && tiny.sy === 1499, JSON.stringify(tiny))
    ok('输出目标边长是 256（改它要同步改注释里的理由）', AVATAR_SIZE === 256, String(AVATAR_SIZE))
  }

  // ---------- 3) 没图时的回退字符 ----------
  // 2026-09-17 审计：这段原先测的是一个「只取首字」的旧函数，它已被 `avatarLabel`
  // 取代（老大 2026-09-15 反馈：只取首字时「苏念 / 苏晴」头像一模一样）并删除。
  // 回退字符的断言全部归到下面 3b，不再两套并存。

  // ---------- 3b) 头像兜底显示的是**名字**而不是姓氏（老大 2026-09-15 反馈） ----------
  // 起因：只取首字时「苏念 / 苏晴」在同一场戏里头像一模一样，分不清谁在说。
  {
    ok('两字名 → 整个名字', avatarLabel('苏念') === '苏念' && avatarLabel('洛汐') === '洛汐')
    ok('🔴 同姓不同名能区分开', avatarLabel('苏念') !== avatarLabel('苏晴'))
    ok('前后空格被忽略', avatarLabel('  苏念 ') === '苏念')
    ok('单字名照常', avatarLabel('王') === '王')
    ok('超长名截到 2 字（圆里塞不下 3 个字）', avatarLabel('欧阳清风') === '欧阳')
    ok('英文名截到 2 字符', avatarLabel('Alice') === 'Al')
    ok('空名 / null → ?', avatarLabel('') === '?' && avatarLabel('   ') === '?' && avatarLabel(undefined as unknown as string) === '?')
    ok('emoji 名字不被切半个字符', avatarLabel('🎭小丑') === '🎭小')
    ok('按字符数而非码元切（emoji 名字不会被切半个）',
      Array.from(avatarLabel('🎭小丑')).length === 2)
  }

  console.log(`\ntavernAvatar: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
