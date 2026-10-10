/**
 * 酒馆控制面板 · 扮演协议（五、定高与右列同步）（C1 · 2.4.2 自 TavernControl.tsx 拆出）
 *
 * 🔴 纯搬家：JSX 一字未改；状态全部来自 useTavernControlModel（组件只收 m）。
 * 🔴 必须返回 Fragment（不产生 DOM 节点）—— 主组件左列 div 的直接子节点数要恒为 5
 *    （实机脚本 ui-tavern-control.mjs 会数这一层：多包一层 div 立刻现形）。
 */
import AutoTextarea from '@/components/AutoTextarea'
import { Button } from '@/components/Button'
import { PROTOCOL_VERSION, displayProtocol } from '@/lib/tavern/protocol'
import { DEFAULT_PROTOCOL } from '@/lib/tavern/settings'
import { BOX, Section, Field } from '@/components/tavern/TavernFieldKit'
import type { TavernControlModel } from '@/components/useTavernControlModel'

export default function TavernControlProtocol({ m }: { m: TavernControlModel }) {
  const { s, protocolEditing, setProtocolEditing, protoH, edit, startEditProtocol } = m
  return (
    <>
          {/* ---------- 五、扮演协议（高度同步到与右列底部平齐；正文超出走内部滚动条） ----------
              🔴 两条都是踩出来的，别删：
              ① **不能写 `xl:flex-1`** —— 主轴是高度，flex-basis 会压过下面那个 inline `height`，
                 包装层被"填充剩余空间"接管，设多少高度都无效；
              ② **必须带 `xl:overflow-hidden`** —— flex item 的 `min-height: auto` 等于**内容高度**，
                 正文一长就把 1452px 的定高顶回 1568px（规范里唯一的例外就是 overflow≠visible）。
                 同理，里面那个 Section 也要 overflow-hidden，否则它自己又被内容顶高、底部边框被裁掉。 */}
          <div
            className="xl:min-h-0 xl:shrink-0 xl:flex xl:flex-col xl:overflow-hidden"
            style={protoH === null ? undefined : { height: protoH }}
          >
          <Section
            title="五、扮演协议"
            desc={`两种模式共用的格式契约，内置版本 ${PROTOCOL_VERSION}。注入时钉在提示词的最末尾（它自带的「最后提醒」要紧贴生成点）。`}
            className="xl:h-full xl:min-h-0 xl:flex xl:flex-col xl:overflow-hidden"
            bodyClassName="xl:min-h-0 xl:flex-1 xl:flex xl:flex-col xl:overflow-hidden"
          >
            {!protocolEditing ? (
              <>
                <div className="flex shrink-0 items-center justify-between gap-3">
                  <span className="text-11 text-ink-500">
                    当前 {s.protocol.length} 字
                    {s.protocol !== DEFAULT_PROTOCOL && <span className="text-amber"> · 已被你改过（与出厂版本不同）</span>}
                  </span>
                  <div className="flex shrink-0 gap-2">
                    {s.protocol !== DEFAULT_PROTOCOL && (
                      <Button variant="secondary" size="sm"
                        onClick={() => { edit(prev => ({ ...prev, protocol: DEFAULT_PROTOCOL })); setProtocolEditing(true) }}>
                        恢复出厂协议
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => void startEditProtocol()}>编辑协议</Button>
                  </div>
                </div>
                <pre className="max-h-80 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-700 bg-ink-900/60 p-3 text-11 leading-relaxed text-ink-300 xl:max-h-none xl:min-h-[12rem]">
                  {displayProtocol(s.protocol)}
                </pre>
              </>
            ) : (
              <>
                <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-11 text-amber leading-relaxed">
                  正在编辑协议。改完记得点右上角「保存」才生效；改坏了可以点「恢复出厂协议」，或整体「恢复默认」。
                </div>
                <Field label="协议全文" hint="建议只做小幅增删。别删掉「写成什么样」里的格式规定与末尾的「最后提醒」—— 那两处是格式契约的核心。">
                  <AutoTextarea
                    className={BOX} textClass="text-11" minRows={14} maxHeight={720}
                    value={s.protocol}
                    onChange={v => edit(prev => ({ ...prev, protocol: v }))}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm"
                    onClick={() => edit(prev => ({ ...prev, protocol: DEFAULT_PROTOCOL }))}>
                    恢复出厂协议
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setProtocolEditing(false)}>收起编辑</Button>
                </div>
              </>
            )}
          </Section>
          </div>
    </>
  )
}
