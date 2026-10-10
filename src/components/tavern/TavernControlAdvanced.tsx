/**
 * 酒馆控制面板 · 高级（三、预设方案 / 四、输出后处理）（C1 · 2.4.2 自 TavernControl.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useTavernControlModel（组件只收 m）。
 * 🔴 必须返回 Fragment（不产生 DOM 节点）—— 主组件左列 div 的直接子节点数要恒为 5
 *    （实机脚本 ui-tavern-control.mjs 会数这一层：多包一层 div 立刻现形）。
 */
import AutoTextarea from '@/components/AutoTextarea'
import { Button } from '@/components/Button'
import { Section, ToggleField, NumField } from '@/components/tavern/TavernFieldKit'
import { RULE_EXAMPLE } from '@/components/tavernControlParts'
import { DYNAMIC_QUOTA_PCT, fixedQuotaOf, dynamicQuotaOf, fmtWindow } from '@/lib/tavern/quotas'
import type { TavernControlModel } from '@/components/useTavernControlModel'

export default function TavernControlAdvanced({ m }: { m: TavernControlModel }) {
  const { s, ruleTry, setRuleTry, presetList, setPresetNaming, presetFileRef, applyPreset, overwritePreset, dropPreset, exportPreset, importPresetFile, setPostFlag, setMultiVariant, setDynamicQuotaPct, setFree, setRule, addRule, dropRule, resetRules, rulePreview, activeProvider } = m
  return (
    <>
          {/* ---------- 三、预设方案（A4） ---------- */}
          <Section
            title="三、预设方案"
            desc="把整套设置存成命名快照，一键切换。预设含协议全文，换预设会连格式契约一起换。"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="md" onClick={() => setPresetNaming(true)}>＋ 存为预设</Button>
              <Button variant="secondary" size="md" onClick={() => presetFileRef.current?.click()}>从文件导入</Button>
              <input
                ref={presetFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) void importPresetFile(f)
                  e.target.value = '' // 允许连续导入同一个文件
                }}
              />
            </div>
            <p className="text-11 text-ink-500 leading-relaxed">
              建议按工作模式分：例如「快速脑暴」（温度高、篇幅短、脑洞优先）与「精修成稿」（温度低、
              篇幅长、一致性优先）。应用预设会整体替换当前设置，未保存的改动会被覆盖。
            </p>

            {presetList.length === 0 ? (
              <p className="text-11 text-ink-600 leading-relaxed">
                还没有预设。把当前这套存一个，以后切回来只要点一下 —— 也能导出去分享给别人。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {presetList.map(p => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-12 text-ink-100">{p.name}</div>
                      <div className="text-10 text-ink-500">
                        {new Date(p.updatedAt).toLocaleString()}
                        {' · 叙事温度 '}{p.data.plot.temperature}{' · 聊天温度 '}{p.data.free.temperature}
                      </div>
                    </div>
                    <Button
                      variant="primary" size="xs" className="shrink-0"
                      onClick={() => void applyPreset(p)}
                      title="把当前设置整体换成这套预设（含协议）"
                    >应用</Button>
                    <Button
                      variant="secondary" size="xs" className="shrink-0"
                      onClick={() => void overwritePreset(p)}
                      title="用当前设置覆盖这份预设"
                    >覆盖</Button>
                    <Button
                      variant="secondary" size="xs" className="shrink-0"
                      onClick={() => exportPreset(p)}
                      title="导出成文件，可备份或分享"
                    >导出</Button>
                    <Button
                      variant="danger" size="xs" className="shrink-0"
                      onClick={() => void dropPreset(p)}
                      title="只删这份快照，当前设置不受影响"
                    >删除</Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ---------- 四、输出后处理（B3） ---------- */}
          <Section
            title="四、输出后处理"
            desc="生成后按规则依次修一遍再落库。模型常不守格式，用规则兜住更划算；先去 markdown 再处理单星号动作。"
          >
            <ToggleField
              label="启用输出后处理"
              hint="关掉就完全不跑规则（排查格式问题时用这一档，先排除规则本身的影响）。"
              value={s.postRulesEnabled}
              onChange={v => setPostFlag({ postRulesEnabled: v })}
            />
            <ToggleField
              label="命中时在对话页提示"
              hint="关掉 = 静默修正：规则照跑，只是不在输入框上方告诉你改了哪几条。正则写错仍会提示 —— 那是配置问题，不该被静默。"
              value={s.postRuleNotice}
              onChange={v => setPostFlag({ postRuleNotice: v })}
            />

            {/* T3 多候选（swipe）：两种模式都生效。默认关 = 与旧版行为完全一致 */}
            <ToggleField
              label="多候选（重说保留旧版）"
              hint="开启后「重说」不再覆盖原回复，而是存成候选，消息上出现 ‹ 1/2 › 翻页可来回对照（每条约 5 个版本）。两种模式都生效；关掉则与以前完全一样。注意：开着会让库明显变大。"
              value={s.multiVariant}
              onChange={setMultiVariant}
            />

            {/* T2 语义召回（2026-10-05）：自由对话专属。默认关 = 要发嵌入请求 */}
            <ToggleField
              label="自由对话的语义召回"
              hint="长对话聊久了，早期消息会因上下文预算被裁掉、Ta 就「忘了」。开启后系统给本场建一份小索引，每轮按当下话题把被裁掉的旧片段捞回来（界面会显示为〖相关对话召回〗）。默认关：它要发嵌入请求，云端嵌入模型会花钱 —— 需要先在「语义检索」里配好嵌入模型。只在自由对话生效；剧情推演本来就有全书召回。"
              value={s.free.semanticRecall}
              onChange={v => setFree('semanticRecall', v)}
            />

            {/* 世界书额度（2026-10-05 · 对齐 ST 的 world_info_budget）：固定层跟着窗口自动算，动态层可调 */}
            <NumField
              label="世界书动态额度（占窗口 %）"
              hint={`世界书上「按触发词命中」的词条单独能占多少上下文 —— 与固定层（一句话总纲 / 世界设定，${fixedQuotaOf(activeProvider?.contextWindow)} 字）分开各算、互不挤占。默认 ${DYNAMIC_QUOTA_PCT.default}%，留更多给对话历史；词条多、细节密可以调高。超额度时不会切断某条，而是按优先级逐条取舍（常驻 → 直接命中 → 引荐命中）。按当前模型 ${fmtWindow(activeProvider?.contextWindow ?? 0)} 窗口算，本档 ≈ ${dynamicQuotaOf(activeProvider?.contextWindow, s.dynamicQuotaPct)} 字。`}
              guide={{
                min: DYNAMIC_QUOTA_PCT.min, max: DYNAMIC_QUOTA_PCT.max, step: DYNAMIC_QUOTA_PCT.step,
                bands: [
                  { from: DYNAMIC_QUOTA_PCT.min, to: 10, name: '最省', effect: '词条基本只留常驻，触发命中常被取舍 —— 适合小窗口模型或已经很长的对话。' },
                  { from: 10, to: 20, name: '默认', effect: `出厂档位（当前 ${DYNAMIC_QUOTA_PCT.default}%）：留足对话历史，世界书也够用。`, recommended: true },
                  { from: 20, to: 28, name: '偏宽', effect: '世界书给得比较宽，接近 ST 的出厂值（25%）。词条多、细节密时用。' },
                  { from: 28, to: DYNAMIC_QUOTA_PCT.max, name: '最宽', effect: '世界书优先，对话历史会被明显压缩 —— 只建议大窗口（128K 以上）模型用。' },
                ],
              }}
              value={s.dynamicQuotaPct}
              onCommit={setDynamicQuotaPct}
            />

            <div className="space-y-2">
              {s.postRules.map((r, i) => (
                <div key={r.id} className="rounded-md border border-ink-700 bg-ink-900/40 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox" className="shrink-0 accent-amber" checked={r.enabled}
                      onChange={e => setRule(r.id, { enabled: e.target.checked })}
                      title="关掉这一条（其余规则照跑）"
                    />
                    <span className="shrink-0 text-10 text-ink-600">{i + 1}</span>
                    <input
                      value={r.name} onChange={e => setRule(r.id, { name: e.target.value })}
                      className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
                      placeholder="规则名（对话页提示里显示的就是它）"
                    />
                    <Button variant="danger" size="xs" className="shrink-0" onClick={() => dropRule(r.id)}>
                      删除
                    </Button>
                  </div>
                  <input
                    value={r.pattern} onChange={e => setRule(r.id, { pattern: e.target.value })}
                    className="mt-1.5 w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-1 font-mono text-11 text-ink-200 outline-none focus:border-amber/50"
                    placeholder={`正则源码，例：${RULE_EXAMPLE}`}
                  />
                  <input
                    value={r.replacement} onChange={e => setRule(r.id, { replacement: e.target.value })}
                    className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-1 font-mono text-11 text-ink-200 outline-none focus:border-amber/50"
                    placeholder="替换成（$1 = 第一个捕获组；留空 = 直接删掉）"
                  />
                  {r.note && (
                    <p className={`mt-1 text-10 leading-relaxed ${r.enabled ? 'text-ink-600' : 'text-amber/80'}`}>
                      {r.note}
                    </p>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={addRule}>＋ 新增规则</Button>
              <Button variant="secondary" size="sm" onClick={resetRules}>恢复出厂默认</Button>
              <span className="text-10 text-ink-500">
                共 {s.postRules.length} 条 · 启用 {s.postRules.filter(r => r.enabled).length} 条
              </span>
            </div>
            <p className="text-10 text-ink-600 leading-relaxed">
              正则写法提示：$1 / $2 是捕获组（例：星号动作那条的正则是 {RULE_EXAMPLE}）；
              flags 固定 gm（m 让 ^ 匹配每一行，行首说话人标签那条要用）。
            </p>

            {/* 试一段：正则最容易写错，给个立刻能看到结果的入口（比「改完去聊一句看效果」省事） */}
            <div>
              <div className="text-11 text-ink-200">试一段</div>
              <AutoTextarea
                className="mt-1 bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-11 font-mono"
                minRows={2}
                maxHeight={140}
                placeholder="贴一段模型输出，例：（她点头。） / （他把烟按灭） / 小满：你来了。"
                value={ruleTry}
                onChange={setRuleTry}
              />
              <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-ink-700 bg-ink-900/60 p-2 text-11 leading-relaxed text-ink-300">{rulePreview.text || '（上面输入内容就能看到结果）'}</pre>
              <p className="mt-1 text-10 leading-relaxed text-ink-500">
                {rulePreview.errors.length > 0
                  ? <span className="text-amber">⚠️ 正则无效、已跳过：{rulePreview.errors.join('、')}</span>
                  : rulePreview.applied.length > 0
                    ? `命中：${rulePreview.applied.map(a => `${a.name} ×${a.count}`).join('、')}`
                    : '没命中任何规则（上面的输入已符合协议，或规则没写对）'}
              </p>
            </div>
          </Section>
    </>
  )
}
