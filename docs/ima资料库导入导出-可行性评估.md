# ima 资料库导入 / 导出 · 可行性评估（#035）

> 日期：2026-09-21 ｜ 对应清单条目：**#035**（`docs/1.9.6-2.0.0_Bug与待优化清单.md`）
> 性质：**只做评估，未动代码**。老大原话：「直接需求是要开发导入的功能，但我想，既然有导入，那就应该有导出，看开发难度进行评估吧」。
> 依据：2026-09-21 联网核查 ima 开放平台文档 + 本地源码核查（`exporter.ts` / `MaterialLibrary.tsx` / `useTavernCardModel.ts`）。

---

## 一、结论摘要（先看这个）

| 方向 | 难度 | 建议 | 一句话理由 |
|---|---|---|---|
| **导出**（novel-studio → ima） | **小~中** | ✅ **先做** | 已有 Markdown 导出能力；ima 的笔记通道**一步 API 即可送达**，且笔记**无体积上限** |
| **导入**（ima → novel-studio） | **中** | ⚠️ **后做，且先做最小可用** | 读取链路可行，但「取回的到底是不是全文」尚未实测；落点还要先解决「素材资料是只读库」这个前提 |

**推荐顺序**：导出 → 观察是否真的有人用 → 再决定导入做到什么程度。理由是导出的**收益确定、复用现成、风险低**，而导入有一个必须先验证的未知项（见第四节 ⚠️）。

---

## 二、ima 开放平台能力（2026-09-21 核查）

### 2.1 接入事实

| 项 | 内容 |
|---|---|
| Base URL | `https://ima.qq.com` |
| Base Path | `/openapi/wiki/v1` |
| 协议 | HTTP **POST**，JSON body |
| 认证 | Header `ima-openapi-clientid`（Client ID） + `ima-openapi-apikey`（API Key） |
| 凭证获取 | `https://ima.qq.com/agent-interface` |
| 返回结构 | `{"retcode":0,"errmsg":"成功","data":{...}}`，`retcode !== 0` 时直接读 `errmsg` |

### 2.2 可用端点

| 端点 | 方向 | 用途 |
|---|---|---|
| `get_addable_knowledge_base_list` | 读 | 获取可添加的知识库列表（**官方推荐用它做「验证连接」**） |
| `get_knowledge_base` | 读 | 获取知识库信息 |
| `get_knowledge_list` | 读 | 浏览文件夹下的知识条目 |
| `search_knowledge` | 读 | 知识库内搜索 |
| `search_knowledge_base` | 读 | 搜索知识库列表 |
| `create_media` | 写 | 上传第一步，获取 COS 上传凭证（用于传文件） |
| `add_knowledge` | 写 | 把笔记 / 文件加入知识库；也支持加网页 URL |
| `check_repeated_names` | 写前 | 上传前文件名查重 |
| `import_urls` | 写 | 批量添加网页 / 微信文章 |
| `import_doc` | 写 | **导入笔记**，支持 Markdown 内容 |

**`import_doc` 请求体示例**（本次评估最关键的一条）：

```json
{ "content_format": 1, "content": "# 标题\n\n正文，支持 Markdown", "folder_name": "03 AI应用实践" }
```

→ 成功返回 `{"code":0,"data":{"note_id":"..."}}`

### 2.3 体积限制

| 类型 | 上限 |
|---|---|
| Excel / TXT / Markdown | **10 MB** |
| 图片 | 30 MB |
| PDF / Word / PPT / 音频 | 200 MB |
| **网页 / 笔记** | **无限制** ← 走 `import_doc` 不受 10MB 约束 |

> ⚠️ 端点清单来自**社区整理（截至 2026-08）**，非官方长期稳定文档，腾讯可能随时变更 —— 这条影响到方案设计（见第五节风险 1）。

---

## 三、本地基建现状（决定工作量的关键）

| 能力 | 现状 | 对本次的意义 |
|---|---|---|
| **导出** | `src/lib/exporter.ts` 已有 `exportWholeBook`(TXT) / `exportBookMD`(**Markdown**) / `exportEPUB` / `exportDOCX` / `exportSettingCompendium`(设定附录) | ✅ **导出侧基本不用新写业务逻辑**，把已有 Markdown 产物喂给 `import_doc` 即可 |
| **导入** | `useTavernCardModel.ts:476` 的 `importCards(picked: File[])`（角色卡导入）、`BookBreakPanel` 读文件 | ✅ 有成熟的「选文件 → 解析 → 落库」模板可参照 |
| **素材资料** | `material-library` 页签（`MaterialLibrary.tsx` + `data/materialData.ts` + `lib/materialRef.ts`），schema 中是 `type: 'material'` | ⚠️ **它是「内置只读」库**，导入要落到这里必须先改造；否则需另选落点 |
| **跨域请求** | 现有 AI 调用走 `fetch`（`lib/ai.ts`），桌面版为 Electron | ⚠️ 渲染进程直连 `ima.qq.com` 会被 CORS 拦，需走主进程（见风险 5） |

---

## 四、方案与工作量

### 4.1 导出（建议先做）— 小~中

**推荐路径：笔记通道（一步到位）**

```
选中章节/卷/全书/设定 → 复用 exportBookMD() 产 Markdown
  → POST /import_doc { content_format:1, content, folder_name }
  → 返回 note_id → toast 提示成功
```

- 优点：**一步 API**、无 COS 上传、**笔记无体积上限**（长篇不用切）
- 工作量：
  - `src/lib/imaClient.ts` 新建（封装鉴权 + 错误码映射 + 超时）：约 120~180 行
  - 设置项：Client ID / API Key 两个输入框 + 「测试连接」（打 `get_addable_knowledge_base_list`，与 A1 首启向导的「测试连接」是同一套模式）
  - 导出入口：在已有导出菜单旁加「发送到 ima 资料库」+ 目标文件夹名输入
- **量级：中（约 1~2 天含自测）**

**备选路径：文件通道**（若老大希望 ima 里显示为「文件」而非「笔记」）

`create_media`(拿 COS 凭证) → PUT 上传 → `add_knowledge` 三步，需处理签名上传与 ≤10MB 分批。
→ 多约半天，且长篇小说要按卷/章拆分 + 进度与重试，**除非有明确理由，建议先用笔记通道**。

### 4.2 导入（后做）— 中 ~ 大

**最小可用版（建议）**

```
get_addable_knowledge_base_list（选库）
  → get_knowledge_list（浏览 / 勾选条目）
  → 取回内容 → 落成「素材条目」或「参考文档」→ 完成
```

- 量级：**中**。链路清晰，UI 参照 `MaterialLibrary` 的列表形态即可。
- ⚠️ 前提：**素材资料当前是只读内置库**，要么给它加一个可写 store（改动 schema + 只读闸，成本不小），要么把导入内容落到别处（如新增「我的素材」页签、或走已有表格）。

**完整版（结构化抽取）**

用 AI 把 ima 文档抽成人物卡 / 设定卡 / 关系表字段 —— 可复用一键拆书的抽取链路。
→ 量级 **大**，且**不适合作为第一步**（抽取质量要调，投入产出比未知）。

### 4.3 双向同步（不建议现在做）

ima 无「变更通知 / 增量 diff」类接口，双向同步只能靠轮询 + 本地去重，复杂度远超收益。**明确不做**。

---

## 五、风险与红线

| # | 风险 | 处置 |
|---|---|---|
| 1 | ⚠️ **API 非官方稳定文档**（社区整理，2026-08），随时可能变更或收回 | 设计上做**能力探测 + 优雅降级**：进功能先打一次 `get_addable_knowledge_base_list` 探活，失败时给明确文案而非崩掉；**不要把核心链路绑死** |
| 2 | ⚠️ **凭证门槛未知**：是否所有账号都能在 `agent-interface` 拿到 clientid/apikey、有无白名单或企业限制 | **需老大实测**（见第六节待确认 1）。拿不到凭证，本方案整体要重估 |
| 3 | 🔴 **数据外发口径** | 开启该功能 = **把内容上传至腾讯 ima（第三方）**。文案必须明确写清，**不得**与「本地不出本机」的宣传口径混淆（长期记忆红线：口径只能是「发给当前选定的服务」） |
| 4 | 🔴 **API Key 存储** | 建议与 AI key 同策略——存 `settingsKV` 但**排除云同步**（#006 已有 `EXCLUDED_META_KEYS` 先例），避免密钥随快照上云 |
| 5 | ⚠️ **Electron 跨域（CORS）** | 渲染进程直连会被拦 → **走主进程发请求**（`electron/main.cjs` 加一层转发，或 `ipcRenderer` 调主进程 Node）。🔴 **不要用关 `webSecurity` 来绕过** |
| 6 | ⚠️ **长篇体积** | 走笔记通道无上限；若走文件通道则 TXT/MD ≤10MB，须按卷/章分批 + 进度提示 + 失败重试 |
| 7 | ⚠️ **不在 2.4 计划内** | #035 不属于已定稿的 2.4 三批（2.4.0/2.4.1/2.4.2）。若要做，需明确插批位置或排到 2.4 之后 |

---

## 六、待老大确认（开工前必须回答）

1. 🔴 **你有 ima 的 OpenAPI 凭证吗**（`https://ima.qq.com/agent-interface` 能否拿到 Client ID + API Key）？
   这是整个方案的地基——拿不到就没有「对接」只有「手动导入导出文件」。
2. **导入的落点期望**：进「素材资料」（需先把它改造成可写）？还是另开一个可写的「我的素材」？还是落进已有表格页签？
3. **先做导出还是导入**？（评估建议：先导出）
4. **备注**：若只是「把 ima 里的资料拿来用」，其实还有一条**零开发**路径 —— ima 支持导出/复制内容，配合已有的「导入备份 / 文件导入」手动搬运。要不要先按零开发方式试用一段，看频率再决定投不投开发？
