// ============ 配置与路径（唯一真源） ============
// 所有可调参数集中在这里 —— 部署时只改环境变量，不改代码。
import { join } from 'node:path'

/** 用户数据根目录（data.json / blobs 都在这里，备份只需拷这一个目录） */
export const DATA_DIR = process.env.YFE_DATA || '/opt/yfe/data'
/** 前端静态产物根目录 */
export const WWW_DIR = process.env.YFE_WWW || '/opt/yfe/www'

/** 用户表（含配额与注册信息） */
export const USERS_FILE = join(DATA_DIR, 'users.json')
/** 会话签名密钥（首次启动自动生成，绝不入库、绝不进备份包） */
export const SECRET_FILE = join(DATA_DIR, '.secret')
/** 每个用户一个子目录：<DATA_DIR>/users/<uid>/{data.json, blobs/} */
export const USERS_DATA_DIR = join(DATA_DIR, 'users')

/** 默认配额：200 MB（约够一部 300 万字长篇 + 语义向量） */
export const DEFAULT_QUOTA = Number(process.env.YFE_QUOTA || 200 * 1024 * 1024)

/**
 * 单次请求体上限。
 * 🔴 取「配额 + 8 MB」而不是写死：整库 PUT 的体积天然贴着配额走，
 *    若上限低于配额，用户存满时会先撞 413 而不是配额自己的提示，排查会绕远。
 */
export const MAX_BODY = DEFAULT_QUOTA + 8 * 1024 * 1024

/** 会话有效期：30 天（写作用工具是长期使用的，天天让登录会很烦） */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
export const SESSION_COOKIE = 'yfe_sid'

/**
 * 游客模式标记 Cookie。
 * 🔴 为什么要一个 cookie 而不是「未登录就直接放行」：
 *    未登录必须**先看到登录页**（那里才有注册入口和「数据只在本机」的告知）；
 *    用户主动点了「游客试用」才是知情选择。这个 cookie 就是那份「知情同意」的记录。
 */
export const GUEST_COOKIE = 'yfe_guest'
export const GUEST_COOKIE_TTL_MS = 365 * 24 * 3600 * 1000

/**
 * 注册开关。
 * · 'invite'  —— 需要邀请码（默认：防止被扫号批量注册占满磁盘）
 * · 'open'    —— 开放注册
 * · 'closed'  —— 只允许已有账号登录
 */
export const REGISTER_MODE = process.env.YFE_REGISTER || 'invite'

/** 首次启动时自动建的管理员邀请码（打印到 journal，仅一次） */
export const BOOTSTRAP_INVITE = process.env.YFE_BOOTSTRAP_INVITE || ''

/** 配置文件版本：将来改结构时用来判断要不要迁移 */
export const USERS_FILE_VERSION = 1

/**
 * 桌面版 / 便携版下载页（Gitee Releases）—— 登录页底部「也可以下载桌面版」用。
 * ⚠️ 与 `src/lib/app/downloadLinks.ts` 里的 `GITEE_RELEASES_URL` 必须一致。
 *    两处各写一份是因为服务端是纯 JS（不能 import 前端的 TS 模块）；
 *    改动时 grep 一下 `gitee.com/tgxy2026` 就能找齐。
 */
export const GITEE_RELEASES_URL = 'https://gitee.com/tgxy2026/youth-fantasy-engine/releases'
