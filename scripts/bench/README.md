# 历史容量工具

这两支脚本从本机 `.workbuddy/tools` 保留副本后迁入版本库，供诊断和后续 P0 参考。它们使用开发服务、单次容量样本，不符合 3.2.3 大表方案要求的生产构建、七类夹具、冻结门槛与分位数测量；本轮没有执行容量验收，也没有把它们接入性能门禁。

先启动隔离开发服务，再显式提供 APP_URL（默认 http://localhost:5199/）：

~~~powershell
node scripts/bench/bench-capacity-1000x60.cjs
node scripts/bench/bench-release-500ch.cjs
~~~

需要项目依赖和本机 Edge；可用 REVIEW_BROWSER_PATH 指定浏览器，PLAYWRIGHT_CORE_PATH 指定 Playwright 模块。1000×60 可通过 ROWS/FIELDS 调整，长篇可通过 CHAPTERS/WORDS/PAYLOADS 调整。只使用新建浏览器上下文，不连接作者已有 profile。

脚本按自身位置定位仓库，每次在 `.workbuddy/tmp/historical-bench-*` 新建输出目录，保留 JSON 与截图，不覆盖历史取证。它们仍依赖旧的界面进入路径；重测失败须更新路径并保留失败，不能将历史数字写成当前基线。合规的新性能入口仍需按大表方案 P0 独立实现。
