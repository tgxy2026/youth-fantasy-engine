/**
 * 酒馆控制面板 · 基础（一、通用设置 / 二、我的档案）（C1 · 2.4.2 自 TavernControl.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useTavernControlModel（组件只收 m）。
 * 🔴 必须返回 Fragment（不产生 DOM 节点）—— 主组件左列 div 的直接子节点数要恒为 5
 *    （实机脚本 ui-tavern-control.mjs 会数这一层：多包一层 div 立刻现形）。
 */
import AvatarPicker from './AvatarPicker'
import { Button } from './Button'
import { PARAM_GUIDES } from '../lib/tavern/paramGuide'
import { GRID2, Section, NumField, TextField, SelectField, ToggleField } from './TavernFieldKit'
import type { TavernControlModel } from './useTavernControlModel'

export default function TavernControlBasics({ m }: { m: TavernControlModel }) {
  const { setCommon, setProfile, c, pr, modelOptions, cap, rec, gBudget, gNumCtx, drift, applyRecommended, onDefaultModelChange } = m
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
                  <div className="mt-0.5 text-10 text-ink-500 leading-relaxed">{cap.note}</div>
                  <div className="mt-1 text-10 text-ink-600 leading-relaxed">
                    下面「记忆三项 / 日记保留」的推荐值按当前预算同比推算（预算跟着所选模型走，它们也就跟着变）。
                    窗口不代为更改 —— 本地由显存决定、云端由服务商决定，所以它没有推荐值；
                    预算在云端会跟随模型放宽，本地只在「超过窗口承载」时才回落（否则会被静默截断）。
                    正文续写等其它模式的额度不在这里，仍是后台内置值。
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
                label="固定开销预留" guide={PARAM_GUIDES.fixedOverheadChars}
                hint="纯余量，不是「替协议占位」。协议与记忆已经算在 system 里了，这里不再重复预留；调大它就等于压缩可分配给对话历史的额度。"
                value={c.fixedOverheadChars} onCommit={v => setCommon('fixedOverheadChars', v)}
              />
              <NumField
                label="请求超时" guide={PARAM_GUIDES.timeoutSec}
                hint="超过这个时间就中断并报错。本地模型慢就调大；联网模型一般 60～120 够用。"
                value={c.timeoutSec} onCommit={v => setCommon('timeoutSec', v)}
              />
            </div>

            <div className={GRID2}>
              <NumField
                label="上下文窗口长度" guide={gNumCtx}
                hint={cap.local
                  ? '显式告诉本地模型能装多少内容。不指定的话它会按全局设置（可能 128K）加载，显存占用会远超预期。本地窗口由显存决定，别照模型标称值往大调。'
                  : '此参数只对本地 Ollama 生效 —— 当前接的是云端模型，设了也不生效，所以这里没有推荐值。'
                    + (cap.windowSource === 'fallback'
                      ? `没能识别这个模型的窗口（现按保守值 ${cap.windowTokens} tokens 估算）—— 可去「工作面板 → 模型设置 → 模型配置」手填「上下文窗口」，推荐值就准了。`
                      : `该模型窗口为 ${cap.windowTokens} tokens，要让模型多读内容请调大上面的「上下文预算」。`)}
                value={c.numCtx} onCommit={v => setCommon('numCtx', v)}
              />
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
          </Section>
          </div>

          {/* ---------- 二、我的档案（全局，跨项目） ---------- */}
          <div>
          <Section
            title="二、我的档案"
            desc="你本人是谁 —— 全局设置，跨项目、跨会话生效，每轮都进 system。自由对话里 AI 靠它知道屏幕后面是谁（称呼、亲疏、语气都照它来）；剧情推演不用它 —— 那边你在每场推演里已经选定了自己演的角色，AI 以角色卡为准。三栏全留空 = 整段不注入，行为与以前完全一样。"
          >
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
