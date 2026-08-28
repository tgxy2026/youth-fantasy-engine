import { ExternalLink, Heart, BookOpen, Users, Globe } from 'lucide-react'
import payWechat from '../assets/pay-wechat.png'
import payAlipay from '../assets/pay-alipay.png'
import authorAvatar from '../assets/author-avatar.png'

// 关于 / 打赏页（v1.6.3 草稿）：这是「青春幻想引擎」软件自身的关于页，作者 = 咸鱼哥（AI 不占版面）。
// 当前为占位内容，资料后续由作者替换（真实收款码、头像、简介、真实 B 站 ID、友链等）。
const BILI_URL = 'https://b23.tv/zl4vqyw'
const BILI_NAME = '铁骨咸鱼'

// 致谢名单（支持者墙）—— 示例占位：借用知名网络小说主角的名号，后续由作者替换为真实读者 / 金主 / 贡献者记录
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

// 友情链接（占位，待作者填充真实外链）
const LINKS = [
  { label: '读者交流群', value: '【占位】群号 / 邀请链接' },
  { label: '微博', value: '【占位】@作者微博' },
  { label: '公众号', value: '【占位】公众号名' },
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
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold text-ink-50">关于打赏</h1>
          <span className="rounded-full bg-amber/10 text-amber text-[11px] px-2 py-0.5 border border-amber/25">
            草稿 · 占位待替换
          </span>
        </div>
        <p className="text-ink-400 text-sm mb-8">
          关于「青春幻想引擎」与它的作者，以及支持作者的方式。下列资料为占位内容，后续由作者替换为真实信息。
        </p>

        {/* 主体：左列（作者信息 + 友情链接） / 右列（打赏支持，拉长对齐） */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
          {/* 左列：作者信息 + 友情链接 */}
          <div className="lg:col-span-1 flex flex-col gap-6">
            {/* 作者信息 */}
            <section className="rounded-xl bg-ink-850 border border-ink-700 p-6">
              <SectionTitle icon={<BookOpen size={15} className="text-amber" />}>作者信息</SectionTitle>
              <div className="flex flex-col items-center text-center">
                <img
                  src={authorAvatar}
                  alt="作者头像占位"
                  className="w-24 h-24 rounded-full border border-ink-700 object-cover mb-3"
                />
                <div className="text-lg font-semibold text-ink-50">【占位】作者笔名</div>
                <p className="text-ink-400 text-xs mt-2 leading-relaxed">
                  【占位】一句话介绍你自己与「青春幻想引擎」的由来、更新节奏、想对支持者说的话……待作者填写。
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

            {/* 友情链接 */}
            <section className="rounded-xl bg-ink-850 border border-ink-700 p-6">
              <SectionTitle icon={<Globe size={15} className="text-amber" />}>友情链接</SectionTitle>
              <ul className="space-y-3">
                {LINKS.map(l => (
                  <li key={l.label} className="flex flex-col">
                    <span className="text-[11px] text-ink-500">{l.label}</span>
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
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: '微信', img: payWechat, color: 'text-emerald-400' },
                { label: '支付宝', img: payAlipay, color: 'text-sky-400' },
              ].map(p => (
                <div key={p.label} className="rounded-lg bg-ink-900/60 border border-ink-700 p-4 text-center">
                  <div className={`text-sm font-medium mb-3 ${p.color}`}>{p.label}</div>
                  <img
                    src={p.img}
                    alt={`${p.label}收款码占位`}
                    className="w-40 h-40 mx-auto rounded-md"
                  />
                  <div className="text-[10px] text-ink-600 mt-3">（占位图，待替换为真实收款码）</div>
                </div>
              ))}
            </div>

            {/* 致谢名单（flex-1 撑满右列剩余高度，预留更多空位） */}
            <div className="mt-6 pt-5 border-t border-ink-700 flex-1">
              <h3 className="text-xs font-semibold text-ink-200 mb-1 flex items-center gap-2">
                <Users size={14} className="text-amber" /> 致谢名单
              </h3>
              <p className="text-ink-500 text-[11px] mb-3">
                名单暂为示例占位（借用各位知名网络小说主角的名号排排站），待作者替换为真实打赏记录——你的名字也会出现在这里。
              </p>
              <div className="flex flex-wrap gap-2 content-start">
                {THANKS.map(t => (
                  <span
                    key={t.name}
                    className="inline-flex items-center gap-1.5 rounded-full bg-ink-800 border border-ink-700 px-3 py-1 text-xs text-ink-300"
                  >
                    <span className="text-ink-100">{t.name}</span>
                    <span className="text-[10px] text-ink-500">《{t.work}》</span>
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
