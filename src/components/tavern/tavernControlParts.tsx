// ============ 酒馆控制面板 · 共用常量（C1 · 2.4.2 自 TavernControl.tsx 拆出）============
// 🔴 纯搬家：一行未改（只给顶层声明补了 export —— 原文里它们是本文件私有，现被 hook 与子组件共用）。

export const COL_GAP = 16
/** 协议窗的最低高度：低于它就没法读了（窄窗口下宁可让左列略高一点） */
export const PROTO_MIN_HEIGHT = 240

/** 展示用的示例正则（收成常量 —— 反斜杠在 JSX 属性里转义最容易出错，只写一处） */
export const RULE_EXAMPLE = '\*([^*\n]+)\*'
