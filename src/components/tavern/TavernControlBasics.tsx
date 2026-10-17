/**
 * 酒馆控制面板 · 基础（一、通用设置 / 二、我的档案）（C1 · 2.4.2 自 TavernControl.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useTavernControlModel（组件只收 m）。
 * 🔴 必须返回 Fragment（不产生 DOM 节点）—— 主组件左列 div 的直接子节点数要恒为 5
 *    （实机脚本 ui-tavern-control.mjs 会数这一层：多包一层 div 立刻现形）。
 */
import AvatarPicker from '@/components/common/AvatarPicker'
import { Button } from '@/components/common/Button'
import { PARAM_GUIDES } from '@/lib/tavern/paramGuide'
import { GRID2, Section, Field, NumField, TextField, SelectField, ToggleField } from '@/components/tavern/TavernFieldKit'
import type { TavernControlModel } from '@/components/tavern/useTavernControlModel'
import SamplingUnavailable from '@/components/common/SamplingUnavailable'
import { profileListOf, activeProfileOf, type TavernProfile } from '@/lib/tavern/settings'

/** 下拉里显示什么：优先档案自己的名字；没名字就用序号兜底（否则两个空档案长得一模一样） */
const profileOptionLabel = (p: TavernProfile, i: number) => p.name.trim() || `未命名档案 ${i + 1}`

export default function TavernControlBasics({ m }: { m: TavernControlModel }) {
  const { setCommon, setProfile, addProfile, removeProfile, selectProfile, s, c, pr, modelOptions, cap, rec, gNumCtx, gBudget, gFixed, drift, applyRecommended, onDefaultModelChange, setLocalWindow } = m
  /** 全部档案（老库只有一份 ⇒ 数组长度 1）+ 当前生效那份的 id（老库没有 id ⇒ 空串，选项值也用它） */
  const profiles = profileListOf(s)
  const curProfileId = activeProfileOf(s).id ?? ''
  return (
    <>
          {/* ---------- 一、通用设置 ---------- */}
          <div>
          <Section
            title="一、通用设置"
            desc="两种模式都生效。模型与上下文这些「跟谁说、说多长」的事在这里定；具体的采样手感与提示词在下面几段。"
          >
            <SelectField
              label="默认模型"
              hint="留空则跟随「模型设置 → 模型配置」里选中的全局活动模型。两个模式都用它；会话里不再单独选择模型。换模型时，下面的额度会按新模型的推荐值调整（可在能力条里关掉这个行为）。"
              value={c.defaultProviderId}
              options={modelOptions}
              emptyLabel="（跟随全局活动模型）"
              onChange={onDefaultModelChange}
            />

            {/* 模型能力条：把「下面这批数值跟着哪个模型在走」摆到眼前。
                下面的每一项都可以单独改；这里是当前模型下的一整套建议，点一下全采用。 */}
            <div className="rounded-md border border-ink-700 bg-ink-800/40 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-11 text-ink-200 leading-relaxed">{cap.headline}</div>
                  <div className="mt-0.5 text-11 text-ink-500 leading-relaxed">{cap.note}</div>
                  <div className="mt-1 text-11 text-ink-600 leading-relaxed">
                    下面「记忆三项 / 日记保留 / 固定开销」的推荐值按当前预算同比推算（预算跟着所选模型走，它们也就跟着变）。
                    窗口默认取「模型配置 → 上下文窗口」填的值；预算与记忆档都按它缩放，
                    本地只在「超过窗口承载」时才回落（否则会被静默截断）。
                    正文写作链路的额度在「模型设置 → 正文写作 AI 额度」里单独设置（两边各管各的、互不冲突）。
                  </div>
                </div>
                <Button variant="secondary" size="sm" onClick={applyRecommended}
                  disabled={drift === 0}
                  title={drift === 0
                    ? '各项都已在推荐值上，无需改动'
                    : `有 ${drift} 项偏离当前模型的推荐值，点击一次性采用`}
                  className="shrink-0 whitespace-nowrap">
                  {drift === 0 ? '已是推荐值' : `采用推荐值（${drift}）`}
                </Button>
              </div>
              <div className="mt-2 border-t border-ink-700/60 pt-2">
                <ToggleField
                  label="额度跟随模型自动调整"
                  hint="换模型后自动把这批数值套用成新模型的推荐值。⚠️ 只在你「换模型」时生效 —— 同一个模型下你手调的值不会被改回去（想完全手工就关掉它，面板上仍可点「采用推荐值」）。"
                  value={c.autoTuneByModel !== false}
                  onChange={v => setCommon('autoTuneByModel', v)}
                />
              </div>
            </div>

            <div className={GRID2}>
              <NumField
                label="上下文预算" guide={gBudget} recommend={cap.local ? undefined : rec.contextBudget}
                hint="一轮请求里「设定 + 记忆 + 对话历史」加起来的上限。超了先裁最早的对话轮次（开场永不被裁）。推荐值按当前模型的窗口折减得出；调大它会同时增加每轮的云端费用。"
                value={c.contextBudget} onCommit={v => setCommon('contextBudget', v)}
              />
              <NumField
                label="固定开销预留" guide={gFixed} recommend={rec.fixedOverhead}
                hint="纯余量，不是「替协议占位」。协议与记忆已经算在 system 里了，这里不再重复预留；调大它就等于压缩可分配给对话历史的额度。推荐值按当前上下文预算的约百分之一推算。"
                value={c.fixedOverheadChars} onCommit={v => setCommon('fixedOverheadChars', v)}
              />
              <NumField
                label="请求超时" guide={PARAM_GUIDES.timeoutSec}
                hint="超过这个时间就中断并报错。本地模型慢就调大；联网模型一般 60～120 够用。"
                value={c.timeoutSec} onCommit={v => setCommon('timeoutSec', v)}
              />
            </div>

            <div className={GRID2}>
              {/* 🔴 2026-10-07 方案 C：**按当前模型分两态**。
                  云端：整项灰显占位、不出数字、不可编辑 —— `num_ctx` 对 OpenAI 兼容端点无效，
                        以前这里显示一个大数字（看着像"可设置"）＋一句「设了也不生效」，
                        实测会让作者误以为「系统没适配他选的模型」。窗口信息只留在说明里
                        （它仍是预算推算的依据，不该丢）。
                  本地：**可编辑**，但编辑的是「模型配置 → 上下文窗口」那一处真源
                        （见 hook 的 `setLocalWindow`）—— 不再写 `common.numCtx`，
                        免得落进「模型配置填过 ⇒ 面板值被忽略」的分叉。
                        `common.numCtx` 字段仍**保留**作「模型配置未填时的沿用值」（零迁移、零回退）。 */}
              {cap.local ? (
                <NumField
                  label="上下文窗口长度"
                  guide={gNumCtx}
                  value={cap.windowTokens}
                  onCommit={setLocalWindow}
                  hint="本地 Ollama 的 num_ctx，也是显存安全阀：调大它能装下更多内容，代价是显存占用同步上升 —— 模型加载不起来就把它调小。⚠️ 这里填的值会写进「工作面板 → 模型设置 → 模型配置 → 上下文窗口」，两处始终是同一个数；上面的「上下文预算」与记忆档也都按它缩放。"
                />
              ) : (
                <Field
                  label="上下文窗口长度"
                  hint={'此参数只对本地 Ollama 生效 —— 当前接的是云端模型，本项不参与调用，故不提供编辑；云端窗口由服务商决定。'
                    + (cap.windowSource === 'fallback'
                      ? ` 系统按保守值 ${cap.windowTokens} tokens 估算该模型的窗口（可在「模型配置」里手填纠正），推荐值就准了。`
                      : ` 系统按该模型的 ${cap.windowTokens} tokens 折减推算预算；要让模型读更多内容，请调大上面的「上下文预算」。`)}
                >
                  <SamplingUnavailable />
                </Field>
              )}
              <ToggleField
                label="关闭思考链"
                hint="开启时模型直接说话，不再先写一段分析。角色扮演要「像人说话」而不是「想得深」，所以思考链默认是关闭的；只有本地模型认这个开关。"
                value={c.disableThink} onChange={v => setCommon('disableThink', v)}
              />
            </div>

            <TextField
              label="通用补充要求"
              hint="两种模式都会带上，排在协议之前。默认这条是「标点适用范围」—— 角色卡的示例常是手机消息体风格，模型容易把「少标点」泛化到整篇。"
              minRows={4}
              value={c.extraPrompt}
              onChange={v => setCommon('extraPrompt', v)}
            />

            <ToggleField
              label="接入模型配置里的系统提示词"
              hint="开启后，「模型设置 → 模型配置 → 自定义系统提示词」那段内容会一并带进酒馆的每一次调用（对话、总结、起草、报告……）。默认关闭：那段提示词是写给正文与设定类功能的总体指令（人称 / 文风 / 禁忌），直接灌进来可能与扮演协议打架。只想调酒馆这一侧，请用上面的「通用补充要求」，或到「AI 提示词」里改对应功能的提示词。"
              value={c.injectSystemPrompt === true}
              onChange={v => setCommon('injectSystemPrompt', v)}
            />
          </Section>
          </div>

          {/* ---------- 二、我的档案（全局，跨项目） ---------- */}
          <div>
          <Section
            title="二、我的档案"
            desc="你本人是谁 —— 跨项目生效，每轮进 system。自由对话靠它知道你是谁；剧情推演不用。名字 / 称呼 / 自我设定三栏全空＝不注入（头像只影响界面）。可以建多套：同一个人在不同书里换身份（笔名、性别、脾气）时，切换即可。"
          >
            {/* 档案切换（S3）：只有一份时下拉只有一个选项 —— 不禁用，让作者一眼看到「可以建多套」 */}
            <div className="mb-3 rounded-md border border-ink-700 bg-ink-900/40 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 text-11 text-ink-400">档案</span>
                <select
                  className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50"
                  value={curProfileId}
                  onChange={e => selectProfile(e.target.value)}
                >
                  {profiles.map((p, i) => (
                    <option key={p.id ?? `legacy-${i}`} value={p.id ?? ''}>{profileOptionLabel(p, i)}</option>
                  ))}
                </select>
                <Button variant="secondary" size="sm" onClick={addProfile}>＋ 新建档案</Button>
                {profiles.length > 1 && (
                  <Button variant="secondary" size="sm" onClick={() => removeProfile(curProfileId)}>删除这份</Button>
                )}
              </div>
              <p className="mt-1.5 text-11 leading-relaxed text-ink-500">
                下面四栏改的是「当前选中的这份」。多套档案的用处：同一个你，在不同书里换身份
                —— 比如写仙侠用一套、写都市用另一套，切换后模型立刻按新的称呼与关系说话。
                {profiles.length === 1 && '（现在只有一份 —— 点「＋ 新建档案」就能加。）'}
              </p>
            </div>
            <div className="mb-1">
              <AvatarPicker
                src={pr.avatar}
                name={pr.name || '我'}
                size={64}
                onChange={v => setProfile('avatar', v)}
                hint="只影响界面：自由对话里 AI 那侧是角色头像，你这一侧就是你 —— 留空用名字首字。"
              />
            </div>
            <div className={GRID2}>
              <TextField
                label="你的名字"
                hint="AI 会按这个名字想到你。"
                minRows={1}
                placeholder="例：老巴迪"
                value={pr.name}
                onChange={v => setProfile('name', v)}
              />
              <TextField
                label="希望被怎么称呼"
                hint="留空就直呼名字。想让 AI 用某个叫法（外号、称呼）就写在这里。"
                minRows={1}
                placeholder="例：巴迪哥"
                value={pr.address}
                onChange={v => setProfile('address', v)}
              />
            </div>
            <TextField
              label="一句话自我设定"
              hint="身份、年纪、与对方的关系……越短越有效（这段每轮都进上下文，写长了会挤占对话历史）。例：三十出头的编剧，跟小满是同事，嘴硬心软。"
              minRows={3}
              placeholder="例：三十出头的编剧，跟小满是同事，嘴硬心软。"
              value={pr.persona}
              onChange={v => setProfile('persona', v)}
            />
          </Section>
          </div>

    </>
  )
}
