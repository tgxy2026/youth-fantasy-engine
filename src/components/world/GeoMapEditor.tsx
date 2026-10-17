import { useEffect, useMemo } from 'react'
import { Z } from '@/lib/app/zLayer'
import type { PointerEvent as RPointerEvent } from 'react'
import { Maximize2, ZoomIn, ZoomOut, MapPin, Pencil, ImagePlus, X } from 'lucide-react'
import type { TabDef } from '@/lib/types'
import HelpPopover from '@/components/common/HelpPopover'
import { MAP_SPACE_FALLBACK } from '@/lib/settings/palette'
import { Button } from '@/components/common/Button'
import { useGeoMapModel } from '@/components/world/useGeoMapModel'
import { GeoMapList, DrawDialog, AddMarkerForm, DetailPanel } from '@/components/world/GeoMapParts'
import { LAYER_COLORS, G, CELL_KM_STEPS } from '@/components/world/geoMapGeometry'
import { useMonoTheme } from '@/lib/settings/useMonoTheme'
import { monoDashLookup, MONO_DASHES } from '@/lib/settings/monoMarks'
import * as db from '@/lib/db'
import { showToast } from '@/components/dialogs/dialogs'
import { readMapImageFile, MAP_IMAGE_ACCEPT, MAP_IMAGE_HINT_SPEC } from '@/lib/media/mapImage'

export default function GeoMapEditor({ tab }: { tab: TabDef }) {
  // 🔴 纯黑白（3.1.1）：图层语义色失效 ⇒ 改由**线型**承载（伏笔实线 / 角色虚线 / 时间脉络点线）；
  //    地块层级色失效 ⇒ 改由**轮廓线型按深度**承载。只在此主题下分支。
  const mono = useMonoTheme()
  const monoInk = 'rgb(var(--ink-100))'
  const monoLayerDash = useMemo(() => monoDashLookup(['foreshadow', 'character', 'timeline']), [])
  // 视图侧「同名解构」：JSX 一个字都没改 —— 拆分只把状态与交互挪进了 useGeoMapModel。
  const {
    curMapName, mapNote, rows, stepCellKm, wrapRef, svgRef,
    load, categoryNames, markers, byId, depthMap, spaceColors,
    spaceShapes, drawnIds, viewShapes, linked, fitView, enterPaint,
    exitPaint, onPointerDown, onPointerMove, onPointerUp, createMarker, updateSelected,
    clearCoords, deleteMarker, gotoTable, selMarker, selLinked, anyLayerOn,
    allRows, maps, mapId, setMapId, loading, view,
    hover, setHover, selected, addPos, setAddPos, layers,
    setLayers, cellKm, painting, selRect, drawDialogOpen, setDrawDialogOpen,
    vp,
    // 🔴 B8：图片底图
    mapMode, mapImage, mapImageSize, setMapImageSize,
  } = useGeoMapModel()

  /**
   * 🔴 B8：上传 / 更换 / 清除底图。
   * `file = null` ⇒ 切回「格子」模式（底图数据一并清掉，避免留一份没用的 dataURL 占体积）。
   */
  const onPickMapImage = async (file: File | null) => {
    const row = maps.find(m => m.id === mapId)
    if (!row) { showToast('先选一张地图', 'error'); return }
    try {
      if (!file) {
        await db.saveTableRow({ ...row, data: { ...row.data, '底图模式': '格子', '底图': '' } })
        showToast('已切回格子模式（底图已清除）', 'success')
        load()
        return
      }
      const r = await readMapImageFile(file)
      await db.saveTableRow({
        ...row,
        data: { ...row.data, '底图模式': '图片', '底图': r.dataUrl },
      })
      showToast(
        `底图已就绪（${r.w}×${r.h} · ${Math.round(r.bytes / 1024)}KB${r.downscaled ? ' · 为控制体积已压缩' : ''}）`,
        'success',
      )
      load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '这张图不能用作底图', 'error')
    }
  }

  // 底图尺寸必须**解码后**才知道；`SVGImageElement` 没有 `naturalWidth`，
  // 所以用一张 HTMLImage 预加载来测，再把尺寸回报给 model（fitView 要用）。
  useEffect(() => {
    if (!mapImage) { setMapImageSize(null); return }
    const img = new Image()
    img.onload = () => setMapImageSize({ w: img.naturalWidth || 1600, h: img.naturalHeight || 900 })
    img.onerror = () => setMapImageSize(null)
    img.src = mapImage
  }, [mapImage, setMapImageSize])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部工具条（通栏） */}
      <div className="px-4 py-2.5 border-b border-ink-700 flex items-center gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MapPin size={15} className="text-amber shrink-0" />
          <span className="font-semibold text-ink-100">{tab.name}</span>
          <span className="text-11 text-ink-500">{markers.length} 个范围 / {rows.length} 条地理条目 / 已绘制 {drawnIds.size}</span>
          <HelpPopover
            title="地图编辑"
            width="20rem"
            className="ml-1"
          >
            {'手绘格子地图 · 形状由你做主\n\n'
              + '· 左侧「地图」列表管理多张地图：新建 / 重命名 / 删除，每张图是一块独立画布，互相不干扰。切换地图只会换画布，不会动任何地点数据。\n'
              + '· 点「绘制地图」选择一个范围（建议从最大的范围开始）。左键单击涂/擦一格；按住拖动框选一片批量填涂，Shift+框选批量擦除；右键单击退出、右键拖动平移画布。\n'
              + '· 右上角「精 / 粗」切换格子档位：每格边长 1 公里（精细）或 10 公里（粗略）。切档后同一区域会等比例缩放，比例尺真实；画大陆用粗档快速铺满，画城池切回精档。\n'
              + '· 滚轮缩放画面、拖空白平移；拖动整块空间可挪位置（吸附整格）。\n'
              + '· 唯一规则：子范围必须完全画在父范围之内（无飞地）；祖先链上的范围可以叠涂，别的范围不行。\n'
              + '· 图层嵌套按「层级归属」自动分层，子空间格子叠涂在父空间之上。\n'
              + '· 颜色由系统按层级自动调配：父子高对比、兄弟错开，一眼区分隶属关系。\n'
              + '· 越界涂格会被拒绝；擦父格时若格子被子孙占用，会先提示你擦掉子孙。\n'
              + '· 点空间查看详情、继续绘制、跳转到表格编辑，或查看其上挂载的伏笔 / 角色 / 时间线（按「地理位置」字段联动）。\n'
              + '· 「删除地点」会连《地理风物》档案一起删；只想擦掉画好的格子，请用「清空绘制」。\n'
              + '· 《地理风物》只提供名称 / 类别 / 层级归属；「范围与面积」「相对地理位置」是自由文本备注，类别可在下拉里自定义。\n'
              + '· 左侧「地图」列表右端的地图信息按钮，可以改地图名称与说明 —— 说明会显示在右侧面板。'}
          </HelpPopover>
        </div>
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          {(['foreshadow', 'character', 'timeline'] as const).map(key => (
            <Button variant="bare"
              key={key}
              onClick={() => setLayers(l => ({ ...l, [key]: !l[key] }))}
              className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-11 transition-colors ${layers[key] ? 'border-amber/40 text-amber bg-amber/15' : 'border-ink-700 text-ink-400 hover:text-ink-200'}`}
              title={key === 'foreshadow' ? '叠加伏笔关联' : key === 'character' ? '叠加角色关联' : '叠加时间脉络关联'}
            >
              {mono
                ? <svg width="12" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" style={{ stroke: monoInk }} strokeWidth="1.6" strokeDasharray={monoLayerDash(key) || undefined} /></svg>
                : <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS[key] }} />}
              {key === 'foreshadow' ? '伏笔' : key === 'character' ? '角色' : '时间脉络'}
            </Button>
          ))}
          {painting && (
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-amber/50 bg-amber/10 text-11 text-amber">
              <Pencil size={11} /> 正在绘制：{byId.get(painting)?.name}
              <Button variant="bare" onClick={exitPaint} className="ml-0.5 text-ink-300 hover:text-ink-100" title="右键画布也可取消">完成</Button>
            </span>
          )}
          {/* 🔴 B8：图片底图 —— 只保留格子模式下可用的「绘制地图」；
              图片模式下改成「换底图 / 切回格子」，两种模式互斥（不能在图上叠加涂格）。 */}
          {mapMode === '格子' ? (
            <Button variant="bare" onClick={() => setDrawDialogOpen(true)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-11 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors" title="选择一个地理范围，用格子画出它的形状">
              <Pencil size={11} /> 绘制地图
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-amber/40 bg-amber/10 text-11 text-amber" title="当前为图片底图模式：滚轮缩放、拖动平移；地点标记照常可加">
              图片底图
            </span>
          )}
          <label
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-11 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors cursor-pointer"
            title={MAP_IMAGE_HINT_SPEC}
          >
            <input
              type="file"
              accept={MAP_IMAGE_ACCEPT}
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) void onPickMapImage(f)
                e.currentTarget.value = ''
              }}
            />
            <ImagePlus size={11} /> {mapMode === '图片' ? '换底图' : '上传底图'}
          </label>
          {mapMode === '图片' && (
            <Button
              variant="bare"
              onClick={() => void onPickMapImage(null)}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-11 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors"
              title="清掉底图，回到用格子画地图的模式"
            >
              <X size={11} /> 切回格子
            </Button>
          )}
          <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-11 text-ink-400 select-none" title="当前格子档位：每个格子的边长所代表的真实公里数（1 = 精细 / 10 = 粗略）。用旁边的「精 / 粗」按钮切换。">
            <span className="text-ink-500">每格</span>
            <span className="text-amber font-medium">1:{cellKm}</span>
            <span className="text-ink-500">公里</span>
          </span>
          <span className="flex items-center gap-1">
            <Button variant="bare" onClick={() => stepCellKm(-1)} disabled={cellKm === CELL_KM_STEPS[0]} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-11 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors disabled:opacity-40" title="提高精度：每格边长 ÷10（1 公里格，画小范围用）"><ZoomIn size={11} />精</Button>
            <Button variant="bare" onClick={() => stepCellKm(1)} disabled={cellKm === CELL_KM_STEPS[CELL_KM_STEPS.length - 1]} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-11 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors disabled:opacity-40" title="降低精度：每格边长 ×10（10 公里格，画大范围快速铺格子）"><ZoomOut size={11} />粗</Button>
            <Button variant="bare" onClick={fitView} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-11 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors" title="重置视图（内容居中）"><Maximize2 size={11} />重置</Button>
          </span>
        </div>
      </div>

      {/* 中段：地图列表 + 画布（两者严格等高） */}
      <div className="flex-1 flex min-h-0">
        <GeoMapList
          maps={maps}
          mapId={mapId}
          onPick={setMapId}
          rowCountOf={name => allRows.filter(r => (r.data['所属地图'] || '') === name).length}
          onChanged={() => void load()}
          disabled={loading}
        />
        <div ref={wrapRef} className="flex-1 min-w-0 relative overflow-hidden" style={{ background: 'rgb(var(--ink-900))' }}>
          {/* 空态提示必须 pointer-events-none，否则会挡住「单击空白新增」 */}
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center text-ink-500 text-sm pointer-events-none" style={{ zIndex: Z.pageHandle }}>加载地理数据…</div>
          ) : rows.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-ink-500 text-sm px-8 text-center pointer-events-none" style={{ zIndex: Z.pageHandle }}>
              <span>还没有《地理风物》数据。可以直接<strong className="text-ink-300">单击这里的空白处</strong>就地新增地点，也可以先去「地理风物」登记，回来用「绘制地图」给它画形状。</span>
            </div>
          ) : null}
          <svg
            id="geo-map-canvas"
            ref={svgRef}
            viewBox={`0 0 ${vp.w} ${vp.h}`}
            width={vp.w}
            height={vp.h}
            className="block"
            style={{ touchAction: 'none', cursor: painting ? 'cell' : 'grab' }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onContextMenu={e => e.preventDefault()}
          >
            <defs>
              <pattern id="gm-dots" width="26" height="26" patternUnits="userSpaceOnUse">
                {/* 主题化网格（表现属性不解析 var()，故走 style） */}
                <circle cx="1.4" cy="1.4" r="1" style={{ fill: 'rgb(var(--graph-grid))' }} opacity={mono ? 1 : (painting ? 0.32 : 0.22)} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#gm-dots)" pointerEvents="none" />
            {/* 背景交互层：拖动平移；原地松手 = 空白新增（绘制模式下原地松手 = 涂格） */}
            <rect width="100%" height="100%" fill="transparent" onPointerDown={e => onPointerDown(e as RPointerEvent<SVGElement>, 'pan')} />

            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* 🔴 B8：图片底图 —— 放在格子层**之前**（图在下、格子与标记在上）。
                  世界坐标 = 图片像素尺寸（1px = 1 世界单位），与地点标记共用同一坐标系，
                  所以滚轮缩放 / 拖动平移**完全复用外层这个 <g> 的 transform**，
                  不另搞一套 pan/zoom（也就天然满足了"滚轮位移要按界面缩放折算"这条红线 ——
                  折算逻辑在既有的 pan/zoom 里已经处理过了）。 */}
              {mapMode === '图片' && mapImage && (
                <image
                  href={mapImage}
                  x={0}
                  y={0}
                  width={mapImageSize?.w || 1600}
                  height={mapImageSize?.h || 900}
                  preserveAspectRatio="none"
                  style={{ pointerEvents: 'none' }}
                />
              )}
              {/* 格子地图：按层级深度从浅到深分层渲染——父空间格子铺底，子空间作为「另一图层」叠涂其上。
                  颜色由系统按层级自动调配（父子高对比）；渲染按当前档位聚合（满 n×n 块=大格，零散=1km 小格）。 */}
              {[...markers]
                .filter(m => drawnIds.has(m.id))
                .sort((a, b) => (depthMap.get(a.id) ?? 0) - (depthMap.get(b.id) ?? 0))
                .map(mk => {
                  const vs = viewShapes.get(mk.id); if (!vs) return null
                  // 🔴 mono：层级配色失效 ⇒ 改成「白底 + 黑边」，层级改由**轮廓线型按深度**承载
                  const col = mono ? monoInk : (spaceColors.get(mk.id) || MAP_SPACE_FALLBACK)
                  const fillCol = mono ? 'rgb(var(--graph-node))' : col
                  const active = hover === mk.id || selected === mk.id
                  const dim = hover && !active
                  const depth = depthMap.get(mk.id) ?? 0
                  // 层级线型：必须在 depth 之后算
                  const colDash = mono ? (MONO_DASHES[depth % MONO_DASHES.length] || undefined) : undefined
                  const fillOp = depth === 0 ? 0.16 : depth === 1 ? 0.30 : 0.42
                  // 🔴 字号按精度档位分档（主人 2026-10-17，OPT-006/007）：
                  //    原实现字号只随层级深度递减、与精度档位无关 ⇒ 主人实测
                  //    「粗精度模式文字太大 / 精精度模式文字太小」两种观感同时命中。
                  //    精（cellKm=1，1km/格、画小范围细看）基础 20；粗（10km/格、看大范围铺量）
                  //    基础 13；层级递减两档一致（-2/级），下限随基数（13 / 10）。
                  const fsBase = cellKm >= 10 ? 13 : 20
                  const fs = Math.max(cellKm >= 10 ? 10 : 13, fsBase - depth * 2)
                  // 根范围标签放包围盒右上角外（右对齐），子/孙放各自包围盒左上角外（左对齐）——避免父子名字重叠
                  const isTop = depth === 0
                  const tx = isTop ? vs.bbox.x + vs.bbox.w + 4 : vs.bbox.x + 2
                  const anchor = isTop ? 'end' : 'start'
                  // mono 下整组 opacity 0.4 会把「白底 + 黑边」合成成灰 ⇒ 淡化改由**线宽**承载
                  return (
                    <g key={mk.id} data-space-id={mk.id} opacity={mono ? 1 : (dim ? 0.4 : 1)}
                      onMouseEnter={() => setHover(mk.id)} onMouseLeave={() => setHover(null)}
                      onPointerDown={e => onPointerDown(e, 'node', mk)}
                      style={{ cursor: painting ? 'cell' : (selected === mk.id ? 'pointer' : 'grab') }}>
                      {vs.full.map(([bx, by]) => (
                        <rect key={`f${bx},${by}`} x={bx * G + 0.7} y={by * G + 0.7} width={G - 1.4} height={G - 1.4} rx={1.5}
                          fillOpacity={mono ? 1 : fillOp} strokeOpacity={mono ? 1 : (active ? 0.95 : 0.45)} strokeWidth={active ? 1.4 : 0.8} strokeDasharray={colDash}
                          style={{ fill: fillCol, stroke: col }} />
                      ))}
                      {vs.rest.map(([gx, gy]) => (
                        <rect key={`r${gx},${gy}`} x={(gx / cellKm) * G + 0.3} y={(gy / cellKm) * G + 0.3} width={G / cellKm - 0.5} height={G / cellKm - 0.5} rx={G / cellKm / 5}
                          fillOpacity={mono ? 1 : fillOp} strokeOpacity={mono ? 1 : (active ? 0.9 : 0.4)} strokeWidth={active ? 1 : 0.5} strokeDasharray={colDash}
                          style={{ fill: fillCol, stroke: col }} />
                      ))}
                      {/* 🔴 标签格式两档统一（主人 2026-10-17 澄清）：单行「名称（类别）」，
                          不显示格数 —— 「格是很好数的一个东西」，画布上数格子不如看面板。
                          格数仍在右侧详情面板（「当前形状：N 格」）与左栏树列表里可查。 */}
                      <text x={tx} y={vs.bbox.y - 5} textAnchor={anchor} fontSize={fs} fontWeight={600} pointerEvents="none"
                        style={{ fill: col, paintOrder: 'stroke', stroke: 'rgb(var(--graph-halo))', strokeWidth: 3.5 }}>{mk.name}（{mk.category}）</text>
                      {active && !painting && (
                        <text x={tx} y={vs.bbox.y - 5 + fs + 3} textAnchor={anchor} fontSize={fs - 3.5} pointerEvents="none"
                          style={{ fill: 'rgb(var(--graph-accent-text))', paintOrder: 'stroke', stroke: 'rgb(var(--graph-halo))', strokeWidth: 3 }}>详情面板可绘制 · 拖动整体平移</text>
                      )}
                    </g>
                  )
                })}

              {/* 绘制模式框选预览（档位块矩形） */}
              {painting && selRect && (() => {
                const x0 = Math.min(selRect.x0, selRect.x1) * G
                const y0 = Math.min(selRect.y0, selRect.y1) * G
                const w = (Math.abs(selRect.x1 - selRect.x0) + 1) * G
                const h = (Math.abs(selRect.y1 - selRect.y0) + 1) * G
                return (
                  <rect x={x0} y={y0} width={w} height={h} rx={2}
                    style={{ fill: 'rgb(var(--graph-accent-text))', stroke: 'rgb(var(--graph-accent-text))' }} fillOpacity={mono ? 1 : 0.18} strokeWidth={1.5} strokeDasharray="6 4" pointerEvents="none" />
                )
              })()}

              {/* 关联高亮框（贴合格子风格，挂在格子包围盒外圈） */}
              {markers.map(mk => {
                if (!drawnIds.has(mk.id)) return null
                const lk = linked.get(mk.id)
                if (!lk) return null
                const vs = viewShapes.get(mk.id)
                if (!vs) return null
                const cx = vs.bbox.x + vs.bbox.w / 2, cy = vs.bbox.y + vs.bbox.h / 2
                const rr = Math.max(vs.bbox.w, vs.bbox.h) / 2
                const rings: { key: 'foreshadow' | 'character' | 'timeline'; color: string }[] = []
                if (layers.foreshadow && lk.foreshadow.length) rings.push({ key: 'foreshadow', color: LAYER_COLORS.foreshadow })
                if (layers.character && lk.character.length) rings.push({ key: 'character', color: LAYER_COLORS.character })
                if (layers.timeline && lk.timeline.length) rings.push({ key: 'timeline', color: LAYER_COLORS.timeline })
                if (rings.length === 0) return null
                return (
                  <g key={`ring-${mk.id}`} pointerEvents="none">
                    {rings.map((ring, ri) => {
                      const pad = 6 + ri * 4
                      return (
                        <rect key={ri} x={cx - rr - pad} y={cy - rr - pad} width={(rr + pad) * 2} height={(rr + pad) * 2} rx={4}
                          fill="none" style={{ stroke: mono ? monoInk : ring.color }} strokeWidth={2} strokeOpacity={mono ? 1 : 0.85}
                          strokeDasharray={mono ? (monoLayerDash(ring.key) || undefined) : undefined} />
                      )
                    })}
                  </g>
                )
              })}

            </g>
          </svg>
        </div>

        {/* 右侧详情 / 新增面板：高度与画布严格一致 */}
        <div className="w-80 shrink-0 border-l border-ink-700 bg-ink-850/60 overflow-y-auto">
          <div className="p-4">
            {addPos ? (
            <AddMarkerForm
              categories={categoryNames}
                parentOptions={markers.map(m => m.name)}
                onCancel={() => setAddPos(null)}
                onCreate={createMarker}
              />
            ) : selMarker ? (
              <DetailPanel
                marker={selMarker}
                linked={selLinked}
                cells={spaceShapes.get(selMarker.id)?.cells.size ?? 0}
                categories={categoryNames}
                painting={painting === selMarker.id}
                parentOptions={markers.filter(m => m.id !== selMarker.id).map(m => m.name)}
                onPatch={updateSelected}
                onClearPainted={clearCoords}
                onPaint={() => enterPaint(selMarker.id)}
                onDelete={deleteMarker}
                onGotoTable={gotoTable}
              />
            ) : (
              <div className="text-12 text-ink-400 space-y-3">
                <div className="flex items-center gap-2 text-ink-200">
                  <MapPin size={14} className="text-amber shrink-0" />
                  <span className="truncate">{curMapName || '地图'} · 说明</span>
                </div>
                {mapNote ? (
                  <p className="whitespace-pre-wrap text-ink-300 leading-relaxed">{mapNote}</p>
                ) : (
                  <p className="text-ink-500 leading-relaxed">
                    这张地图还没写说明。点左侧列表里该地图右端的<strong className="text-ink-300">地图信息</strong>按钮，
                    可以补一段 —— 比如它画的是哪片区域、有哪些约定、画到哪一步了。
                  </p>
                )}
                <p className="text-ink-500 leading-relaxed pt-2 border-t border-ink-700/70">
                  操作指引见右上角问号；点画布上的范围查看详情、继续绘制或跳转表格，点空白处可就地新增地点。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部状态条：叠加图层 + 操作提示（颜色由系统按层级自动调配，不再按类别展示色卡） */}
      <div className="px-4 py-1.5 border-t border-ink-700 flex items-center gap-3 flex-wrap text-10 text-ink-400 shrink-0">
        <span className="flex items-center gap-1.5">
          {mono
            ? <svg width="12" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" style={{ stroke: monoInk }} strokeWidth="1.6" strokeDasharray="7 5" /></svg>
            : <span className="w-3 h-3px rounded-full inline-block" style={{ background: MAP_SPACE_FALLBACK }} />}
          {mono ? '黑白下按轮廓线型与名称区分层级' : '颜色按层级自动调配（父子高对比 · 兄弟错开）'}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {anyLayerOn && (
            <>叠加：
              {layers.foreshadow && <span className="flex items-center gap-1">
                {mono ? <svg width="12" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" style={{ stroke: monoInk }} strokeWidth="1.6" strokeDasharray={monoLayerDash('foreshadow') || undefined} /></svg> : <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS.foreshadow }} />}
                伏笔</span>}
              {layers.character && <span className="flex items-center gap-1">
                {mono ? <svg width="12" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" style={{ stroke: monoInk }} strokeWidth="1.6" strokeDasharray={monoLayerDash('character') || undefined} /></svg> : <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS.character }} />}
                角色</span>}
              {layers.timeline && <span className="flex items-center gap-1">
                {mono ? <svg width="12" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" style={{ stroke: monoInk }} strokeWidth="1.6" strokeDasharray={monoLayerDash('timeline') || undefined} /></svg> : <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS.timeline }} />}
                时间脉络</span>}
            </>
          )}
          <span className="text-ink-500">{painting ? '绘制中：左键涂/擦 · 拖动框选批量填涂（Shift=批量擦） · 右键退出/平移' : '单击空白新增 · 拖空白平移 · 滚轮缩放画面'}</span>
        </span>
      </div>

      {drawDialogOpen && (
        <DrawDialog
          rows={rows}
          drawnCells={new Map(markers.filter(m => (spaceShapes.get(m.id)?.cells.size ?? 0) > 0).map(m => [m.id, spaceShapes.get(m.id)!.cells.size]))}
          onPick={enterPaint}
          onClose={() => setDrawDialogOpen(false)}
        />
      )}
    </div>
  )
}
