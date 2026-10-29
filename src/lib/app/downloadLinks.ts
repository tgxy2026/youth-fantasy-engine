// ============ 安装包下载渠道（单一源）============
//
// 2.6.3「检查更新」用的**镜像下载渠道**。为什么要从 AboutPage 里抽出来：
// 关于页的「获取最新版本」区块与更新弹窗都要用同一份网盘链接 —— 各写一份必然漂移
// （改了弹窗没改关于页，用户点到的就是旧地址）。
//
// 🔴 版本源是 Gitee（有公开 API，见 versionCheck.ts），网盘**不是**版本源：
//    它由作者人工同步，可能落后于 Gitee，所以弹窗里写明「网盘可能稍慢」。

/** 夸克网盘分享地址（文件夹分享：换版本只传新安装包，链接与提取码通常不变） */
export const QUARK_URL = 'https://pan.quark.cn/s/8ae0eb718cf5?pwd=QfAm'
/** 提取码：网页端 URL 已带 pwd 会自动填；手机端 / 客户端常需手填，故单独明示 */
export const QUARK_CODE = 'QfAm'
/** 夸克 APP 口令：复制整段文本后打开夸克 APP 会自动识别跳转（手机端最省事的路径） */
export const QUARK_TOKEN =
  '我用夸克网盘给你分享了「青春幻想引擎」，点击链接或复制整段内容，打开「夸克APP」即可获取。\n/~bb863abBGY~:/'

/** Gitee 仓库主页 / Release 页（Web 端兜底：打不开直链时给人看的页面） */
const GITEE_REPO_URL = 'https://gitee.com/tgxy2026/youth-fantasy-engine'
export const GITEE_RELEASES_URL = `${GITEE_REPO_URL}/releases`

/**
 * 网页版访问地址（桌面版 / 便携版的「在线使用」入口指向它）。
 *
 * 🔴 现在是公网 IP，ICP 备案通过后只改**这一行**：
 *    `https://youth-fantasy-engine.online`
 *    改完需重新构建并发布桌面版 / 便携版才会生效（两端都是离线应用，拿不到远程配置）。
 * ⚠️ 服务端登录页里也有一份同样的地址（`server/lib/config.mjs`），改的时候一起改。
 */
export const WEB_APP_URL = 'https://youth-fantasy-engine.online'
