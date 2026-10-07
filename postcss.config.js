export default {
  plugins: {
    // 🔴 Tailwind 4 的 PostCSS 插件改了名：`tailwindcss` → `@tailwindcss/postcss`
    //    （写成旧名构建会直接报错）。autoprefixer 保留：它只管非 Tailwind 的普通 CSS，
    //    与 v4 内置的 Lightning CSS 前缀不冲突，且保留它能让产物 CSS 与 v3 基线更好对齐。
    '@tailwindcss/postcss': {},
    autoprefixer: {}
  }
}
