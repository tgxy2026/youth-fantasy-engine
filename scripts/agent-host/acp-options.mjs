const categories = {
  model: option => option.category === 'model' || option.id === 'model',
  thinking: option => ['thought_level', 'thinking_level'].includes(option.category) || option.id === 'thinking',
}

function valuesOf(entries, depth = 0) {
  if (!Array.isArray(entries) || depth > 3) return []
  return entries.slice(0, 100).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    if (typeof entry.value === 'string' && entry.value.length <= 256 && typeof entry.name === 'string') {
      return [{ value: entry.value, name: entry.name.slice(0, 120) }]
    }
    return valuesOf(entry.options, depth + 1)
  }).slice(0, 100)
}

export function readSessionOptions(session) {
  const options = Array.isArray(session?.configOptions) ? session.configOptions : []
  const result = {}
  for (const [key, match] of Object.entries(categories)) {
    const option = options.find(value => value && typeof value.id === 'string' && value.id.length <= 256 && match(value))
    if (!option) continue
    const values = valuesOf(option.options)
    if (values.length) result[key] = {
      id: option.id,
      current: values.some(item => item.value === option.currentValue) ? option.currentValue : undefined,
      values,
    }
  }
  return result
}

export async function applySessionOptions(client, session, config, signal) {
  let options = readSessionOptions(session)
  for (const key of Object.keys(categories)) {
    const value = config[key]
    if (!value) continue
    const option = options[key]
    if (!option?.values.some(item => item.value === value)) throw new Error('所选模型或推理档位已不可用，请刷新 ACP 选项。')
    if (option.current === value) continue
    const result = await client.request('session/set_config_option', {
      sessionId: session.sessionId, configId: option.id, value,
    }, undefined, signal)
    options = readSessionOptions(result)
    if (options[key]?.current !== value) throw new Error('ACP Agent 未确认选项生效。')
  }
  return options
}
