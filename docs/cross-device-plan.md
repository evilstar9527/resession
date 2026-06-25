# resession 跨设备共享 —— 技术方案（阶段一：跨设备查看历史）

> 状态：**待评审**。本文只描述方案，不含已实现代码。
> 决策已定：核心做**能力①（跨设备查看所有机器的 session 列表 + 只读对话）**；规模为**我和小团队**；
> 数据**自托管即可**（HTTPS + token，不做客户端 E2E 加密）；同步**先做手动 push/pull**；
> 部署用 **Docker 镜像**（服务器已有 Coolify 4.1.2，单机）。

---

## 1. 背景与动机

`resession` 现在是纯本地 CLI：读本机 `~/.claude/projects/` 与 `~/.codex/sessions/` 的 JSONL，
按最近使用排序、可恢复。痛点：**会话只在创建它的那台机器上看得到**。常见场景是「公司机器上调过的
bug，回家想回看当时的过程」。本阶段目标：让任意一台装了 resession 并登录同一服务的设备，都能
**查看全部设备的会话列表并只读浏览对话内容**。

明确**不在本阶段**做的事（避免范围蔓延）：
- 跨设备真正 `resume`（会话绑定 cwd/代码/git 状态，脱离原机不可靠）——列为远期，且需目标机有对应代码区。
- 多租户账号体系、计费、公开产品化。
- 客户端端到端加密。

---

## 2. 总体架构

```
┌──────────────┐    HTTPS + Bearer token     ┌───────────────────────────┐
│  设备 A        │  ──  push 变更的 session  ──▶ │  resession-server (Docker) │
│  resession CLI │  ◀─  pull 元数据/内容    ──  │  Node 内置 http + better-  │
│  + 本地 JSONL  │                              │  sqlite3 / 或纯 JSON 索引   │
└──────────────┘                              │  卷: /data （SQLite+JSONL）  │
┌──────────────┐                              └───────────────────────────┘
│  设备 B …      │ ◀──────────────────────────────────────────────────────┘
└──────────────┘
```

**设计原则**
- **本地优先**：本机始终是真相源；服务器是聚合层。断网时 resession 用本地数据照常工作。
- **服务器不理解 JSONL 内部**：只存原文 + 哈希 + 客户端解析好的元数据。解析逻辑全在客户端复用
  `src/discover.js`，服务端保持哑而稳。
- **向后兼容**：不 `login` 就是现在的纯本地工具；`login` 后才出现跨设备能力。
- **延续零依赖倾向**：服务端优先只用 Node 内置 `http`；存储若用 SQLite 则引入 `better-sqlite3`
  一个依赖（评审项，见 §7）。

---

## 3. 数据模型

服务端每条 session 记录（SQLite 表 `sessions`，或等价 JSON）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `deviceId` | 客户端配置 | 来源设备标识（如 `macbook-pro`），登录时设定 |
| `source` | discover.js | `claude` / `codex` |
| `sessionId` | discover.js | 会话 id |
| `cwd` `title` `gitBranch` `createdAt` `updatedAt` `version` `model` | discover.js | 复用现有 meta |
| `contentHash` | 客户端 | JSONL 内容的 sha256，增量同步判重用 |
| `bytes` | 客户端 | JSONL 大小 |
| `uploadedAt` | 服务端 | 入库时间 |
| 主键 | | `(deviceId, source, sessionId)` |

JSONL 原文落盘：`/data/<deviceId>/<source>/<sessionId>.jsonl`。

---

## 4. 服务端 API（resession-server）

极简 REST，全部需 `Authorization: Bearer <token>`。

| 方法 + 路径 | 作用 | 请求/响应 |
|---|---|---|
| `GET /healthz` | 健康检查（无需鉴权） | `200 ok` |
| `GET /sessions` | 列出所有设备的元数据 | 返回 meta 数组，按 `updatedAt` 降序；支持 `?device=&source=&since=` |
| `GET /sessions/:deviceId/:source/:sessionId` | 取单条 JSONL 原文 | `text/plain` |
| `PUT /sessions/:deviceId/:source/:sessionId` | 上传/更新一条（body=JSONL，头带 meta+hash） | 若 `contentHash` 未变则 `204` 跳过 |
| `POST /sync/diff` | 客户端发本地 `{key:hash}` 清单，服务端回「服务器缺哪些 / 客户端缺哪些」 | 用于高效增量 |

鉴权：小团队用**一个共享 token**起步；预留每设备 token（`tokens.json` 映射 `token→deviceId`）。
全程走 HTTPS（Coolify + Cloudflare 已有 TLS 能力）。

---

## 5. 客户端改动（resession CLI 增量）

新增 `src/remote.js`（HTTP 客户端）与配置 `~/.resession/config.json`
（`{ url, token, deviceId }`）。新增命令：

- `resession login <url> <token> [--device <name>]` —— 写配置；`deviceId` 默认取 hostname。
- `resession push` —— 扫描本地（复用 `discoverSessions({all})`），算每条 `contentHash`，
  调 `POST /sync/diff` 找出服务器缺失项，逐个 `PUT` 上传。打印 `上传 N / 跳过 M`。
- `resession pull` —— `GET /sessions` 取全量元数据，缓存到 `~/.resession/remote-cache.json`。
  （阶段一默认**不**下载 JSONL 原文，按需在查看时再 `GET` 单条，省流量。）
- `resession ls` / TUI —— 合并「本地实时发现」+「远程缓存」两个来源：
  - 每行新增**来源设备**列（本机标记为 `· this`，其它显示 `deviceId`）。
  - TUI 增加按设备过滤（复用现有 tab 机制，或加一个设备维度）。
  - **远程且本地无对应文件**的会话：标记为「只读」，回车时**下载 JSONL 并用分页器展示对话**
    （只读浏览），而不是尝试 resume。
  - 本地存在的会话：行为不变（可 resume）。

去重规则：`(deviceId, source, sessionId)` 唯一；同一条以 `updatedAt`/`contentHash` 较新者为准。
本机自身的会话从「本地发现」出，不依赖远程缓存，保证离线可用。

---

## 6. 部署（Docker + Coolify）

- 新增 `server/` 目录：`server/index.js`（服务端）、`server/Dockerfile`、`server/README.md`。
- 镜像：`node:22-alpine`，`WORKDIR /app`，仅拷服务端代码（+ 可能的 `better-sqlite3`），
  `EXPOSE 8080`，`CMD ["node","index.js"]`。数据卷挂 `/data`。
- 环境变量：`RESESSION_TOKEN`（共享 token）、`PORT`（默认 8080）、`DATA_DIR`（默认 `/data`）。
- Coolify：作为新应用，源用本仓库 `server/` 或预构建镜像；挂持久卷到 `/data`；
  绑定子域名 + TLS（参考你现有 Cloudflare 暴露方式）。
- 健康检查指向 `/healthz`。

---

## 7. 已定取舍（评审结论）

1. **存储引擎：SQLite**（`better-sqlite3`，单一依赖）。换一个依赖买长期省心；元数据查询/并发更稳。
2. **pull 策略：按需下载**。`pull` 只拉元数据缓存；查看某条对话时再 `GET` 单条 JSONL。
   （可后续加 `pull --full` 作为可选全量，本阶段不做。）
3. **同步命令：只做 `push` / `pull`** 两个显式命令，不加 `sync` 快捷命令（保持清晰可控）。
4. **deviceId**：默认取 hostname，多台同名机器用 `login --device <name>` 指定。

---

## 8. 验证方式（端到端）

1. 本地起服务端容器（`docker run -e RESESSION_TOKEN=test -p 8080:8080 -v $PWD/data:/data ...`），
   `curl /healthz` 通。
2. 设备 A：`resession login http://localhost:8080 test` → `resession push` → 服务器 `/data` 下出现 JSONL，
   `GET /sessions` 返回 A 的会话。
3. 模拟设备 B：用另一个 `RESESSION_HOME`/`deviceId` 跑 `resession pull` → `resession ls` 能看到 A 的会话，
   标「只读」，回车能下载并浏览对话内容。
4. 增量：A 不改动再 `push`，应全部「跳过」；新增一条会话再 `push`，只传新增那条。
5. 断网：停掉服务端，`resession`/`ls` 仍能列出并 resume**本机**会话（本地优先验证）。
6. 部署：推到 Coolify，绑定子域名，从真实第二台机器 `login` 公网地址跑通 2–4。

---

## 9. 实施顺序（阶段一）

1. `server/index.js` 最小可用（healthz + sessions CRUD + diff）+ 内存/JSON 存储跑通。
2. 客户端 `src/remote.js` + `login/push/pull` 命令，对接本地服务端验证。
3. TUI/ls 合并远程来源 + 只读查看。
4. 切 SQLite（若评审采纳）。
5. Dockerfile + Coolify 部署 + 公网联调。
6. 文档：README 增加「跨设备」章节；发版 `0.2.0`。
