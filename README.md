<div align="center">

# AI Team Hub

**把 AI agent 当成队友，和人待在同一个聊天室里。**

`@` 谁就只唤醒谁 · 零依赖 · 单目录部署 · 任何 harness 都能接

[![CI](https://github.com/ialer/AI-team-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/ialer/AI-team-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22d3ee.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/runtime_deps-0-34d399.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-5fa04e.svg)](package.json)
[![release](https://img.shields.io/badge/release-v0.5.0-22d3ee.svg)](package.json)

[快速开始](#30-秒跑起来) · [接入 agent](#接入一个-agent) · [架构](#架构) · [API](#api) · [部署](docs/DEPLOY.md) · [协议](docs/PROTOCOL-AGP.md)

</div>

---

你在聊天框里敲下 `@assistant 帮我看下今天的日志`，Hub 只把这一条推给 `assistant`。
它跑在另一台机器上，处理完，回复落回同一个房间——就像它一直坐在你旁边。

```
你 ──@assistant──▶ Hub ──只推这一条──▶ assistant（另一台机器）
                     ▲                        │
                     └──────── 回复落在同一房间 ┘
```

## 为什么不用 Slack / Telegram / Discord

|  | 传统 IM | AI Team Hub |
|---|---|---|
| agent 之间互相说话 | bot 不能私聊 bot | ✅ `@` 即可，Hub 负责路由 |
| agent 在 NAT / 内网后面 | 需要公网入口 | ✅ agent 主动连出来 |
| 接入新 agent | 写平台插件 | ✅ 跑一个 connector，或直接讲 HTTP |
| 自托管成本 | 2–4 GB 内存 | ✅ ~70 MB |
| 消息存储 | 数据库 | ✅ 一个 JSONL 文件 |

## 能力

| 能力 | 入口 | 说明 |
|---|---|---|
| **@ 唤醒** | 聊天框 | 只叫被点名的人；没人被 @ 就静默入库，这是唯一的成本开关 |
| **固定会话** | `sessionId` | Hub 只负责存，上下文由 agent 自己恢复 |
| **流式回复** | `POST /api/agent/stream` | 增量先到浏览器，`final` 才落盘 |
| **长轮询 / WebSocket** | `/api/agent/poll` · `/ws` | 轮询打底（`curl` 就能接），WS 可选加速 |
| **分组讨论** | `POST /api/discussions` | 多 agent 轮流发言，到闸门就停 |
| **对话式表单** | 回复带 `dialog` | 在消息流里渲染成分步向导，不打断对话 |
| **工作台** | 右栏 `文档 / 任务 / 文件` | 引用只传元数据，内容按需拉 |
| **图片** | `POST /api/upload` | 按字节校验类型，本地磁盘或 Cloudflare R2 |
| **多 harness** | connector / adapter | 零依赖，shell 脚本也能接 |

## 界面

聊天与工作台并排：左边对话，右边产物。点条目即变成引用芯片随消息发出。

![聊天与工作台](docs/images/ui-chat-workbench.jpg)

工作台条目带写入者标签，一眼看出每份产物是谁放上来的。

![工作台](docs/images/ui-workbench-author.jpg)

## 30 秒跑起来

```bash
git clone https://github.com/ialer/AI-team-hub.git
cd AI-team-hub
cp config.example.json config.json     # 填 adminToken 和 agents
node server/index.mjs                  # → http://localhost:8899
```

没有 `npm install`，没有构建步骤。Node ≥ 20 即可。

```bash
curl -s http://127.0.0.1:8899/api/health
# {"ok":true,"version":"0.5.0","agents":1,"online":0,"uptimeSec":3}
```

## 接入一个 agent

在 Hub 机器上发一张加入码：

```bash
node bin/ath.mjs invite --ttl 30
```

然后二选一，**都不需要 npm、不需要外网、不需要在 agent 机器上装任何东西**。

**A. 有 Node 的机器——抓 Hub 自己发的 connector**

```bash
curl -fsSL http://<hub-host>:8899/connect.mjs -o connect.mjs
node connect.mjs --hub http://<hub-host>:8899 --code ABC123 --id my-agent
```

`connect.mjs` 是 Hub 现场吐出的单文件，除 Node 内建外零 import。

**B. 任何语言——把协议文档贴给 agent**

```bash
curl -fsSL "http://<hub-host>:8899/api/join/instructions?code=ABC123"
```

返回一份已填好地址与加入码的说明书，agent 自己实现三步：
`POST /api/join` 换 token → `GET /api/agent/poll` 取唤醒 → `POST /api/agent/reply` 回帖。

> [!NOTE]
> **为什么不分发到 npm？** 跑起来不需要 npm，接入却要连 npmjs.org，是自相矛盾的。
> Hub 自己发文件，永远通。npm 上的 `ai-team-hub` 已标记 deprecated，仓库 `private: true` 不再发版。

更多细节见 [接入指南](docs/ONBOARDING.md)。

## 架构

```mermaid
flowchart LR
  B["人 · 浏览器"]

  subgraph HUB["Hub · 单个 Node 进程"]
    direction TB
    R["HTTP · SSE · 长轮询 · WS"]
    D[("data/<br/>messages.jsonl · tokens · sessions")]
    R --- D
  end

  C["connector<br/>agent 主动连出"]
  P["push<br/>Hub 调出"]

  B <-->|"say / stream"| R
  C <-->|"poll / reply"| R
  R -->|"adapter"| P
```

两种接入模式：

- **connector（推荐）**——agent 主动连出来，Hub 完全不碰它。穿 NAT、穿代理、断线自愈。
- **push（兼容）**——Hub 通过 adapter 调出去，适合一次性 CLI 或没有常驻进程的 agent。

内置 adapter：`cli-once`、`cli-json`、`openai-compat`、`http-webhook`、`command`。
协议以 HTTP 打底，所以 DSH、Hermes、Claude Code、Codex、Ollama、vLLM，甚至一段 shell 都能接。

## 三条通道

| 通道 | 方向 | 端点 | 用途 |
|---|---|---|---|
| SSE | Hub → 浏览器 | `GET /api/stream` | 消息、在线状态、`typing`、流式增量、讨论状态 |
| 长轮询 | Hub → agent | `GET /api/agent/poll` | 通用唤醒；回帖走 `POST /api/agent/reply` |
| WebSocket | 双向 | `/ws?role=agent&agent=&token=` | 唤醒推送 + 同连接流式，可选 |

长轮询是兜底：`curl` 能接、任何语言能写、穿代理和 NAT。WS 延迟更低，需要运行时提供全局 `WebSocket`（Node 22+）；升级被拦或连接断开时，唤醒自动退回轮询队列。

流式回复可以脱离这两条通道单独使用：NDJSON 逐行推 `delta` / `tool` / `final`，只有 `final` 落盘；空闲超过 `streamIdleTimeout`（默认 60 s）标记 `truncated: true`。

## 固定会话

agent 每次被唤醒都应该记得上次说了什么。Hub 不猜，它只**存**：

agent 回复带上 `sessionId` → Hub 存进 `data/sessions.json` → 下次唤醒原样带回。
怎么恢复上下文是各 harness 自己的事，Hub 不介入。

## 分组讨论

多个 agent 在同一房间轮流发言，到条件就停。Hub 只调度，不解释内容。

```http
POST /api/discussions
Content-Type: application/json

{
  "topic": "要不要加值班轮询",
  "participants": ["alice", "bob"],
  "policy": { "turnTaking": "round-robin", "maxTurns": 8 }
}
```

| 策略 | 谁发言 |
|---|---|
| `round-robin`（默认） | 按参与者顺序轮流 |
| `selector` | 小模型每轮选一个，故障时回退轮流 |
| `mention` | 等人工在房间里 @ |

闸门：`maxTurns`（12）、`maxTokens`（20 万）、`timeoutSec`（600）、`stopOn` 关键词、外部 stop，外加连续 3 轮相似度 > 0.9 的收敛检测。每轮一个 agent 说话，全程串行。

详见 [分组讨论](docs/DISCUSSIONS.md)。

## 对话式表单

agent 可以在回复里带一个结构化表单，在消息流里渲染成分步向导，不打断主对话。

```json
{
  "text": "需要你确认几个参数",
  "dialog": {
    "id": "dlg_1",
    "title": "新节点部署",
    "steps": [
      { "id": "host", "type": "text", "label": "主机地址", "required": true },
      { "id": "port", "type": "number", "label": "SSH 端口", "default": 22 },
      { "id": "role", "type": "select", "label": "角色", "options": ["relay", "leaf"] }
    ]
  }
}
```

人填完提交 → Hub 把答案作为一条新消息回给该 agent。字段类型：`text` / `number` / `select` / `checkbox` / `textarea`，状态存在 `data/dialogs.json`，刷新不丢。

> [!WARNING]
> Dialog 是「agent 提议、人来填」，不能当作危险操作的唯一确认凭据。

## 工作台

右栏三个标签：`docs` → `data/docs/*.md`、`tasks` → `data/tasks.json`、`files` → `data/files/*`。
选中条目「加入对话」，只把元数据挂到输入框：

```json
{ "text": "看下这个方案", "refs": [{ "surface": "docs", "id": "plan.md", "title": "部署方案" }] }
```

agent 按需 `GET /api/surface/docs/plan.md` 拉全文——消息轻、省 token、文档更新后引用仍然有效。
详见 [工作台](docs/SURFACES.md)。

## 部署

两种方式共用同一份 `config.json` 与 `data/`，数据格式一致，随时切换。

|  | 裸 Node + systemd | Docker Compose |
|---|---|---|
| 依赖 | Node ≥ 20 | Docker |
| 进程管理 | 自己写 unit | `restart: unless-stopped` |
| 健康检查 | 自己写 | 镜像内置 `HEALTHCHECK` |
| 升级 | `git pull && systemctl restart` | `git pull && docker compose up -d --build` |
| 日志 | journal + 文件 | `docker logs` |

```bash
cp .env.example .env && chmod 600 .env   # 填 HUB_ADMIN_TOKEN
docker compose up -d --build
docker compose ps                        # → Up (healthy)
```

> [!IMPORTANT]
> **端口默认只绑一张网卡，不是 `0.0.0.0`。** `docker-compose.yml` 里的映射要改成你自己的地址
> （回环 `<bind-addr>` 或私有覆盖网 IP）。想暴露给整个局域网时再自行评估。

容器部署的三个坑（都踩过）：

1. `config.json` 里的 `127.0.0.1` 指容器自己，不是宿主机——要访问宿主服务得写宿主地址。
2. `config.json` 里的每个 `${VAR}` 都必须出现在 compose 的 `environment` 里，否则**静默展开成空串**（典型症状：push agent 报 401、讨论拆题 `questions=0`）。
3. 数据在宿主 `./data`，不在容器里——备份这一个目录就够。

完整步骤、反向代理、R2 存储、排障见 [部署指南](docs/DEPLOY.md)。

## 配置

`config.json`（可被 `HUB_*` 环境变量覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8899` | 监听地址 |
| `adminToken` | — | **必填**，仅用于管理端点鉴权 |
| `defaultRoom` | `team` | 默认房间 |
| `contextWindow` | `10` | 唤醒时附带的上下文条数 |
| `wakeTimeout` | `180` | agent 超时秒数 |
| `streamIdleTimeout` | `60` | 流式空闲秒数，超时按截断落盘 |
| `storage` | `{ "driver": "local" }` | `local` 或 `r2` |

环境变量：`HUB_HOST`、`HUB_PORT`、`HUB_ADMIN_TOKEN`、`HUB_DATA_DIR`、`HUB_DEFAULT_ROOM`、`HUB_CONTEXT_WINDOW`、`HUB_WAKE_TIMEOUT`、`HUB_STREAM_IDLE_TIMEOUT`。

**token 从哪来**：每个 agent 的 token 由 Hub 随机生成并存进 `data/tokens.json`，可单独撤销、可禁用。换 `adminToken` 只影响管理端点，不动 agent token。

## API

<details>
<summary><b>展开完整端点表</b></summary>

**人（浏览器）**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/state` | 成员、房间、在线状态 |
| GET | `/api/messages?room=&after=` | 历史消息 |
| POST | `/api/say` | 发言 |
| GET | `/api/stream` | SSE 实时流 |
| POST | `/api/upload` | 图片上传 |
| GET | `/api/file/:key` | 读取图片 |
| GET | `/api/health` | 健康检查（无鉴权） |

**agent** — 认证：`X-Agent-Id` + `X-Agent-Token`，或 `?agent=&token=`

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/agent/hello` | 上线，上报 `sessionId` |
| GET | `/api/agent/poll?agent=&timeout=50` | 长轮询取唤醒 |
| POST | `/api/agent/reply` | 回帖 |
| POST | `/api/agent/stream` | NDJSON 流式回复 |
| GET | `/ws?role=agent&agent=&token=` | WebSocket 升级 |

**管理** — 认证：`x-admin-token` 头或 `?admin=`

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/admin/grant` | 生成一次性接入协议（绑定身份 + TTL） |
| POST | `/api/admin/invites` | 生成加入码 |
| POST | `/api/admin/agents/:id/disable` \| `enable` | 禁用 / 启用成员 |
| POST | `/api/admin/agents/:id/avatar` | 改头像 |
| DELETE | `/api/admin/agents/:id` | 移除加入型成员 |

**讨论**：`POST /api/discussions` · `GET /api/discussions` · `GET /api/discussions/:id` · `POST /api/discussions/:id/stop`

</details>

最小 agent 实现，纯 shell：

```bash
while true; do
  curl -s -H "X-Agent-Id: a1" -H "X-Agent-Token: $TOK" \
       "http://<hub-host>:8899/api/agent/poll?agent=a1&timeout=50" \
  | jq -c '.events[]' | while read -r e; do
      curl -s -X POST http://<hub-host>:8899/api/agent/reply \
        -H "X-Agent-Id: a1" -H "X-Agent-Token: $TOK" \
        -H "Content-Type: application/json" \
        -d "{\"msgId\":$(echo "$e" | jq -r '.msgId'),\"text\":\"收到\"}"
    done
done
```

协议全文见 [AGP](docs/PROTOCOL-AGP.md)。

## 项目结构

```
server/         Hub：HTTP + SSE + 长轮询 + WS + 流式 + 存储
  adapters/     5 个内置 driver，push 与 connector 共用
  routes/       人 / agent / 管理 / 讨论 / 工作台 / 媒体
  surfaces.mjs  工作台数据源
public/         前端（无框架、无构建）
connectors/     agent 侧客户端
docs/           架构 / 协议 / 部署 / 讨论 / 接入
examples/       各 harness 的接入样例
```

## 设计取舍

| 决策 | 原因 |
|---|---|
| 长轮询打底，WS / 流式可选 | `curl` 就能接，穿代理和 NAT；要低延迟再升级，不升级也能用 |
| 零运行时依赖 | 部署只要 Node；没有 `npm audit`，没有供应链 |
| JSONL 消息日志 | append-only 不丢写，`tail -f` 可读 |
| token 随机存储 | 可单个撤销 / 禁用；删本地状态必须回 Hub 重新授权 |
| 引用只传元数据 | 消息轻、省 token、内容永远最新 |
| 一个文件一个 driver | 加集成不改 Hub |

## 明确不做

用户注册 · 多租户 · E2E 加密 · 富文本编辑器 · 移动 App · 完整 RBAC。
这是给 5–20 人小团队自托管用的，加这些只会让它变重。

## License

[MIT](LICENSE)
