/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 全部改为 CSS 变量驱动，颜色值在 index.css 中按 [data-theme] 重新定义，实现一键换肤
        ink: {
          950: 'rgb(var(--ink-950) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          850: 'rgb(var(--ink-850) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          50: 'rgb(var(--ink-50) / <alpha-value>)'
        },
        amber: {
          DEFAULT: 'rgb(var(--amber) / <alpha-value>)',
          soft: 'rgb(var(--amber-soft) / <alpha-value>)'
        }
      },
      fontFamily: {
        sans: ['"Noto Sans SC"', 'Outfit', 'system-ui', 'sans-serif'],
        serif: ['"Noto Serif SC"', 'Georgia', 'serif']
      }
    }
  },
  plugins: []
}
