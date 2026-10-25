import { ExternalLink, Heart, BookOpen, Users, Globe, Download, Copy, ArchiveRestore } from 'lucide-react'
import payWechat from '@/assets/pay-wechat.png'
import payAlipay from '@/assets/pay-alipay.jpg'
import authorAvatar from '@/assets/author-avatar.png'
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { copyText, showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import UpdateDialog from '@/components/app/UpdateDialog'
import MigrationWizard from '@/components/app/MigrationWizard'
import { probeLegacy, type LegacyProbe } from '@/lib/storage/legacyMigration'
import { QUARK_URL, QUARK_CODE, QUARK_TOKEN, GITEE_RELEASES_URL, WEB_APP_URL } from '@/lib/app/downloadLinks'
import { checkUpdate, isAutoCheckOn, setAutoCheck, type LatestRelease } from '@/lib/app/versionCheck'
import { PORTABLE } from '@/lib/storage/fileBackend'
// 网页版（云端 / 游客）在文案上必须与桌面版、便携版分开；`WEB` 为真时优先走网页措辞
import { WEB } from '@/lib/app/platform'
import { usePersistedBool } from '@/lib/settings/uiPrefs'
import { collectDiagnostics } from '@/lib/app/diagnostics'

// 关于 / 打赏页：作者 = 铁骨咸鱼（AI 不占版面）。
const BILI_URL = 'https://b23.tv/zl4vqyw'
const BILI_NAME = '铁骨咸鱼'

// 致谢名单（支持者墙）—— 按打赏时间排序，由作者手工维护：新打赏者追加到数组末尾即可，数组顺序＝展示顺序
const THANKS: string[] = [
  '神秘鱼老师',
  'Ryan',
  '神秘佑老师',
  '相念',
  '神秘Ba老师',
  '羽龙雨',
  '飞某',
  '浑身是刺全身是毒',
  'stargazerreimu',
  '神秘幕老师',
  '神秘亚老师',
]

// 联系方式（导出供本地数据提醒弹窗复用，避免两处各写一份导致不同步）
const CONTACT_LINKS = [
  { label: '青春幻想引擎交流群', value: '1106815480' },
  { label: '作者 QQ', value: '1822304733' },
  { label: '公众号', value: '咸鱼哥的双线人生' },
]

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-ink-100 mb-4 flex items-center gap-2">
      <span className="w-1 h-4 bg-amber rounded-full" />
      {icon}
      {children}
    </h2>
  )
}

export default function AboutPage() {
  // 检查更新（2.6.3）：手动按钮 + 「启动时自动检查」开关（默认开）
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ hasUpdate: boolean; latest: LatestRelease | null; skipped?: boolean } | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [autoCheck, setAuto] = usePersistedBool('update-auto-check', isAutoCheckOn())
  // 诊断信息（2026-10-06 补 · 可观测性）：反馈问题时一键复制环境与规模摘要
  const [diagBusy, setDiagBusy] = useState(false)
  // 3.0 · W0-2：旧版数据迁移（首启向导之外的**手动入口**，幂等，可反复跑）
  const [migProbe, setMigProbe] = useState<LegacyProbe | null>(null)
  /** 探测旧版数据 → 有则弹迁移向导；没有则如实告知（不静默） */
  const openLegacyImport = async () => {
    const pr = await probeLegacy()
    // 🔴 先报「探测失败」再报「没找到」—— 失败与没有是两回事（2026-10-12 全量审计 P2）
    if (pr.error) { showToast(`探测旧版数据失败：${pr.error}`, 'error'); return }
    if (!pr.exists) { showToast('未找到旧版（novel-studio）的数据目录', 'info'); return }
    if (!pr.jsonExists && !pr.idbExists) { showToast('旧版目录存在，但没有可导入的数据', 'info'); return }
    setMigProbe(pr)
  }

  const runCheck = async () => {
    setChecking(true)
    try {
      const r = await checkUpdate(true)   // 手动：不受「每天一次」节流限制
      setResult({ hasUpdate: r.hasUpdate, latest: r.latest, skipped: r.skipped })
      if (r.hasUpdate) setDialogOpen(true)
    } finally {
      setChecking(false)
    }
  }

  /**
   * 复制诊断信息：版本 / 系统 / 数据规模 / AI 配置概况。
   * 🔴 内容口径见 `lib/diagnostics.ts` 顶部三条红线 —— 不含作品内容、密钥、文件路径。
   */
  const copyDiag = async () => {
    setDiagBusy(true)
    try {
      await copyText(await collectDiagnostics(), '诊断信息已复制，粘贴给作者即可')
    } finally {
      setDiagBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <UpdateDialog open={dialogOpen} latest={result?.latest ?? null} onClose={() => setDialogOpen(false)} />
      {/* 3.0 · W0-2：旧版数据迁移向导（手动入口触发） */}
      {migProbe && <MigrationWizard probe={migProbe} onClose={() => setMigProbe(null)} />}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold text-ink-50">关于打赏</h1>
          <HelpPopover title="这一页是什么" side="right">
            {WEB
              ? '介绍本作与作者、友情链接，以及支持作者的方式。\n\n· 致谢名单按打赏时间排序，随打赏持续更新；\n· 页面图文与链接均为内置静态资源；网页版不做任何版本检查。'
              : PORTABLE
                ? '介绍本作与作者、友情链接，以及支持作者的方式。\n\n· 致谢名单按打赏时间排序，随打赏持续更新；\n· 页面图文与链接均为内置静态资源；便携版不做任何联网检查。'
                : '介绍本作与作者、友情链接，以及支持作者的方式。\n\n· 致谢名单按打赏时间排序，随打赏持续更新；\n· 页面图文与链接均为内置静态资源；会联网的只有版本检查 —— 手动点「检查更新」，以及默认开启的「启动时自动检查」（可在本页关掉）。'}
          </HelpPopover>
        </div>
        <p className="text-ink-400 text-sm mb-8">
          关于「青春幻想引擎」（<span className="tracking-wide text-ink-500">Youth Fantasy Engine</span>）与它的作者，以及支持作者的方式。
        </p>

        {/* 主体：左列（作者信息 + 友情链接） / 右列（打赏支持，拉长对齐）。
            lg 下给定最小高度，两列 items-stretch 等高，多出的空间由 flex-1 区块自然留白 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch lg:min-h-[620px]">
          {/* 左列：作者信息 + 友情链接 */}
          <div className="lg:col-span-1 flex flex-col gap-6">
            {/* 作者信息 */}
            <section className="rounded-xl bg-ink-850 border border-ink-700 p-6">
              <SectionTitle icon={<BookOpen size={15} className="text-amber" />}>作者信息</SectionTitle>
              <div className="flex flex-col items-center text-center">
                <img
                  src={authorAvatar}
                  alt="铁骨咸鱼"
                  className="w-24 h-24 rounded-full border border-ink-700 object-cover mb-3"
                />
                <div className="text-lg font-semibold text-ink-50">铁骨咸鱼</div>
                <p className="text-ink-400 text-xs mt-2 leading-relaxed">
                  在你的世界中讲述你的故事（B站主页有软件使用的视频教程，欢迎加群交流分享或反馈Bug）
                </p>
                <a
                  href={BILI_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 mt-4 rounded-lg bg-ink-800 border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:border-amber/40 hover:text-amber transition-colors"
                >
                  <ExternalLink size={16} /> {BILI_NAME} 的 B 站主页
                </a>
              </div>
            </section>

            {/* 跨版本指引（2026-10-18）：网页版 ⇄ 桌面版 / 便携版互导。
                三端是同一款软件的不同用法，用户往往先接触网页版再想装到电脑上（或反过来），
                这里给一条明确的往返路径，并说明「换版本不会丢稿」——那句最能打消顾虑。 */}
            <section className="rounded-xl bg-ink-850 border border-ink-700 p-6">
              <SectionTitle icon={<Globe size={15} className="text-amber" />}>
                {WEB ? '装到电脑上用' : '在浏览器里用'}
              </SectionTitle>
              {WEB ? (
                <>
                  <p className="text-ink-400 text-xs leading-relaxed mb-3">
                    网页版免安装，换台电脑登录就能接着写。若想要离线使用、导出 PDF、更换应用图标等桌面能力，
                    可下载桌面版或便携版 —— 三者数据格式一致，可以互相搬。
                  </p>
                  <ul className="mb-4 space-y-1.5 text-11 text-ink-400 leading-relaxed">
                    <li>· <span className="text-ink-200">桌面版</span>：Windows 安装包，功能最全，支持自动更新</li>
                    <li>· <span className="text-ink-200">便携版</span>：免安装压缩包，放 U 盘里带走，目录里的 data 就是全部数据</li>
                  </ul>
                  <a
                    href={GITEE_RELEASES_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-12 text-ink-200 transition-colors hover:border-amber/50 hover:text-amber"
                  >
                    <Download size={13} /> 前往 Gitee 下载 <ExternalLink size={11} />
                  </a>
                  <p className="mt-3 text-10 leading-relaxed text-ink-500">
                    换版本不会丢稿：先在左下角「云端存储」导出 JSON，再到桌面版「导入数据文件」即可。
                  </p>
                </>
              ) : (
                <>
                  <p className="text-ink-400 text-xs leading-relaxed mb-3">
                    不想安装、或者想换台设备直接用？网页版打开即用，界面与功能和桌面版一致。
                  </p>
                  <ul className="mb-4 space-y-1.5 text-11 text-ink-400 leading-relaxed">
                    <li>· <span className="text-ink-200">注册账号</span>（打赏用户凭邀请码）：数据存云端，多设备可用</li>
                    <li>· <span className="text-ink-200">游客试用</span>：无需注册，数据只存本机浏览器，请自行导出备份</li>
                  </ul>
                  <a
                    href={WEB_APP_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-12 text-ink-200 transition-colors hover:border-amber/50 hover:text-amber"
                  >
                    <Globe size={13} /> 打开网页版 <ExternalLink size={11} />
                  </a>
                  <p className="mt-3 text-10 leading-relaxed text-ink-500">
                    地址：<span className="font-mono text-ink-400">{WEB_APP_URL}</span>
                  </p>
                </>
              )}
            </section>

            {/* 获取最新版本：只给网盘链接 + 版本号，不联网检测 */}
            {QUARK_URL && (
              <section className="rounded-xl bg-ink-850 border border-ink-700 p-6">
                <SectionTitle icon={<Download size={15} className="text-amber" />}>获取最新版本</SectionTitle>
                <p className="text-ink-400 text-xs leading-relaxed mb-4">
                  当前版本 <span className="text-ink-100 font-medium">{APP_VERSION_LABEL}</span>
                  。新版本安装包发布在下方网盘，更新公告同步发在 B 站主页、公众号与 QQ 交流群——
                  若社交平台看到更新公告，可来此获取最新版。
                </p>
                {/* 安装权限提示：旧版按机器安装(Program Files)需先管理员升级一次，迁移为当前用户安装后重装免管理员。
                    🔴 网页版看不到安装包，这段 Windows 权限说明对它纯属噪音 ⇒ WEB 时隐藏。 */}
                {/* 🔴 仅安装版显示：便携版是解压即用、网页版无安装器，都不存在「管理员升级」这件事 */}
                {!WEB && !PORTABLE && (
                  <div className="mt-4 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2.5 text-11 text-ink-200 leading-relaxed">
                    <span className="font-medium text-amber">安装提示：</span>
                    若你电脑上已安装过旧版（装在 C 盘「Program Files」目录下），请先用「右键 → 以管理员身份运行」打开本安装包完成一次升级；升级后会迁移为「当前用户安装」，之后重装都不再需要管理员权限。
                  </div>
                )}
                {/* 检查更新：查 Gitee 上的最新 Release（只提示、不下载、不安装） */}
                {/* 🔴 2026-10-13 · 便携版不显示这一组控件：便携版跑在浏览器里、没有安装器，
                    查到新版本也无法自动更新（只会弹一个作者做不到的提示），
                    且「使用说明」已写明便携版没有自动更新检查。改为静态指引。 */}
                {WEB ? (
                  <p className="mt-4 text-11 text-ink-400 leading-relaxed">
                    网页版<strong className="text-ink-300">不需要更新</strong>：刷新页面即加载最新版本。
                    想离线使用、或需要导出 PDF / 更换应用图标等桌面能力，可到发布页下载桌面版 ——
                    数据可以在「云端存储」里导出成 JSON，再导入桌面版，稿件不会丢。
                  </p>
                ) : PORTABLE ? (
                  <p className="mt-4 text-11 text-ink-400 leading-relaxed">
                    便携版<strong className="text-ink-300">不提供在线更新</strong>：有新版本时请到发布页下载新的便携版压缩包，
                    解压后把旧目录里的 <span className="font-mono text-ink-300">data</span> 文件夹拷进新目录即可 —— 稿件不会丢。
                  </p>
                ) : (
                  <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Button variant="secondary" disabled={checking} onClick={() => void runCheck()} className="gap-1.5">
                      <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
                      {checking ? '检查中…' : '检查更新'}
                    </Button>
                    <label className="flex items-center gap-1.5 text-11 text-ink-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={autoCheck}
                        onChange={e => { setAuto(e.target.checked); setAutoCheck(e.target.checked) }}
                        className="accent-amber"
                      />
                      启动时自动检查
                    </label>
                    {result && !checking && (
                      <span className="text-11 text-ink-500">
                        {result.hasUpdate
                          ? `有新版本 v${result.latest?.version}`
                          : result.skipped
                            ? `已跳过 v${result.latest?.version}（有新版本，但你选过跳过）`
                            : result.latest
                              ? '已是最新版本'
                              : '暂时查不到版本信息'}
                      </span>
                    )}
                  </div>
                )}

                {/* 下载入口排：原先是紧贴上一排的（这个 div 没有 mt）⇒ 两排按钮视觉上黏成一坨。
                    现在 mt-4 + pt-4 + 细分隔线分组；<a> 也改成与 Button md 同一套尺寸口径
                    （h-9 px-4 text-13 —— 原来是 py-2 text-sm，与旁边 Button 差 2px 高 / 1px 字号，并排不齐） */}
                <div className="mt-4 pt-4 border-t border-ink-700/60 flex flex-wrap gap-2.5">
                  <a
                    href={QUARK_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg bg-amber text-13 font-medium text-ink-950 hover:opacity-90 transition-opacity"
                  >
                    <ExternalLink size={15} /> 打开网盘下载
                  </a>
                  <Button
                    variant="secondary"
                    onClick={() => copyText(QUARK_TOKEN, '已复制 APP 口令，打开夸克 APP 即可识别')}
                    className="gap-2"
                  >
                    <Copy size={15} /> 复制 APP 口令
                  </Button>
                </div>
                {/* 提取码：网页端 URL 已带 pwd 可自动填，但手机端 / 客户端常需手填，故单独明示 */}
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-11 text-ink-500">提取码</span>
                  <code className="rounded bg-ink-900/60 border border-ink-700 px-2 py-0.5 text-xs text-ink-100 tracking-wider">
                    {QUARK_CODE}
                  </code>
                  <Button
                    variant="bare"
                    size="xs"
                    onClick={() => copyText(QUARK_CODE, '提取码已复制')}
                    className="gap-1 text-11 text-ink-400 hover:text-amber"
                  >
                    <Copy size={12} /> 复制
                  </Button>
                </div>
                <p className="mt-3 text-11 text-ink-500 leading-relaxed">
                  若链接失效或提取码有误，请加 <span className="text-ink-300">QQ 交流群</span> 或关注公众号获取最新地址。
                </p>
              </section>
            )}

            {/* 3.0 · W0-2：旧版数据迁移（手动入口；首启向导之外，幂等可反复跑） */}
            <section className="rounded-xl bg-ink-850 border border-ink-700 p-6">
              <SectionTitle icon={<ArchiveRestore size={15} className="text-amber" />}>旧版数据迁移</SectionTitle>
              <p className="text-ink-400 text-xs leading-relaxed mb-4">
                若你之前用过旧版（novel-studio），可在这里把旧版的书稿、向量索引与知识库一次性导入到本软件。
              </p>
              <Button variant="secondary" onClick={() => void openLegacyImport()} className="gap-1.5">
                <ArchiveRestore size={14} /> 导入旧版数据
              </Button>
            </section>

            {/* 联系方式（flex-1 撑满左列剩余高度） */}
            <section className="rounded-xl bg-ink-850 border border-ink-700 p-6 flex-1">
              <SectionTitle icon={<Globe size={15} className="text-amber" />}>联系方式</SectionTitle>
              <ul className="space-y-3">
                {CONTACT_LINKS.map(l => (
                  <li key={l.label} className="flex flex-col">
                    <span className="text-11 text-ink-500">{l.label}</span>
                    <span className="text-sm text-ink-200">{l.value}</span>
                  </li>
                ))}
              </ul>

              {/* 诊断信息（2026-10-06 补）：反馈问题时附上这段，省去来回问「什么系统 / 多少章 / 哪个版本」 */}
              <div className="mt-4 pt-4 border-t border-ink-700">
                <Button variant="secondary" size="sm" disabled={diagBusy} onClick={() => void copyDiag()} className="gap-1.5">
                  <Copy size={13} />
                  {diagBusy ? '采集中…' : '复制诊断信息'}
                </Button>
                <p className="mt-2 text-10 leading-relaxed text-ink-500">
                  反馈问题时附上这段：版本、系统、数据规模与 AI 配置概况。
                  不含任何作品内容、密钥与文件路径，可放心粘贴。
                </p>
              </div>
            </section>
          </div>

          {/* 右列：打赏支持（上＝收款码，下＝致谢名单；名单下方留白，供以后加人）
              布局口径（2026-10-05 主人定稿）：
                · 收款码紧贴标题下方，**高度贴合内容**（不再 flex-1 撑满 —— 那会让码被拉高、
                  上下留大片空白，正是主人要回退的那版）；
                · 致谢名单排在码下方；名单下方**刻意留白**（`flex-1` 空占位吸收剩余高度），
                  以后加人自然向下生长，不会顶动上面的码；
                · 底部对齐由外层 grid 的 `items-stretch` 保证（左列「联系方式」flex-1 撑满）。 */}
          <section className="lg:col-span-2 rounded-xl bg-ink-850 border border-ink-700 p-6 flex flex-col">
            <SectionTitle icon={<Heart size={15} className="text-amber" />}>打赏支持</SectionTitle>
            <p className="text-ink-500 text-xs mb-5">
              如果本软件对你有帮助，欢迎扫码支持作者。
            </p>

            {/* 码图区：宽度撑满、高度由 2:3 纵横比自然定出（两码等宽等高、并排居中）。
                完整收款图自带品牌底色，可一眼分辨归属，无需文字标注 */}
            <div className="grid grid-cols-2 gap-4">
              {[
                { key: 'wechat', img: payWechat },
                { key: 'alipay', img: payAlipay },
              ].map(p => (
                <div key={p.key} className="rounded-lg bg-ink-900/60 border border-ink-700 p-3 flex items-center justify-center overflow-hidden">
                  <img
                    src={p.img}
                    alt={`${p.key === 'wechat' ? '微信' : '支付宝'}收款码`}
                    className="w-full aspect-[2/3] object-contain rounded-md"
                  />
                </div>
              ))}
            </div>

            {/* 致谢名单（排在码下方） */}
            <div className="pt-5 mt-5 border-t border-ink-700">
              <h3 className="text-xs font-semibold text-ink-200 mb-1 flex items-center gap-2">
                <Users size={14} className="text-amber" /> 致谢名单
              </h3>
              <p className="text-ink-500 text-11 mb-3">
                致谢名单按照打赏时间排序，您的支持是我持续更新和维护项目的最大动力！
              </p>
              <div className="flex flex-wrap gap-2 content-start">
                {THANKS.map(name => (
                  <span
                    key={name}
                    className="inline-flex items-center rounded-full bg-ink-800 border border-ink-700 px-3 py-1 text-xs text-ink-100"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>

            {/* 名单下方留白：吸收右列剩余高度（空占位，不渲染任何可见内容）——
                底部对齐靠它 + 外层 items-stretch 共同保证 */}
            <div className="flex-1" aria-hidden />
          </section>
        </div>
      </div>
    </div>
  )
}
