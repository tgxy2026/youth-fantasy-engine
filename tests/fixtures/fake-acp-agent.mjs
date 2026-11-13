import readline from 'node:readline'

const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const sessionId = 'synthetic-session'
let pending
let model = 'default-model'
let thinking = 'low'
const options = () => [
  { id: 'model', category: 'model', currentValue: model, options: [{ value: 'default-model', name: '默认' }, { value: 'second-model', name: '第二个' }] },
  { id: 'thought_level', category: 'thought_level', currentValue: thinking, options: [{ value: 'low', name: '低' }, { value: 'high', name: '高' }] },
]
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  const result = value => send({ id: msg.id, result: value })
  const chunk = (id, text) => send({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  })
  switch (msg.method) {
    case 'initialize':
      result({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'oauth-personal', name: '假登录' }] })
      break
    case 'authenticate':
      if (msg.params.methodId !== 'oauth-personal') throw Error('Unexpected auth method')
      result({})
      break
    case 'session/new':
      if (msg.params.cwd !== process.cwd() || msg.params.mcpServers.length) throw Error('Unexpected context')
      result({ sessionId, configOptions: options() })
      break
    case 'session/set_config_option':
      if (msg.params.configId === 'model') model = msg.params.value
      else if (msg.params.configId === 'thought_level') thinking = msg.params.value
      else throw Error('Unexpected session option')
      result({ configOptions: options() })
      break
    case 'session/prompt': {
      const text = msg.params.prompt[0].text
      if (text === 'invalid') {
        process.stdout.write('invalid json\n')
      } else if (text === 'tool') {
        send({ id: 'tool-1', method: 'fs/read_text_file', params: { sessionId, path: 'synthetic-secret' } })
      } else if (text === 'terminal') {
        send({ id: 'tool-1', method: 'terminal/create', params: { sessionId, command: 'synthetic-command' } })
      } else if (text === 'mcp') {
        send({ id: 'tool-1', method: 'mcp/tools/call', params: { sessionId, name: 'synthetic-tool' } })
      } else if (text === 'permission') {
        send({ id: 'tool-1', method: 'session/request_permission', params: { sessionId } })
      } else if (text === 'tool-update') {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call' } } })
      } else if (text === 'model-and-thinking') {
        chunk(sessionId, model + '/' + thinking)
        result({ stopReason: 'end_turn' })
      } else {
        chunk('stale-session', 'stale')
        chunk(sessionId, '合成')
        if (text === 'cancel') pending = msg.id
        else { chunk(sessionId, '作品'); result({ stopReason: 'end_turn' }) }
      }
      break
    }
    case 'session/cancel':
      chunk(sessionId, '取消后片段')
      send({ id: pending, result: { stopReason: 'cancelled' } })
      break
  }
})
