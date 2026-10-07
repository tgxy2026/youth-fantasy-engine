// electron-builder `afterPack` 钩子：裁掉 Electron 运行时里本项目用不到的组件。
//
// 【为什么需要】（2026-10-07 · 2.9.0 轮）
//   Electron 升到 44 后主 exe 从 181MB 涨到 246MB，安装包随之 81MB → 112.52MB，
//   **首次越过 Gitee Release 附件的 100 MiB 单文件上限**（实测口径：100 MiB = 104,857,600 字节，
//   即 Gitee 报错文案里的「100 MB」是二进制口径 —— 用一个 102,856,100 字节的包实测上传成功确认）。
//   解包目录里有两处纯浪费：
//     · `locales/` 55 个语言包共 49MB —— 已在 electron-builder.yml 用 `electronLanguages` 裁到中英两个（1.2MB）；
//     · `dxcompiler.dll` 24.5MB —— DirectX Shader Compiler，只被 WebGPU（Dawn）用到；
//       本项目界面是纯 DOM/CSS，不使用 WebGPU。
//   两者合计把安装包降到 ≈98MiB，重新进得去 Gitee 附件。
//
// 【为什么必须挂 afterPack】
//   它跑在「Electron 已解包、NSIS 尚未打」之间 —— 此时删掉的文件**不会进安装包**。
//   放到打包之后再删是没用的：安装包那时已经封好了。
//   ⚠️ 但主 exe 的**元数据不能**在这里写（会被 electron-builder 随后那步整体覆盖，
//      见 scripts/after-pack.cjs 顶部的血泪记录）；**删文件**不受影响 —— 它不会再解包一次。
//
// 【幂等】文件不在就跳过、绝不抛错：复用目录 / 重跑时不能把构建搞挂。
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 不参与运行的 Electron 组件 —— 删掉即少这么多体积，功能不依赖它们。 */
const PRUNE = [
  {
    name: 'dxcompiler.dll',
    why: 'DirectX Shader Compiler（WebGPU/Dawn 用），本项目不用 WebGPU',
  },
]

function prune(appOutDir) {
  let freed = 0
  for (const item of PRUNE) {
    const p = path.join(appOutDir, item.name)
    try {
      const st = fs.statSync(p)
      fs.unlinkSync(p)
      freed += st.size
      console.log(`[prune] 移除 ${item.name}（${(st.size / 1048576).toFixed(1)} MB）—— ${item.why}`)
    } catch (e) {
      // ENOENT = 已经被裁过（复用 / 重跑），属正常
      if (e && e.code === 'ENOENT') continue
      console.warn(`[prune] 跳过 ${item.name}：${(e && e.message) || e}`)
    }
  }
  console.log(`[prune] 本环节释放 ${(freed / 1048576).toFixed(1)} MB（不计入安装包）`)
}

async function afterPack(context) {
  const dir = (context && context.appOutDir) || ''
  if (!dir || !fs.existsSync(dir)) {
    console.warn('[prune] 拿不到 appOutDir，跳过体积裁剪')
    return
  }
  prune(dir)
}

module.exports = afterPack
module.exports.default = afterPack
