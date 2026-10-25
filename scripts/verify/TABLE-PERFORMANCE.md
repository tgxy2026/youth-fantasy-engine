# 大表生产构建基准（P0，分阶段接入）

对应 [3.2.3 大表方案](../../docs/3.2.3-大表编辑性能优化方案-2026-10-24.md)。当前实现七类确定性数据生成、表格核心指标的生产构建测量。**P0 尚未全部完成，P1/P2 尚未实施。**

~~~powershell
# 默认 medium + large，真正游客模式/隔离 IndexedDB
node scripts/verify/table-performance.mjs --mode measure --profile local
# 相同源码、生产构建口径；真实便携服务/隔离本地文件，顺序单独运行
node scripts/verify/table-performance.mjs --mode measure --backend portable --fixture medium,large
# 小样本只检查链路，禁止当基线或正式通过
node scripts/verify/table-performance.mjs --mode smoke --fixture small
# 单个fixture与指定的冻结结果比较（路径指向上一轮的baseline.json）
node scripts/verify/table-performance.mjs --mode compare --fixture medium --baseline <baseline.json>
~~~

每次创建新的 `.workbuddy/tmp/table-performance-*` 目录，生产构建写入该目录，不使用旧 dist，不封装安装包。使用已安装的 Edge headless；没有环境则失败并保留原因。运行期间独占测量队列，不与构建、测试、其他 UI 探针并行。

每次都会生成 small、medium、large、tree、mixed、project-switch、longbook 七类 JSON 和预期数据。列来自当前 schema 门面与 atlasColumnsOf，生成器没有书库读写权限。schemaShared 的 getAllVolumes 依赖在生成器构建时替换为“调用即报错”的禁止存储模块；应用生产构建和运行时后端保持原实现。

当前可计时 small/medium/large/tree/mixed；tree/mixed 的完整交互专项、项目A/B切换和500章正文计时仍待接入，生成数据不等于功能已验收。mixed 按实际自定义字段支持六种类型；日期采用文本，不虚构当前 schema 没有的日期自定义控件。

## 当前计量定义

- 点击进入表格，验证首行名称、可见编辑器与两次 requestAnimationFrame；首次冷表单列。热打开先真正离开表格、等待卸载，再点击。热操作固定一次预热，正式打开5次。
- 在首行可见的“别称”格使用浏览器真实键盘事件，每次验证值并等待两帧；输入30次独立事件。时间包含 Playwright 调度和断言，不能与别的工具只量 React commit 的结果直接比较。
- 保存先产生新值，再点击表格保存按钮；游客用新 IDB 只读事务，便携由 Node 独立读磁盘文件，验证本次完整值后等待两帧。保存10次，另保留一次预热；包含回读轮询与调度成本。
- 前后核对全量目标项目/页签记录，只有预期单元格可改变，updatedAt 可更新；不通过“已保存”文字判断成功。首末标识通过滚动实查；重载后再次独立读回。新项目自动创建的默认地图单独记录，不算大表行。
- 每项保留原始顺序、独立操作记录及失败/超时轮次；功能失败停止本轮后续测量，所有性能数据无效。P50/P95 采用 nearest-rank，报告最差值，不删慢样本。
- 记录 OS、CPU/内存、浏览器版本、窗口、DPR、缩放、GPU、heap、DOM、挂载行数、源码/构建/夹具/执行器指纹。参考环境固定在本次环境哈希，跨环境拒绝比较。

## 基线与结论

每个结果写 `baseline.json`，包含原始样本、功能检查、阈值和完整性哈希；总报告为 `report.json` / `report.md`。新 run 不覆盖旧基线。compare 不写 baseline 参数指向的文件，要求环境、夹具、采样、测量实现与阈值一致；源代码与构建可不同，以便比较优化前后。smoke、低样本、功能失败、输入漂移、原始样本被改动都不能作为有效基线。

measure 的 exit0 仅表示**选定核心指标基线已正确记录**，不表示达到性能目标。超阈值仍原样保存，absolute 标出失败项。compare 要求已接入的绝对阈值通过；尚无正式阈值的样本不宣称比较通过。

未接入：项目冷启动、筛选/清筛选、远端导航、连续滚动分布、变高行/树折叠、A/B作用域交错、longbook回归，及小表/longbook的自动相对回退闸。100行批量保存的压力观察/门槛亦未冻结。上述范围完成后才能标记P0完成；不得用此核心基准替代最终性能与可靠性合流验收。
