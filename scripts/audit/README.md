# 审计工具与历史入口

## 3.2.2 发布前与窗口适配探针

在仓库根目录依次运行（需要本机 Node、Playwright、Edge 与 Electron）：

```powershell
node scripts/audit/probes/workspace-layout-probe.cjs
node scripts/audit/probes/tablet-interaction-probe.cjs
node scripts/audit/probes/sidebar-layout-probe.cjs
node scripts/audit/probes/revision-reliability-probe.cjs
node node_modules/vite/bin/vite.js build --outDir .workbuddy/tmp/pre-release-3.2.2/build
node scripts/audit/probes/pre-release-runtime-probe.cjs
node scripts/release-check.mjs --source-only --dist .workbuddy/tmp/pre-release-3.2.2/build
```

布局探针检查全部可见项目页签和 7 组窗口/缩放组合，实际操作探针使用带触摸标记的独立浏览器上下文。侧栏和修订探针使用隔离的 Electron userData/appData；生产探针使用本次构建、真实便携服务、临时文件和本机假模型。原生文件窗口的返回值替换、迁移锁注入等边界在各脚本中明确标注。

结果与截图保留在各次新建的 `.workbuddy/tmp/` 目录；开发探针各用独立缓存，建议依次执行以减少资源竞争。不得用源码阶段通过代替安装包验收；不带 `--source-only` 的发布检查会要求本版两个便携包和一个安装包，旧包不能充当本版产物。记录见 `docs/3.2.2-发布前检查与待办-2026-10-23.md` 与 `docs/3.2.2-窗口适配验收-2026-10-23.md`。

## 三端兼容专项（2026-10-18新增）

```powershell
node .workbuddy/tmp/audit-platform.mjs --matrix
# 可选统一调度（不改变原默认审计范围）
node scripts/audit/run.mjs --platform --matrix
```

桌面、便携、网页云端、网页游客分别管理，另有dev对照。网页云端PORTABLE也为真，专项从真实源码推演平台标记与后端，检查跨形态冲突候选并保留26个运行取证单元。`--base`仅辅助定位改动，`--evidence`录入带责任人/期限及产物哈希的治理记录。

规则及白名单差异在 `scripts/audit/platform/policy.json`；方案见 `docs/三端兼容专项审计与治理方案-2026-10-18.md`。专项指纹覆盖server、构建脚本及资产，与原通用指纹范围不同，旧证据不能直接复用。默认只读源码，不连接生产、不读写实际稿件、不执行部署。

原11个路径不变；恢复入口脚本会额外恢复audit-platform入口。新增 `.workbuddy/tools/audit-platform.mjs` 也可直接调用。不要把本专项与投稿平台预检 `src/lib/audit/platformCheck.ts` 混用。

## 原调用路径保持不变

以下命令及可选的工作区路径参数继续可用：

```powershell
node .workbuddy/tmp/audit-scan.mjs
node .workbuddy/tmp/audit-func.mjs
node .workbuddy/tmp/audit-ui.mjs
node .workbuddy/tmp/audit-coverage.mjs
```

`dead / graph / arch / content / prompt / sec / label-consistency` 的原 `audit-*.mjs` 路径也保留，共11个。原 `audit-scan-report.md` 输出路径保持不变。历史文本报告保留，增加的 AST 部分以独立标题追加。

旧文件现在是兼容入口，规则放在 `scripts/audit/legacy/`，只维护一份。默认完整输出候选，不再因前10/15条的截断遗漏后面的条目；需要旧精简输出时设置 `YFE_AUDIT_FULL=0`。代码片段和同组示例仍可能缩短，候选清单及原始日志保留。

新克隆中 `.workbuddy/tmp` 不入库，可恢复相同入口：

```powershell
node scripts/audit/install-entrypoints.mjs
```

已有非兼容入口时该命令拒绝覆盖。明确要升级则使用 `--replace`：旧脚本先逐文件备份到 `.workbuddy/tmp/audit-entrypoints-backup-*`，不删除任何临时目录或恢复包。

## 新增统一报告（可选，原调用方不必改命令）

```powershell
node scripts/audit/run.mjs --probes
```

执行11个旧扫描器、AST检查和离线请求头边界审计，输出 `.workbuddy/tmp/audit/<timestamp>/report.json`、`report.md` 及每个扫描器日志。`--no-legacy` 可以只执行新增规则。

离线审计调用当前生产函数；不读取模型密钥、不连接服务商、不写用户项目。它检查头名大小写、默认行为、非法名称、CR/LF/NUL与非ByteString值；只是协议边界检查，不等同于真实服务可用。

退出码：`0` = 所有必需证据齐全且候选已复核；`1` = 已确认失败；`2` = 仍有未验证、受阻或待复核项。旧扫描器执行成功只记 `executed`，不能推成整个产品通过。

## 漏检防护

- AST区分注释、实际代码、类型与回调使用，给出文件/行号/规则/置信度；草稿切换及孤立说明生成器属于候选，不直接断言缺陷。
- 自动列出显式绘图及mono感知组件；新的图表未登记会要求复核，不能因为清单里没有它而悄悄通过。
- 黑白共享扫描器正确使用 `fill-opacity / stroke-opacity`，检查自身和祖先透明度、可见图形、引用的pattern/渐变，以及HTML情节卡片和节奏纹理。无法识别的绘制属性进入unknown，不能按零问题通过。
- SVG线条不存在的填充、未渲染的defs、隐藏元素不冒充实际绘制样本。颜色合成按mono白底检查，不是像素级截图/图片分析；自定义滤镜、混合模式或复杂遮罩仍需人工核查。
- 原 `verify-mono-charts.cjs` 路径保留，补绘图数据样本前提、严格扫描及HTML绘图检查；空情节画布会要求补数据，而非把“无彩色”当通过。
- 原 `verify-custom-headers.cjs` 路径保留，仍测新增和编辑预设入口；UI证据不代替实际HTTP出口/鉴权证据。
- 六项必需运行契约见 `contracts.json`。默认缺证据就显示unverified；没有运行桌面/双设备时不得冒充验收完成。

## 运行证据与销账

两支现有浏览器脚本新增结构化JSON输出，并打印 `Structured evidence:` 路径。脚本执行方式和环境变量不变。报告包含整个 `src/` 和 `electron/` 的内容指纹（含未提交改动），运行中改源码或拿旧报告复用会失效。

将本轮证据传入：

```powershell
node scripts/audit/run.mjs --probes --evidence .workbuddy/tmp/本轮证据.json
```

证据格式：

```json
{
  "sourceFingerprint": "本轮报告里的源码指纹",
  "checks": [
    {"id":"preset.routes","status":"passed","samples":2,"cases":["new","edit"],"artifact":"实际存在的本轮日志.json"}
  ],
  "reviews": [
    {"file":"src/某文件.tsx","line":42,"rule":"draft.switch","status":"dismissed","reason":"至少10字的具体复核原因及保护机制"}
  ]
}
```

允许状态passed/failed/blocked；每个契约ID只能出现一次。mono证据必须包含8个图表文件、正确主题和正样本；草稿失败和导入导出各有必需场景。不同脚本的checks可合并到同一JSON，但指纹必须完全相同。产物内容仍要人工核实，指纹不能防止伪造证据。

静态候选默认unreviewed；用confirmed/dismissed和原因销账。不使用整个目录的永久忽略规则，旧版本的豁免不能自动沿用到新源码。

## 本次运行范围

本次实际执行静态扫描器、兼容旧入口、离线边界审计和脚本语法检查；没有新增或执行项目单元测试，也没有执行完整浏览器/桌面验收。新工具检出的业务问题只记录，不自动改业务代码。
