/** Serializable Playwright page.evaluate callback. No Node dependencies inside. */
function scanRenderedPaint({ binary = true } = {}) {
  const violations = [], unknown = []
  let painted = 0
  const alpha = v => Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : 1
  /**
   * 把 CSS 颜色解析成 `{ rgb:[r,g,b], a }`（0–255 / 0–1）。
   *
   * 🔴 2026-10-19 起必须支持 oklch / oklab：
   *    Tailwind v4 的调色板是 oklch，`getComputedStyle` 在某些属性上原样吐 `oklch(...)`
   *    （实测节奏带、时间轴的 `stroke`）。只认 rgb() 会把它们全塞进 `unknown`，
   *    契约就永远 blocked —— 而画面其实是对的（mono 下零彩色、严格二值都过）。
   *    这里按 CSS Color 4 的标准公式换回 sRGB，宁可换算后严格判，也不放过。
   */
  const colour = value => {
    const v = String(value).trim()
    const m = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(v)
    if (m) return { rgb: m.slice(1, 4).map(Number), a: alpha(m[4]) }

    // oklch(L C H[ / A]) 或 oklab(L a b[ / A])；L 可以是 0–1 或百分比
    const om = /^okl(ch|ab)\(\s*([\d.]+)(%?)\s+([-\d.]+)\s+([-\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/.exec(v)
    if (!om) return null
    const lu = om[3] === '%' ? Number(om[2]) / 100 : Number(om[2])
    let A, B
    if (om[1] === 'ch') {
      const C = Number(om[4])
      const H = Number(om[5]) * Math.PI / 180
      A = C * Math.cos(H); B = C * Math.sin(H)
    } else {
      A = Number(om[4]); B = Number(om[5])
    }
    // oklab → LMS → 线性 RGB
    const l_ = lu + 0.3963377774 * A + 0.2158037573 * B
    const m_ = lu - 0.1055613458 * A - 0.0638541728 * B
    const s_ = lu - 0.0894841775 * A - 1.2914855480 * B
    const l = l_ ** 3, mm = m_ ** 3, s = s_ ** 3
    const lin = [
      +4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s,
    ]
    const enc = x => {
      const c = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055
      return Math.min(255, Math.max(0, Math.round(c * 255)))
    }
    const aRaw = om[6] === undefined ? 1 : (om[7] === '%' ? Number(om[6]) / 100 : Number(om[6]))
    return { rgb: lin.map(enc), a: alpha(aRaw) }
  }
  const visible = el => {
    let opacity = 1
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return null
      opacity *= alpha(s.opacity)
    }
    return opacity > 0 ? opacity : null
  }
  for (const el of document.querySelectorAll('svg path,svg line,svg circle,svg ellipse,svg rect,svg polygon,svg polyline,svg text')) {
    // Definitions are not rendered in isolation. Record referenced paint servers separately.
    if (el.closest('defs')) continue
    const opacity = visible(el)
    if (opacity === null || !el.getClientRects().length) continue
    const cs = getComputedStyle(el)
    for (const prop of ['fill', 'stroke']) {
      const value = cs.getPropertyValue(prop)
      if (value === 'none' || (prop === 'stroke' && Number.parseFloat(cs.strokeWidth) === 0)) continue
      // A line has no interior. Its default fill is not painted.
      if (prop === 'fill' && ['line', 'polyline'].includes(el.localName)) continue
      const c = colour(value)
      if (!c) {
        const match = /url\(["']?(?:[^#]*#)([^)"']+)/.exec(value)
        const server = match && document.getElementById(match[1])
        if (server) {
          const paints = server.querySelectorAll('circle,rect,path,stop')
          for (const paint of paints) {
            const s = getComputedStyle(paint)
            const key = paint.localName === 'stop' ? 'stop-color' : prop
            const resolved = colour(s.getPropertyValue(key))
            if (!resolved) { if (s.getPropertyValue(key) !== 'none') unknown.push(`paint server ${match[1]}: unresolved ${key}`); continue }
            const a = resolved.a * opacity * alpha(s.getPropertyValue(paint.localName === 'stop' ? 'stop-opacity' : `${prop}-opacity`))
            const rgb = resolved.rgb.map(v => Math.round(a * v + (1 - a) * 255))
            painted++
            if (binary ? !rgb.every(v => v === 0) && !rgb.every(v => v === 255) : Math.max(...rgb) !== Math.min(...rgb)) violations.push(`paint server ${match[1]} ${key} => rgb(${rgb.join(',')})`)
          }
          if (!paints.length) unknown.push(`paint server ${match[1]} has no inspectable samples`)
        } else unknown.push(`${el.localName}.${prop}: unsupported paint ${value}`)
        continue
      }
      // CSSOM property names must be kebab case: strokeOpacity is NOT getPropertyValue('stroke-opacity').
      const a = c.a * opacity * alpha(cs.getPropertyValue(`${prop}-opacity`))
      if (!a) continue
      painted++
      const rgb = c.rgb.map(v => Math.round(a * v + (1 - a) * 255))
      const good = binary ? rgb.every(v => v === 0) || rgb.every(v => v === 255) : Math.max(...rgb) === Math.min(...rgb)
      if (!good) violations.push(`${el.localName}.${prop}=${value} alpha=${a.toFixed(3)} => rgb(${rgb.join(',')})`)
    }
  }
  // Plot cards and pace bands are HTML/CSS, so an SVG-only scan cannot validate them.
  for (const host of document.querySelectorAll('div.flex.h-7 > div[title][style], div.group.absolute[style]')) {
    for (const el of [host, ...host.querySelectorAll('[style]')]) {
      const opacity = visible(el)
      if (opacity === null) continue
      const cs = getComputedStyle(el)
      const values = [['color', cs.color], ['background', cs.backgroundColor]]
      if (Number.parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') values.push(['border', cs.borderTopColor])
      const image = cs.backgroundImage
      if (image !== 'none') {
        const colours = image.match(/rgba?\([^)]*\)/g)
        if (colours) for (const c of colours) values.push(['gradient', c])
        else unknown.push(`HTML unsupported background-image: ${image}`)
      }
      for (const [prop, value] of values) {
        const c = colour(value)
        if (!c) { unknown.push(`HTML ${prop}: unsupported ${value}`); continue }
        const a = c.a * opacity
        if (!a) continue
        painted++
        const rgb = c.rgb.map(v => Math.round(a * v + (1 - a) * 255))
        const good = binary ? rgb.every(v => v === 0) || rgb.every(v => v === 255) : Math.max(...rgb) === Math.min(...rgb)
        if (!good) violations.push(`HTML ${prop}=${value} alpha=${a.toFixed(3)} => rgb(${rgb.join(',')})`)
      }
    }
  }
  return { theme: document.documentElement.dataset.theme, painted, violations, unknown }
}
module.exports = { scanRenderedPaint }
