/** Serializable Playwright page.evaluate callback. No Node dependencies inside. */
function scanRenderedPaint({ binary = true } = {}) {
  const violations = [], unknown = []
  let painted = 0
  const alpha = v => Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : 1
  const colour = value => {
    const m = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value)
    return m && { rgb: m.slice(1, 4).map(Number), a: alpha(m[4]) }
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
