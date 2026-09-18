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
      },
      // 界面字号阶梯（2026-09-19 六维审计补立）
      // 此前全靠 `text-[12px]` 这类任意值，实测 1495 处用了 **15 种** px（含 9.5/10.5/11.5/12.5/13.5 半像素），
      // 既改不动全局、又在界面缩放下半像素渲染不稳。现在收敛成 9~17 的整数档。
      // ⚠️ 这里**只给字号、不给行高**（值是字符串而不是 [size, lineHeight]）——
      //    原来 `text-[12px]` 只设 font-size、行高继承；若在此指定行高会全站行距突变。
      fontSize: {
        '9': '9px',
        '10': '10px',
        '11': '11px',
        '12': '12px',
        '13': '13px',
        '14': '14px',
        '15': '15px',
        '16': '16px',
        '17': '17px',
      }
    }
  },
  plugins: []
}
