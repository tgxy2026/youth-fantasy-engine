import { isLocalModelAddress, isLocalModelProvider } from '../src/lib/aiCore/localModelPolicy'

let pass = 0, fail = 0
function check(name: string, condition: boolean) {
  if (condition) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}`) }
}
for (const address of [
  'http://localhost:11434', 'http://sub.localhost:80', 'http://127.0.0.2', 'http://127.1',
  'http://10.3.2.1', 'http://172.16.3.2', 'http://172.31.2.2', 'http://192.168.1.1',
  'http://169.254.1.4', 'http://100.64.1.2', 'http://[::1]:8080', 'http://[::]:8080',
  'http://[fd00::42]', 'http://[fe80::1234]', 'http://[::ffff:192.168.1.1]',
  'http://model.local:8080', 'http://model.internal', 'http://modelserver',
]) check(`识别本地或局域网 ${address}`, isLocalModelAddress(address))
for (const address of ['https://api.example.com/v1', 'https://172.32.1.1', 'https://[2001:db8::1]', 'https://localhost.example.com', 'not a url']) {
  check(`不把公网或无效地址误认本地 ${address}`, !isLocalModelAddress(address))
}
check('本地标记不会被公网地址绕过', isLocalModelProvider({ type: 'openai', local: true, baseUrl: 'https://example.com/v1' }))
check('本地地址不会被联网标记绕过', isLocalModelProvider({ type: 'openai', local: false, baseUrl: 'http://127.0.0.1/v1' }))
check('Ollama 类型仍视为本地配置', isLocalModelProvider({ type: 'ollama', baseUrl: 'https://example.com' }))
check('普通公网兼容服务不误判本地', !isLocalModelProvider({ type: 'openai', local: false, baseUrl: 'https://api.example.com/v1' }))
console.log(`localModelPolicy：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
