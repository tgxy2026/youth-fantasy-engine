/**
 * 3.0 · W0-2 首启迁移向导
 *
 * 首启探测到旧版（novel-studio）数据时弹出：说明 → 一键导入 → 报告 + 卸载旧版引导。
 *
 * 🔴 三条纪律：
 *   ① 一切由作者**显式点「导入」**触发（呼应「AI 只辅助、作者主导」项目红线），绝不静默搬数据；
 *   ② 只做「旧品牌值 → 新品牌值」的搬运 + 如实报告，**不改造内容**；
 *   ③ 「暂不导入」随时可退 —— 之后还能从「设置 → 数据」再导。
 */
import { useState } from 'react'
import {
  Database, BookOpen, SlidersHorizontal, AlertTriangle, CheckCircle2,
  Loader2, Trash2, ArrowRight, ShieldQuestion,
} from 'lucide-react'
import { Button } from './Button'
import { showToast } from './dialogs'
import { Z } from '../lib/zLayer'
import { runLegacyMigration, migrationApi, type LegacyProbe, type MigrationReport } from '../lib/legacyMigration'

interface Props {
  /** 主进程探测到的旧版数据概况 */
  probe: LegacyProbe
  /** 向导结束（导入完成 / 用户跳过）→ 通知调用方继续正常流程 */
  onClose: () => void
}

type Step = 'intro' | 'running' | 'done'

export default function MigrationWizard({ probe, onClose }: Props) {
  const [step, setStep] = useState<Step>('intro')
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [uninstallHits, setUninstallHits] = useState<{ dir: string; uninstaller: string }[]>([])
  const [uninstallBusy, setUninstallBusy] = useState(false)

  /** 点「导入」→ 跑完整迁移 */
  const runImport = async () => {
    setStep('running')
    try {
      const r = await runLegacyMigration()
      setReport(r)
      setStep('done')
    } catch (e) {
      showToast('导入过程出错：' + (e instanceof Error ? e.message : String(e)), 'error', 6000)
      setStep('done')
      setReport({
        json: { ok: false, error: String(e instanceof Error ? e.message : e) },
        vec: { ok: false, count: 0 }, kb: { ok: false, count: 0 },
        mainDb: { ok: false }, profile: { ok: false, copied: [] },
      })
    }
  }

  /** 查旧版卸载器（尽力而为）→ 有则拉起，无则提示手动卸载 */
  const handleUninstall = async () => {
    const api = migrationApi()
    if (!api) return
    setUninstallBusy(true)
    try {
      const found = await api.findUninstaller()
      if (found.ok && found.hits.length > 0) {
        setUninstallHits(found.hits)
        const r = await api.runUninstaller(found.hits[0].uninstaller)
        if (!r.ok) showToast('拉起卸载器失败：' + (r.error || '未知原因') + '，请到「设置 → 应用」手动卸载', 'error', 6000)
      } else {
        setUninstallHits([])
        showToast('没找到旧版卸载程序，请到系统「设置 → 应用 → 已安装的应用」里手动卸载「青春幻想引擎（旧版）」', 'info', 8000)
      }
    } finally {
      setUninstallBusy(false)
    }
  }

  /**
   * 「开始使用」：整库 JSON 导入成功 → `location.reload()` 让新数据立即生效；
   * 否则（仅搬了 IDB / 作者跳过 JSON）直接关闭即可。
   */
  const startUsing = () => {
    if (report?.json.ok) { location.reload(); return }
    onClose()
  }

  /** 把探测结果转成「将要导入什么」的清单 */
  const items = [
    { key: 'json', icon: <BookOpen size={15} className="text-amber" />, title: '书稿与全部设定', desc: '项目、章节、设定表、角色卡、酒馆内容（整库数据文件）', ok: probe.jsonExists === true },
    { key: 'idb', icon: <Database size={15} className="text-info" />, title: '向量索引 + 知识库', desc: '语义检索索引与「参考资料」文档（独立数据库）', ok: probe.idbExists === true },
    { key: 'profile', icon: <SlidersHorizontal size={15} className="text-success" />, title: '界面偏好', desc: '界面缩放、主题、字体等本机偏好', ok: Object.values(probe.profile ?? {}).some(Boolean) },
  ]

  const jsonLine = report
    ? report.json.skipped
      ? { text: '已跳过（按你的选择）', ok: true }
      : report.json.ok
        ? { text: '已导入' + (report.json.remapped ? `（改写 ${report.json.remapped.app} 处品牌标识）` : ''), ok: true }
        : { text: '失败：' + (report.json.error || '未知原因'), ok: false }
    : null
  const vecLine = report ? (report.vec.ok ? `已迁移 ${report.vec.count} 条向量` : '失败：' + (report.vec.error || '')) : ''
  const kbLine = report ? (report.kb.ok ? `已迁移 ${report.kb.count} 篇资料` : '失败：' + (report.kb.error || '')) : ''
  const profileLine = report ? (report.profile.copied.length ? '已复制：' + report.profile.copied.join('、') : '无（或已存在，跳过）') : ''

  return (
    <div className="fixed inset-0 flex items-center justify-center p-6 bg-ink-950/70 backdrop-blur-sm" style={{ zIndex: Z.modal }}>
      <div className="w-full max-w-[620px] rounded-2xl bg-ink-850 border border-ink-700 shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="px-6 py-5 border-b border-ink-700/70">
          <h2 className="text-16 font-bold text-ink-50 flex items-center gap-2">
            {step === 'done'
              ? <><CheckCircle2 size={18} className="text-success" /> 导入完成</>
              : <><ShieldQuestion size={18} className="text-amber" /> 发现旧版数据</>}
          </h2>
          <p className="mt-1.5 text-12 text-ink-400 leading-relaxed">
            {step === 'done'
              ? '旧数据已迁移到新版。确认无误后，可卸载旧版本以释放空间。'
              : '检测到本机有旧版（novel-studio）的数据。可一次性导入到「青春幻想引擎」，导入后旧数据不会被动。'}
          </p>
        </div>

        {/* 主体 */}
        <div className="px-6 py-5">
          {step === 'intro' && (
            <div className="space-y-3">
              {items.map(it => (
                <div key={it.key} className="flex items-start gap-3 rounded-xl bg-ink-900/50 border border-ink-700/60 px-4 py-3">
                  <span className="mt-0.5">{it.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-13 font-medium text-ink-100">{it.title}</div>
                    <div className="text-11 text-ink-500 mt-0.5">{it.desc}</div>
                  </div>
                  <span className={`text-11 shrink-0 ${it.ok ? 'text-success' : 'text-ink-600'}`}>{it.ok ? '可导入' : '未检出'}</span>
                </div>
              ))}
              <div className="flex items-start gap-2 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2.5 text-11 text-ink-200 leading-relaxed mt-1">
                <AlertTriangle size={14} className="text-amber shrink-0 mt-0.5" />
                <span>建议先完成导入再卸载旧版。旧版数据仅能在 <b>3.0</b> 一次性导入；更晚的版本将不再识别旧数据。</span>
              </div>
            </div>
          )}

          {step === 'running' && (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 size={26} className="animate-spin text-amber" />
              <div className="text-13 text-ink-300">正在导入旧版数据…</div>
              <div className="text-11 text-ink-500">请勿关闭窗口</div>
            </div>
          )}

          {step === 'done' && report && (
            <div className="space-y-2.5">
              {[
                { label: '书稿与设定', line: jsonLine },
                { label: '向量索引', line: report.vec.ok ? { text: vecLine, ok: true } : { text: vecLine, ok: false } },
                { label: '知识库', line: report.kb.ok ? { text: kbLine, ok: true } : { text: kbLine, ok: false } },
                { label: '界面偏好', line: { text: profileLine, ok: true } },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between gap-3 rounded-lg bg-ink-900/50 border border-ink-700/60 px-3.5 py-2.5">
                  <span className="text-12 text-ink-300">{row.label}</span>
                  <span className={`text-11 text-right ${row.line && row.line.ok ? 'text-success' : 'text-danger'}`}>
                    {row.line ? row.line.text : '—'}
                  </span>
                </div>
              ))}
              {uninstallHits.length > 0 && (
                <div className="text-11 text-ink-500 mt-1">旧版安装目录：{uninstallHits[0].dir}</div>
              )}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-6 py-4 border-t border-ink-700/70 flex items-center justify-between gap-3">
          {step === 'intro' && (
            <>
              <Button variant="bare" onClick={onClose}>暂不导入</Button>
              <Button variant="primary" onClick={() => void runImport()} className="gap-1.5">
                <ArrowRight size={15} /> 导入旧版数据
              </Button>
            </>
          )}
          {step === 'running' && <Button variant="secondary" disabled>导入中…</Button>}
          {step === 'done' && (
            <>
              <Button variant="secondary" onClick={() => void handleUninstall()} disabled={uninstallBusy} className="gap-1.5">
                {uninstallBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                卸载旧版
              </Button>
              <Button variant="primary" onClick={startUsing}>开始使用</Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
