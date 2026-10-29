/** Resolve a neighbour in the current sorted grid without crossing a row boundary. */
export function atlasGridNeighbour(ids: readonly string[], current: string, columns: number, key: string): string | null {
  const index = ids.indexOf(current)
  if (index < 0 || !Number.isSafeInteger(columns) || columns < 1) return null
  const col = index % columns
  let target: number
  switch (key) {
    case 'ArrowLeft': if (col === 0) return null; target = index - 1; break
    case 'ArrowRight': if (col === columns - 1) return null; target = index + 1; break
    case 'ArrowUp': target = index - columns; break
    case 'ArrowDown': target = index + columns; break
    default: return null
  }
  return target >= 0 && target < ids.length ? ids[target] : null
}

/** Detail navigation follows display order independently of grid layout. */
export function atlasDetailNeighbour(ids: readonly string[], current: string, key: string): string | null {
  const index = ids.indexOf(current)
  if (index < 0) return null
  const step = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : key === 'ArrowDown' || key === 'ArrowRight' ? 1 : 0
  const target = index + step
  return step && target >= 0 && target < ids.length ? ids[target] : null
}
