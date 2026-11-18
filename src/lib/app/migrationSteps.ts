/**
 * 首启迁移向导的结果映射与收尾动作（3.6.1 · B7 从 `MigrationWizard` 抽出）。
 *
 * 【为什么抽】迁移本体在 `lib/storage/legacyMigration`（已有测试），组件里容易错的是：
 *   ① 四行结果各自的「成功 / 失败 / 跳过」判定 —— 尤其「按你的选择跳过」**不是失败**，
 *      判成失败会让作者以为书稿没搬过来；
 *   ② 收尾动作：只有**整库 JSON 真导入成功**才 reload 让新数据生效，否则直接关闭
 *      （其余情况 reload 只会把作者刚看到的报告刷掉）。
 */
import type { MigrationReport } from '@/lib/storage/legacyMigration'

export interface MigrationReportRow {
  label: string
  text: string
  ok: boolean
}

/** 四行结果（顺序固定：书稿 → 向量 → 知识库 → 偏好） */
export function migrationReportRows(report: MigrationReport): MigrationReportRow[] {
  const json = report.json.skipped
    ? { text: '已跳过（按你的选择）', ok: true }
    : report.json.ok
      ? { text: '已导入' + (report.json.remapped ? `（改写 ${report.json.remapped.app} 处品牌标识）` : ''), ok: true }
      : { text: '失败：' + (report.json.error || '未知原因'), ok: false }
  const vec = report.vec.ok ? { text: `已迁移 ${report.vec.count} 条向量`, ok: true } : { text: '失败：' + (report.vec.error || ''), ok: false }
  const kb = report.kb.ok ? { text: `已迁移 ${report.kb.count} 篇资料`, ok: true } : { text: '失败：' + (report.kb.error || ''), ok: false }
  const profile = {
    text: report.profile.copied.length ? '已复制：' + report.profile.copied.join('、') : '无（或已存在，跳过）',
    ok: true,
  }
  return [
    { label: '书稿与设定', ...json },
    { label: '向量索引', ...vec },
    { label: '知识库', ...kb },
    { label: '界面偏好', ...profile },
  ]
}

/** 「开始使用」按钮该做什么：整库导入成功才 reload，否则只关闭向导 */
export function migrationStartAction(report: MigrationReport | null): 'reload' | 'close' {
  return report?.json.ok ? 'reload' : 'close'
}
