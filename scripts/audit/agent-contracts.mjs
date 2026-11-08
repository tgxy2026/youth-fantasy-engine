// The case labels bind audit coverage to assertions that actually ran in the isolated fixtures.
export const AGENT_AUDIT = {
  'agent.routing': { test: 'backendTrack', cases: {
    fallback: '未显式选择 ⇒ 保底轨纯透传（配置了 Agent 也一样）',
    automatic: 'auto-silent 经 chat() 闸仍强制保底',
    json: 'json-string 经 chat() 闸：抛错留痕不伪装成功',
    events: 'chat() 显式 Agent + text ⇒ 只回 message 正文',
    quota: 'Agent 轨用量记 source=agent + quota=subscription',
    cancel: 'signal 取消映射 session.cancel 并抛 AICancelled',
    earlyCancel: '提前取消即使 send 抛错仍保留取消口径',
    cleanup: 'Agent 完成后移除取消监听器',
    jsonMismatch: 'JSON 参数与任务声明不一致仍强制硬闸',
    artifactChat: 'chat 拒绝无法返回的产物任务并留痕',
    failure: 'Agent 创建会话异常记失败',
    enhance: '增强轨：手动+显式 ⇒ 产物 descriptor',
  } },
  'agent.readonly': { test: 'mcpReadonlyBridge', cases: {
    tools: '工具清单 = 12 个只读工具，无写工具',
    desktop: '单章正文完整可读',
    portable: '便携数组形态：项目/正文/灵感/表单全可读',
    secrets: '全程输出无明文 apiKey / 检索密钥',
    noWrite: '会话后数据文件 sha256 不变',
    web: '数据文件缺失 → isError 且明说网页版不可用',
  } },
}
