// ============ 三条锁定横幅 + 草稿保存反馈 + 迁移向导结果（3.6.1 · B7）============
//
// 这一组全是「说错一句话就会误导」的地方：
//   ① 数据文件锁定的解锁确认：必须说清「继续会覆盖原文件且无法恢复」；
//   ② 便携版 / 网页版横幅：网页版没有本地文件路径 ⇒ 主操作与备份指引都要换成云端口径；
//   ③ 迁移中横幅：单页签点名 / 多页签给个数，不能只说「有页签在迁移」；
//   ④ 草稿保存反馈：错误 > 正在提交 > 还有修改 > 已提交 > 不显示，优先级不能换；
//   ⑤ 迁移结果：**「按你的选择跳过」不是失败**，判成失败会让作者以为书稿没搬过来。
import { migrationLockSubject, portableWriteLockCopy, writeLockDiagnostics, writeLockUnlockPrompt } from '../src/lib/app/lockBannerCopy'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { draftSaveFeedbackOf, type DraftSaveFeedbackState } from '../src/lib/editor/draftSaveFeedback'
import { migrationReportRows, migrationStartAction } from '../src/lib/app/migrationSteps'
import type { MigrationReport } from '../src/lib/storage/legacyMigration'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const feedback = (over: Partial<DraftSaveFeedbackState> = {}) =>
  draftSaveFeedbackOf({ error: '', saving: false, submitted: false, dirty: false, ...over })

const report = (over: Partial<MigrationReport> = {}): MigrationReport => ({
  json: { ok: true },
  vec: { ok: true, count: 12 },
  kb: { ok: true, count: 3 },
  mainDb: { ok: true },
  profile: { ok: true, copied: ['uiPrefs'] },
  ...over,
})

function main() {
  // ① 解锁确认
  {
    const prompt = writeLockUnlockPrompt('建议先备份。')
    ok('解锁确认标题问的是"要不要用当前内容继续"', prompt.title === '确定要用当前内容继续吗？', prompt.title)
    ok('说清内存里是空库或残缺数据', prompt.message.includes('空库或残缺数据'), prompt.message)
    ok('说清继续会覆盖原文件且无法恢复', prompt.message.includes('覆盖') && prompt.message.includes('无法恢复'), prompt.message)
    ok('带上本端给的备份指引', prompt.message.includes('建议先备份。'), prompt.message)
    ok('标为危险操作', prompt.danger === true)
  }

  // ② 便携版 / 网页版文案
  {
    const portable = portableWriteLockCopy(false)
    ok('便携版主语是「便携数据文件」', portable.subject === '便携数据文件', portable.subject)
    ok('便携版主操作是复制路径', portable.primaryLabel === '复制数据文件路径', portable.primaryLabel)
    ok('便携版备份指引提到复制数据文件', portable.backupHint.includes('复制一份备份'), portable.backupHint)
    const web = portableWriteLockCopy(true)
    ok('网页版主语换成云端数据', web.subject === '云端数据' && web.writeBackTo === '云端', JSON.stringify(web))
    ok('网页版主操作是导出全部数据', web.primaryLabel === '导出全部数据', web.primaryLabel)
    ok('网页版备份指引提到导出 JSON', web.backupHint.includes('JSON'), web.backupHint)
  }

  // ②·2 复制诊断信息（3.6.1）：让用户一句话就能把判断所需的信息发过来
  {
    const at = new Date(2026, 10, 19, 6, 55)
    const text = writeLockDiagnostics({
      subject: '数据文件', reason: '数据文件内容不是有效的 JSON（可能被云盘客户端同步截断，或磁盘损坏）',
      writeBackTo: '磁盘', dataPath: 'C:////Users////me////AppData////Roaming////youth-fantasy-engine////youth-fantasy-engine-data.json',
      pathKind: '自定义位置', appVersion: 'v3.5.6', platform: '桌面版', at,
    })
    ok('带时间（便于和云盘/断电时间对照）', text.includes('2026-11-19 06:55'), text.split('\n')[1])
    ok('带版本与平台', text.includes('v3.5.6') && text.includes('桌面版'))
    ok('带数据文件路径与「默认/自定义」', text.includes('youth-fantasy-engine-data.json') && text.includes('自定义位置'))
    ok('带原始锁定原因（不加工、不改写）', text.includes('不是有效的 JSON'))
    ok('说清当前是空库、不会写回磁盘', text.includes('空库') && text.includes('不会写回磁盘'))
    ok('🔴 明说不含正文（用户才敢直接发）', text.includes('不含正文'))
    ok('拿不到路径时给替代指引而不是空着',
      writeLockDiagnostics({ subject: '数据文件', reason: 'x', writeBackTo: '磁盘', dataPath: '', appVersion: 'v3.5.6', platform: '桌面版', at })
        .includes('打开数据文件夹'))
  }

  // ②·3 源码闸：横幅真的挂了这个按钮，且解锁按钮把后果写进了名字
  {
    const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')
    const banner = read('src/components/app/WriteLockBanner.tsx')
    ok('横幅有「复制诊断信息」按钮', banner.includes('复制诊断信息'))
    ok('🔴 解锁按钮直说后果（不叫「仍用当前内容继续」）',
      banner.includes('放弃原文件继续') && !banner.includes('仍用当前内容继续'))
    ok('按钮上有"会覆盖、无法恢复"的悬停说明', banner.includes('无法恢复'))
    const desktop = read('src/components/app/DesktopWriteLockBanner.tsx')
    const portable = read('src/components/app/PortableWriteLockBanner.tsx')
    ok('桌面横幅传入了诊断信息（含默认/自定义位置）',
      desktop.includes('diagnosticsText') && desktop.includes('pathKind'))
    ok('便携横幅传入了诊断信息', portable.includes('diagnosticsText'))
  }

  // ③ 迁移横幅主语
  {
    ok('单页签点名', migrationLockSubject(['角色卡']) === '「角色卡」', migrationLockSubject(['角色卡']))
    ok('多页签给个数与全名', migrationLockSubject(['角色卡', '设定表']) === '2 个页签（角色卡、设定表）', migrationLockSubject(['角色卡', '设定表']))
  }

  // ④ 草稿保存反馈的优先级
  {
    ok('有错误时先说错误', feedback({ error: '保存未完成', saving: true }).kind === 'error')
    ok('错误态文本就是错误原文', feedback({ error: '保存未完成' }).text === '保存未完成')
    ok('正在提交优先于"还有修改"', feedback({ saving: true, dirty: true }).kind === 'submitting')
    ok('还有修改待保存', feedback({ dirty: true }).kind === 'pending')
    ok('已提交时说明最终状态看存储区', feedback({ submitted: true }).text.includes('最终写入状态'))
    ok('三态都不成立时整行不显示', feedback().kind === 'hidden')
    ok('不显示时没有文案（不留空行）', feedback().text === '')
  }

  // ⑤ 迁移结果
  {
    const rows = migrationReportRows(report())
    ok('四行顺序固定', rows.map(r => r.label).join('>') === '书稿与设定>向量索引>知识库>界面偏好', rows.map(r => r.label).join('>'))
    ok('向量条数如实显示', rows[1].text === '已迁移 12 条向量', rows[1].text)
    ok('知识库篇数如实显示', rows[2].text === '已迁移 3 篇资料', rows[2].text)
    ok('偏好列出复制项', rows[3].text.includes('uiPrefs'), rows[3].text)
    const skipped = migrationReportRows(report({ json: { ok: false, skipped: true } }))[0]
    ok('按作者选择跳过不算失败', skipped.ok === true && skipped.text.includes('已跳过'), JSON.stringify(skipped))
    const failed = migrationReportRows(report({ json: { ok: false, error: '文件损坏' } }))[0]
    ok('真失败标红并带原因', failed.ok === false && failed.text.includes('文件损坏'), JSON.stringify(failed))
    const remapped = migrationReportRows(report({ json: { ok: true, remapped: { app: 5 } } as MigrationReport['json'] }))[0]
    ok('改写过品牌标识要如实写处数', remapped.text.includes('5 处'), remapped.text)
    const emptyProfile = migrationReportRows(report({ profile: { ok: true, copied: [] } }))[3]
    ok('偏好没复制时说明"或已存在，跳过"', emptyProfile.text.includes('跳过'), emptyProfile.text)
    ok('整库导入成功 → reload 让新数据生效', migrationStartAction(report()) === 'reload')
    ok('只跳过 → 关闭向导（不刷新掉报告）', migrationStartAction(report({ json: { ok: false, skipped: true } })) === 'close')
    ok('没有报告时按关闭处理', migrationStartAction(null) === 'close')
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} uiStatusCopy ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
