// ============ 3.3.0 · UX08：设定检索内联改字段的「算不算存上了」 ============
//
// 这段判据来自一个真实的假成功：目标记录已经不在了（一个字都没写进去），
// 旧实现照样刷新索引并收起编辑器，作者看到界面回到新值就以为改好了。
//
// ① 纯逻辑：written=true 才算成功；抛错给可读原因；记录不存在给「没有写入」；
// ② 源码静态闸：组件只能通过 describeFieldSave 判定，不许自己再写一套 if/else。
import fs from 'node:fs'
import path from 'node:path'
import { describeFieldSave, FIELD_SAVE_MISSING } from '../src/lib/settings/fieldSaveOutcome'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 判定 ----------
{
  const okDone = describeFieldSave({ written: true })
  ok('🔴 ① 真的写进去了才算成功', okDone.ok === true)

  const missing = describeFieldSave({ written: false })
  ok('🔴 ① 记录不存在 ⇒ 明确说没写入', missing.ok === false && missing.kind === 'missing')
  ok('🔴 ① 记录不存在的文案不含「已保存」', !String((missing as { message?: string }).message).includes('已保存'))
  ok('① 记录不存在的文案就是导出的常量（别处不会各写一套）',
    (missing as { message?: string }).message === FIELD_SAVE_MISSING)

  const failed = describeFieldSave({ written: false, error: new Error('QuotaExceededError') })
  ok('🔴 ① 写入抛错 ⇒ 未确认保存，并带上原因',
    failed.ok === false && failed.kind === 'failed'
      && String((failed as { message?: string }).message).includes('未确认保存')
      && String((failed as { message?: string }).message).includes('QuotaExceededError'))

  const failedRaw = describeFieldSave({ written: false, error: 'plain string failure' })
  ok('① 非 Error 的抛出物也能读（不炸、不吞）',
    failedRaw.ok === false && String((failedRaw as { message?: string }).message).includes('plain string failure'))

  // 写成功时不因为 error 字段而变失败（调用方可能在 finally 里带了无关信息）
  ok('🔴 ① written=true 时不被 error 覆盖成失败', describeFieldSave({ written: true, error: null }).ok === true)
}

// ---------- ② 源码静态闸 ----------
{
  const sheet = read('src/components/settings/SettingSearch.tsx')
  const code = sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  ok('🔴 ② 组件走统一判定（import describeFieldSave）',
    /import \{ describeFieldSave \} from '@\/lib\/settings\/fieldSaveOutcome'/.test(sheet))
  ok('🔴 ② 只有 outcome.ok 才刷新索引并收起编辑器',
    /if \(outcome\.ok\) \{ setReloadKey\(k => k \+ 1\); setEditing\(null\) \}/.test(code))
  ok('🔴 ② 失败时写进 fieldError（留在原地可读可重试）',
    /else setFieldError\(outcome\.message\)/.test(code))
  ok('🔴 ② 组件里不再自己拼「未确认保存」文案（判定只留一处）',
    !/未确认保存/.test(code))
  ok('🔴 ② 组件里不再自己拼「已经不在了」文案', !/已经不在了/.test(code))
  ok('🔴 ② 保存中状态一定被复位（成功/失败/早退都回到 false）',
    /setSavingField\(true\)[\s\S]{0,1200}setSavingField\(false\)/.test(code))
  ok('🔴 ② 目标记录找不到时不再静默往下走（written 必须是真写入才 true）',
    /written = true/.test(code) && !/if \(!written\) \{[\s\S]{0,80}setReloadKey/.test(code))
  ok('② 失败说明不是一闪而过的 toast（页面里有常驻 status 行）',
    /role="status"/.test(sheet))
}

console.log(`\n———— fieldSaveOutcome：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exitCode = 1
