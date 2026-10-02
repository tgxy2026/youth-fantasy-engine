/**
 * 首启向导（2.4.0 · A1 首启闭环）
 *
 * 【它替代了什么】
 * 在此之前，新用户第一次打开软件时，是 `App.tsx` **静默自动创建**示范项目《吞天神脉》——
 * 软件替他做了决定，他既没看到「还有别的选择」，也没被告知「这是示例、不是你的书」。
 * 现在改成一次显式的三选一：写自己的书 / 先看示例 / 导入备份。
 *
 * 【为什么放两步而不是一屏】
 * 「创建项目」和「配模型」是两件独立的事：前者决定去哪儿写，后者决定 AI 能不能用。
 * 而配模型对新手是有门槛的（要选平台、填密钥、等一次真实调用），
 * 所以放在第二步、**可以整步跳过**，并且反复强调「不配也能写正文」——
 * 「5 分钟写出第一段」这条路不能被配模型堵住。
 *
 * 【什么时候还会再弹】
 * 只在「从没走过向导」且「库里一个项目都没有」时。走过一次就往全局 meta 写 `welcomeDone`，
 * 随数据文件走（换设备也认）；导入备份的路径不再进 AI 步骤 —— 备份里通常已经带着模型配置。
 */
import { useRef, useState, type ReactNode } from 'react'
import { Z } from '../lib/zLayer'
import { usePersistedBool } from '../lib/uiPrefs'
import { BookPlus, Sparkles, Upload, ArrowRight, Check, Loader2 } from 'lucide-react'
import * as db from '../lib/db'
import type { ProjectBundle } from '../lib/db'
import { createDemoProject } from '../lib/seedData'
import { Button } from './Button'
import { showToast } from './dialogs'
import BrandMark from './BrandMark'
import { APP_VERSION_LABEL } from '../lib/env'
import workbenchBg from '../assets/workbench-bg.png'
import WelcomeAISetup from './WelcomeAISetup'
import { GenrePackSelect } from './GenrePackSelect'
import { DEFAULT_PACK, type GenrePack } from '../lib/schemaTemplates'

type Choice = 'new' | 'demo' | 'import'

interface Props {
  /** 向导结束：带上创建 / 导入好的项目 id；用户跳过一次则传 null（进项目管理页） */
  onDone: (projectId: string | null) => void
}

const CARDS: { key: Choice; icon: ReactNode; iconCls: string; title: string; body: string }[] = [
  {
    key: 'new',
    icon: <BookPlus size={16} />,
    iconCls: 'bg-amber/15 text-amber',
    title: '写我的第一本书',
    body: '新建一个空项目，从零开始 —— 设定、大纲、正文全都存在你自己的库里。',
  },
  {
    key: 'demo',
    icon: <Sparkles size={16} />,
    iconCls: 'bg-success/15 text-success',
    title: '先看看示例',
    body: '载入示范项目《吞天神脉》：整套范例宇宙（正文、设定表、角色卡、伏笔、时间脉络、码字统计），用来摸清各功能怎么用，看完可以直接删。',
  },
  {
    key: 'import',
    icon: <Upload size={16} />,
    iconCls: 'bg-info/15 text-info',
    title: '我有备份',
    body: '导入之前用本软件导出的 .json 备份，把整本书原样还原回来。',
  },
]

export default function WelcomeWizard({ onDone }: Props) {
  const [step, setStep] = useState<'start' | 'ai'>('start')
  const [choice, setChoice] = useState<Choice>('new')
  const [bgHidden] = usePersistedBool('workbench-bg-hidden', false)
  const [bookName, setBookName] = useState('')
  /** 作品题材（2.7.1）：决定开书定位那几个页签用哪套模板 */
  const [genre, setGenre] = useState<GenrePack>(DEFAULT_PACK)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /** 向导收尾：记一笔「已走过向导」，以后不再弹 */
  const finish = async (projectId: string | null) => {
    try { await db.setMeta('welcomeDone', '1') } catch { /* 记不上也不该拦住开工 */ }
    onDone(projectId)
  }

  /** 新建空项目 / 载入示范项目（AI 步骤走完或跳过都汇到这里） */
  const createAndOpen = async () => {
    setBusy(true)
    try {
      const id = choice === 'demo'
        ? await createDemoProject()
        : (await db.createProject(bookName.trim() || '未命名作品', genre)).id
      await finish(id)
    } catch (e) {
      showToast('创建失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 导入备份：备份里通常已带模型配置，故不再走 AI 步骤 */
  const importBackup = async (file: File) => {
    setBusy(true)
    try {
      const bundle = JSON.parse(await file.text()) as ProjectBundle
      const id = await db.importProject(bundle)
      showToast(`项目「${bundle.project?.name ?? ''}」导入成功`)
      await finish(id)
    } catch (e) {
      showToast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-transparent overflow-y-auto relative">
      {/* 2.6.1 起受侧栏「背景」开关控制（首启向导通常还没关过，默认显示） */}
      {!bgHidden && (
      <div
        className="absolute inset-0 pointer-events-none bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${workbenchBg})`, zIndex: Z.pageBackdrop }}
        aria-hidden
      />
      )}
      <div className="relative w-full max-w-[860px] mx-auto px-6 py-12 page-enter" style={{ zIndex: Z.pageHandle }}>
        <header className="mb-9 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber/15 border border-amber/30 mb-4">
            <BrandMark size={26} className="text-amber" />
          </div>
          <h1 className="text-2xl font-bold text-ink-50 tracking-wide flex items-baseline justify-center gap-2">
            青春幻想引擎
            <span className="text-base font-normal text-ink-400">{APP_VERSION_LABEL}</span>
          </h1>
          <p className="mt-2 text-13 text-ink-400">在你的世界中讲述你的故事</p>
        </header>

        {step === 'start' ? (
          <>
            <h2 className="text-15 font-semibold text-ink-100 mb-1">你想怎么开始？</h2>
            <p className="text-12 text-ink-400 mb-4">选一个，随时可以改 —— 三个入口在项目管理页也都找得到。</p>

            <div className="grid grid-cols-1 gap-3">
              {CARDS.map(c => (
                <Button
                  key={c.key}
                  variant="toggle"
                  selected={choice === c.key}
                  onClick={() => setChoice(c.key)}
                  className="w-full flex-row items-center justify-start gap-3.5 p-4 h-auto text-left rounded-xl"
                >
                  <span className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-lg ${c.iconCls}`}>
                    {c.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-13 font-medium text-ink-50">{c.title}</span>
                    <span className="block text-11 text-ink-400 mt-1 leading-relaxed whitespace-normal">{c.body}</span>
                  </span>
                  <span className="shrink-0 text-ink-500">
                    {choice === c.key ? <Check size={15} className="text-amber" /> : <ArrowRight size={15} />}
                  </span>
                </Button>
              ))}
            </div>

            {choice === 'new' && (
              <div className="mt-4 page-enter">
                <label className="block text-11 text-ink-400 mb-1">书名</label>
                <input
                  value={bookName}
                  onChange={e => setBookName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) setStep('ai') }}
                  placeholder="给这本书起个名字，之后随时能改；留空也可以，进去再填"
                  autoFocus
                  className="w-full text-13"
                />
                {/* 作品题材（2.7.1）：开书第一步就对齐模板，省得写历史/都市时看到境界阶梯 */}
                <div className="mt-4">
                  <label className="block text-11 text-ink-400 mb-1">作品题材</label>
                  <GenrePackSelect value={genre} onChange={setGenre} className="w-full" />
                  <div className="mt-1 text-10 leading-relaxed text-ink-500">
                    决定「世界设定 / 力量体系 / 政治 / 经济 / 宗教 / 司法」用哪套模板、默认显示哪几个；进去后还能随时改。
                  </div>
                </div>
              </div>
            )}

            <div className="mt-7 flex items-center gap-3">
              {/* 🔴 静止态带文字的按钮走 secondary，不用 ghost（2026-09-22 六维审计 P2）：
                  ghost 无边框，在这一屏上会被当成"普通文字"而不是"可点的次要操作" */}
              <Button variant="secondary" size="md" onClick={() => finish(null)} disabled={busy}>
                跳过，直接进入项目管理
              </Button>
              <Button
                variant="primary"
                solid
                size="md"
                className="ml-auto"
                disabled={busy}
                onClick={() => { if (choice === 'import') fileRef.current?.click(); else setStep('ai') }}
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {choice === 'import' ? '选择备份文件' : '下一步'}
                {choice !== 'import' && !busy && <ArrowRight size={13} />}
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) importBackup(f)
                e.target.value = ''
              }}
            />
          </>
        ) : (
          <WelcomeAISetup
            onDone={createAndOpen}
            onSkip={createAndOpen}
            onBack={() => setStep('start')}
          />
        )}
      </div>
    </div>
  )
}
