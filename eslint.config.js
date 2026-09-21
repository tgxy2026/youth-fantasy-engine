// ESLint 扁平配置（ESLint 9 / typescript-eslint 8）
//
// 设计原则：**最小集 + warn 起步**。
// 本项目已有 tsc 严格模式（strict + noUnusedLocals + noUnusedParameters）兜底类型与死代码，
// ESLint 在此不重复那部分工作，只补 tsc 管不到、而本项目又确实踩过坑的三类问题：
//
//   1. react-hooks/rules-of-hooks  → 规则级错误（hooks 写在条件分支里会直接崩，必须 error）
//   2. react-hooks/exhaustive-deps → 依赖数组漏项。源码里已有 5 处 `// eslint-disable-line`
//      在压制它（NovelEditor / OutlineSheet / TableSheet / InspireTools），此前无 ESLint 在跑，
//      那些注释一直是装饰品；2026-09-14 审计发现的「叠层重建把 scrollTop 归零」一类问题
//      正属此列。
//   3. no-empty                    → 空 catch。审计 P1-14 列出的静默吞错点即由此暴露。
//      （注意：块内有注释的不算空，所以 `catch { /* 忽略 */ }` 不会被误报，
//        只有真正光秃秃的 `catch {}` 才会提示——这正是要治理的那批。）
//
// 其余 typescript-eslint / @eslint/js 的推荐规则集**暂不启用**：
// 41.9k 行存量代码一次性接入会刷出成百上千条告警，反而淹没真问题。
// 等这三条稳定后，再按需逐条开启其它规则（届时也应先 warn 再收紧）。
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-web/**',
      'dist-web-*/**',
      'dist_bak_*/**',
      'release/**',
      'build/**',
      'tests/.*.mjs',       // esbuild 测试缓存产物，非源码
      'tests/.*.test.mjs',
      'scripts/**',         // 构建脚本（.mjs，自有一套写法），暂不纳入
      'electron/**',        // 主进程 CJS，单独对待
    ],
  },

  // ---------- 前端源码 ----------
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      // 存量里 any 有 100 处（syncCore 的加解密/合并边界占大头），属已知且被接受的写法。
      // 若开成 warn，每次 lint 会刷 100 条噪音、把真正要紧的 hooks 告警淹没——
      // 与「最小集、不淹没有效信号」的初衷相悖，故此处显式关闭。
      // 将来若要治理 any，建议单独开一轮、按文件逐步收紧，而不是全局开告警。
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ---------- 测试（Node 环境，ESM + 顶层 await） ----------
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // 测试里大量故意构造的畸形数据/桩对象，宽松对待
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': 'off',
    },
  },
]
