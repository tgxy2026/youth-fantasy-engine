# 运维 · git bundle 备份与恢复

> 为什么是 bundle：项目红线里写着「**禁 `git stash`，禁手工 `git gc` / `reflog expire`**」
> （两次事故），并要求「**恢复靠 `git bundle`**，已设 `gc.auto=0` 别改回」。
> 这份文档把「怎么打、怎么验、怎么恢复、有什么局限」写下来 —— 真出事时不用现想。

---

## 一、当前状态（最近一次重打：2026-09-20）

| 项 | 值 |
|---|---|
| 文件 | `.workbuddy/tmp/repo-backup-20260920.bundle` |
| 体积 | 12.31 MB |
| 对应提交 | `a81d538`（`refs/heads/main` 与 `HEAD` 同指） |
| 提交总数 | 507 |
| 跟踪文件数 | 498 |

> 上一份是 `repo-backup-20260916{,-latest}.bundle`（各 10.6 MB，指向 `74cd346`），
> 已于 2026-09-20 删除 —— 删之前实测确认 `74cd346` 是当前 HEAD 的祖先、
> 且在新 bundle 里**对象可达**（9-16 之后新增 198 个提交）。

---

## 二、怎么打（两条铁律）

```bash
G="C:/Users/18223/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe"
"$G" bundle create .workbuddy/tmp/repo-backup-$(date +%Y%m%d).bundle --all
```

**铁律 ①：打完必须 `verify`，看那句「records a complete history」。**

```bash
"$G" bundle verify .workbuddy/tmp/repo-backup-YYYYMMDD.bundle
# → a81d538… HEAD
#   The bundle records a complete history.      ← 必须是这句
```

**铁律 ②：删掉任何旧备份之前，必须**实测新备份真能替代它**——从新 bundle 克隆一次，逐项对比。**

```bash
"$G" rev-list --count HEAD                                  # 原仓库提交数
"$G" clone -q <新bundle> <临时目录>                          # 真克隆（别只 verify）
"$G" -C <临时目录> rev-list --count HEAD                     # 必须相等
"$G" -C <临时目录> log --oneline -1                          # HEAD 必须一致
"$G" -C <临时目录> ls-files | wc -l                          # 跟踪文件数必须相等
ls <临时目录>/src/lib/tavern/                                # 工作区文件真 checkout 出来了
```

> 这条不是形式主义：2026-09-20 处理快照时就有一次「第一次比对显示不一致、差点据此判断
> 不可替代」的经历（差异真身是"比错了 commit"）。
> **"我以为它能替代"和"我验过它能替代"是两件事。**

---

## 三、怎么恢复

```bash
# 方式 A：整仓重建（最常用）
"$G" clone repo-backup-YYYYMMDD.bundle novel-studio-restored

# 方式 B：原仓库还在，只想把缺的历史补上（bundle 可当 remote 用）
cd <原仓库>
"$G" pull <bundle 绝对路径> main
```

### ⚠️ 恢复之后**必做**：补 git 身份

**bundle 不含 `.git/config`** —— 克隆出来的仓库里没有 `user.name` / `user.email`，
直接提交会报「Please tell me who you are」。补上：

```bash
"$G" -C <恢复出的仓库> config user.name  "青春幻想引擎开发组"
"$G" -C <恢复出的仓库> config user.email "<你的邮箱>"
```

（这条是 `74cd346` 那次提交专门记下来的教训：「补齐 git 身份恢复（bundle 不含 .git/config）」。

---

## 四、三个必须知道的局限

1. **不含 `.git/config`** —— 前面那节。remote、user 身份、`gc.auto=0` 这些设置**都不在 bundle 里**，
   恢复后要重新配（其中 `gc.auto=0` 是红线，恢复后**第一时间补上**）。
2. **只含「可达对象」** —— bundle 打包的是**被 ref（分支 / tag）指向的对象及其祖先**。
   项目曾因 `git stash` 事故留下**只能靠 reflog 保活**的悬空提交，**它们不在 bundle 里**。
   要连这些一起备份，得直接复制整个 `.git/` 目录（体积大，可低频做一次）。
3. **放在项目目录内 = 与主体同生共死** —— 现在它躺在 `.workbuddy/tmp/` 下，
   项目目录一旦整体丢失 / 误删，备份一起没。**真要防这一层，得把 bundle 复制到项目之外**
   （另一个目录或另一块盘）。当前**尚未**做异地副本。

---

## 五、建议的节奏

- **每次版本迭代收尾 / 大重构动工前**：打一份新 bundle（`verify` + 实测 clone），删掉上一份。
- **偶尔（如每月一次）**：把当前 bundle 复制一份到项目之外。
- **永远不要**为了"省空间"去动 `gc.auto` 或跑 `git gc --prune` —— 红线。
