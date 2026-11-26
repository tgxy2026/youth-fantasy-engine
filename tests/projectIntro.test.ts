// ============ 3.7.5 · 首页「作品简介」取值判据 ============
//
// 钉死四件事：
//   ① 《作品信息》两个简介字段都在时，**正式简介赢**；
//   ② 只有一个时，用有的那个（空串 / 纯空白当没填）；
//   ③ 两者都没有时回退项目记录上的旧 `intro` —— 示范项目、备份还原、老数据靠这条才不回退成「暂无简介」；
//   ④ 键名带前后缀（模板接管页签）也能认出来，非字符串脏值一律忽略。
import {
  INTRO_FIELD_FORMAL, INTRO_FIELD_ONE_LINE, ONE_LINE_INTRO_MAX, INTRO_TAB_ID,
  pickIntroFromForm, resolveProjectIntro,
} from '../src/lib/app/projectIntro'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 常量与页签字段对得上（防改名后悄悄失效）----------
ok('页签 id 是 positioning', INTRO_TAB_ID === 'positioning')
ok('字段名与《作品信息》页一致', INTRO_FIELD_FORMAL === '正式简介' && INTRO_FIELD_ONE_LINE === '一句话简介')
ok('一句话简介上限是 50 字', ONE_LINE_INTRO_MAX === 50)

// ---------- ① 两个都有 ⇒ 正式简介优先 ----------
{
  const form = { [INTRO_FIELD_ONE_LINE]: '废脉？我吞的就是天！', [INTRO_FIELD_FORMAL]: '测灵大典上少年被判废脉，当夜腕间胎记发烫。' }
  ok('两个都有 → 正式简介', pickIntroFromForm(form) === '测灵大典上少年被判废脉，当夜腕间胎记发烫。')
  ok('两个都有 → 不受键顺序影响', pickIntroFromForm({ [INTRO_FIELD_FORMAL]: 'A', [INTRO_FIELD_ONE_LINE]: 'B' }) === 'A')
}

// ---------- ② 只有一个 ----------
ok('只有一句话简介 → 用它', pickIntroFromForm({ [INTRO_FIELD_ONE_LINE]: '  废脉？我吞的就是天！  ' }) === '废脉？我吞的就是天！')
ok('只有正式简介 → 用它', pickIntroFromForm({ [INTRO_FIELD_FORMAL]: '正式简介内容' }) === '正式简介内容')
ok('正式简介是空白 → 退到一句话简介', pickIntroFromForm({ [INTRO_FIELD_FORMAL]: '   ', [INTRO_FIELD_ONE_LINE]: '一句话' }) === '一句话')
ok('两个都是空白 → 空串', pickIntroFromForm({ [INTRO_FIELD_FORMAL]: ' \n ', [INTRO_FIELD_ONE_LINE]: '\t' }) === '')
ok('空表单 → 空串', pickIntroFromForm({}) === '')
ok('undefined → 空串', pickIntroFromForm(undefined) === '' && pickIntroFromForm(null) === '')

// ---------- ③ 回退项目记录上的旧 intro ----------
ok('表单没填 → 回退旧 intro（示范项目）', resolveProjectIntro({}, '废脉？我吞的就是天！') === '废脉？我吞的就是天！')
ok('表单没填且旧 intro 带空格 → trim', resolveProjectIntro({}, '  旧简介  ') === '旧简介')
ok('表单没填且旧 intro 也没有 → 空串（界面给兜底提示）', resolveProjectIntro({}, '') === '' && resolveProjectIntro({}, undefined) === '')
ok('表单有值 ⇒ 旧 intro 不覆盖它', resolveProjectIntro({ [INTRO_FIELD_ONE_LINE]: '新的一句' }, '旧的一句') === '新的一句')

// ---------- ④ 键名兜底与脏值 ----------
{
  const form = { '简介与物料·正式简介': '模板前缀版' }
  ok('键名带前缀也认得出', pickIntroFromForm(form) === '模板前缀版')
  const dirty = { [INTRO_FIELD_FORMAL]: 123, [INTRO_FIELD_ONE_LINE]: '真话' }
  ok('非字符串脏值不参与，退到一句话简介', pickIntroFromForm(dirty) === '真话')
  ok('只有脏值 → 空串', pickIntroFromForm({ [INTRO_FIELD_FORMAL]: { text: 'x' } }) === '')
}

// ---------- 回归：不要让「正式简介」误命中「一句话简介」 ----------
{
  // 一句话简介里含「简介」二字是常识性陷阱：若实现用 `includes('正式简介')` 之外还写了宽松的
  // 「含简介就算」，这里就会串。这条守住"只认这两个字段"。
  const form = { '作品简介': '第三个别名字段', [INTRO_FIELD_ONE_LINE]: '一句话' }
  ok('其它含「简介」的字段不抢位', pickIntroFromForm(form) === '一句话')
}

console.log(`\nprojectIntro: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
