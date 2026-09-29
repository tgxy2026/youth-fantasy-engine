import { ExternalLink, Heart, BookOpen, Users, Globe, Download, Copy } from 'lucide-react'
import payWechat from '../assets/pay-wechat.png'
import payAlipay from '../assets/pay-alipay.jpg'
import authorAvatar from '../assets/author-avatar.png'
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { APP_VERSION_LABEL } from '../lib/env'
import { copyText } from './dialogs'
import { Button } from './Button'
import HelpPopover from './HelpPopover'
import UpdateDialog from './UpdateDialog'
import { QUARK_URL, QUARK_CODE, QUARK_TOKEN } from '../lib/downloadLinks'
import { checkUpdate, isAutoCheckOn, setAutoCheck, type LatestRelease } from '../lib/versionCheck'
import { usePersistedBool } from '../lib/uiPrefs'

// 关于 / 打赏页：作者 = 铁骨咸鱼（AI 不占版面）。
const BILI_URL = 'https://b23.tv/zl4vqyw'
const BILI_NAME = '铁骨咸鱼'

// 致谢名单（支持者墙）—— 示例占位：借用知名网络小说主角的名号排排站，后续由作者替换为真实读者 / 金主 / 贡献者记录
const THANKS: { name: string; work: string }[] = [
  { name: '萧炎', work: '斗破苍穹' },
  { name: '唐三', work: '斗罗大陆' },
  { name: '林动', work: '武动乾坤' },
  { name: '牧尘', work: '大主宰' },
  { name: '叶凡', work: '遮天' },
  { name: '石昊', work: '完美世界' },
  { name: '楚风', work: '圣墟' },
  { name: '韩立', work: '凡人修仙传' },
  { name: '王林', work: '仙逆' },
  { name: '孟浩', work: '我欲封天' },
  { name: '白小纯', work: '一念永恒' },
  { name: '方源', work: '蛊真人' },
  { name: '徐凤年', work: '雪中悍刀行' },
  { name: '陈平安', work: '剑来' },
  { name: '许七安', work: '大奉打更人' },
  { name: '宁毅', work: '赘婿' },
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

  return (
    <div className="h-full overflow-y-auto">
      <UpdateDialog open={dialogOpen} latest={result?.latest ?? null} onClose={() => setDialogOpen(false)} />
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold text-ink-50">关于打赏</h1>
          <HelpPopover title="这一页是什么" side="right">
            {'介绍本作与作者、友情链接，以及支持作者的方式。\n\n· 打赏名单暂为示例（借用了若干知名作品的角色名），后续会更新为真实记录；\n· 页面内容全部来自本项目内置的静态资源，不依赖任何在线服务。'}
          </HelpPopover>
        </div>
        <p className="text-ink-400 text-sm mb-8">
          关于「青春幻想引擎」与它的作者，以及支持作者的方式。
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

            {/* 获取最新版本：只给网盘链接 + 版本号，不联网检测 */}
            {QUARK_URL && (
              <section className="rounded-xl bg-ink-850 border border-ink-700 p-6">
                <SectionTitle icon={<Download size={15} className="text-amber" />}>获取最新版本</SectionTitle>
                <p className="text-ink-400 text-xs leading-relaxed mb-4">
                  当前版本 <span className="text-ink-100 font-medium">{APP_VERSION_LABEL}</span>
                  。新版本安装包发布在下方网盘，更新公告同步发在 B 站主页、公众号与 QQ 交流群——
                  若社交平台看到更新公告，可来此获取最新版。
                </p>
                {/* 安装权限提示：旧版按机器安装(Program Files)需先管理员升级一次，迁移为当前用户安装后重装免管理员 */}
                <div className="mt-4 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2.5 text-11 text-ink-200 leading-relaxed">
                  <span className="font-medium text-amber">安装提示：</span>
                  若你电脑上已安装过旧版（装在 C 盘「Program Files」目录下），请先用「右键 → 以管理员身份运行」打开本安装包完成一次升级；升级后会迁移为「当前用户安装」，之后重装都不再需要管理员权限。
                </div>
                {/* 检查更新：查 Gitee 上的最新 Release（只提示、不下载、不安装） */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
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

                <div className="flex flex-wrap gap-2">
                  <a
                    href={QUARK_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-amber px-3 py-2 text-sm font-medium text-ink-950 hover:opacity-90 transition-opacity"
                  >
                    <ExternalLink size={16} /> 打开网盘下载页
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
            </section>
          </div>

          {/* 右列：打赏支持（含致谢名单，拉长对齐） */}
          <section className="lg:col-span-2 rounded-xl bg-ink-850 border border-ink-700 p-6 flex flex-col">
            <SectionTitle icon={<Heart size={15} className="text-amber" />}>打赏支持</SectionTitle>
            <p className="text-ink-500 text-xs mb-5">
              如果本软件对你有帮助，欢迎扫码支持作者。
            </p>
            {/* 码图区：flex-1 撑满剩余高度，图片锁定纵横比（object-contain）上下贴边。
                完整收款图自带品牌底色，可一眼分辨归属，无需文字标注 */}
            <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
              {[
                { key: 'wechat', img: payWechat },
                { key: 'alipay', img: payAlipay },
              ].map(p => (
                <div key={p.key} className="rounded-lg bg-ink-900/60 border border-ink-700 p-3 flex items-center justify-center overflow-hidden min-h-0">
                  <img
                    src={p.img}
                    alt={`${p.key === 'wechat' ? '微信' : '支付宝'}收款码`}
                    className="max-w-full max-h-full object-contain rounded-md"
                  />
                </div>
              ))}
            </div>

            {/* 致谢名单 */}
            <div className="mt-6 pt-5 border-t border-ink-700">
              <h3 className="text-xs font-semibold text-ink-200 mb-1 flex items-center gap-2">
                <Users size={14} className="text-amber" /> 致谢名单
              </h3>
              <p className="text-ink-500 text-11 mb-3">
                名单暂为示例（借用各位知名网络小说主角的名号排排站），后续会更新为真实打赏记录——你的名字也会出现在这里。
              </p>
              <div className="flex flex-wrap gap-2 content-start">
                {THANKS.map(t => (
                  <span
                    key={t.name}
                    className="inline-flex items-center gap-1.5 rounded-full bg-ink-800 border border-ink-700 px-3 py-1 text-xs text-ink-300"
                  >
                    <span className="text-ink-100">{t.name}</span>
                    <span className="text-10 text-ink-500">《{t.work}》</span>
                  </span>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
