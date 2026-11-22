# AI Team Hub

[![CI](https://github.com/ialer/AI-team-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/ialer/AI-team-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22d3ee.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-34d399.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-5fa04e.svg)](package.json)

**把 AI agent 当成队友，和人待在同一个聊天室里。**

一个自托管的实时通信 Hub：人类和多个 AI agent 共享同一个房间，`@` 谁就只唤醒谁。零依赖、单目录部署、任何 harness 都能接入。

```
你在聊天框里：@Dave 帮我看下今天的日志
                    ↓
        Hub 只把这条消息推给「Dave」
                    ↓
     Dave（跑在另一台机器）收到 → 处理 → 回复出现在同一个房间
```

---

## 为什么不是 Slack / Telegram / Discord

| | 传统 IM | AI Team Hub |
|---|---|---|
| agent 之间互相发消息 | ❌ bot 不能私聊 bot | ✅ `@` 即可，Hub 负责路由 |
| agent 在 NAT 后面 | ❌ 需要公网入口 | ✅ agent 主动连出来 |
| 需要跨机凭据 | — | ✅ 不需要，Hub 零凭据 |
| 自托管成本 | 2–4 GB 内存 | ✅ ~70 MB |
| 消息存储 | 数据库 | ✅ 一个 JSONL 文件 |
| 接入新 agent | 写平台插件 | ✅ 跑一个 connector |

---

## 30 秒跑起来

```bash
git clone https://github.com/ialer/AI-team-hub.git
cd AI-team-hub

cp config.example.json config.json
# 改两处：adminToken 设一个长随机串；agents 列表填你的 agent

node server/index.mjs
# → http://localhost:8899
```

没有 `npm install`，没有构建步骤。Node 20+ 即可。

### 加一个 agent

1. 在 `config.json` 的 `agents` 里加一项：

```json
{
  "id": "my-agent",
  "name": "我的助手",
  "color": "#22d3ee",
  "mode": "connector"
}
```

2. 取它的 token：

```bash
node server/tokens.mjs my-agent
```

3. **在 agent 那台机器上**跑 connector：

```bash
node connectors/connector.mjs --config my-agent.json --verbose
```

```json
// my-agent.json
{
  "hub": "http://hub-host:8899",
  "id": "my-agent",
  "token": "<上一步拿到的 token>",
  "driver": "cli-once",
  "config": {
    "command": "my-agent-cli",
    "args": ["run", "{text}"]
  }
}
```

就这样。Hub 不需要知道你那台机器的地址、SSH、密码。

---

## 两种接入模式

### connector（推荐）

agent 主动连出来，Hub 完全不碰它。

```
Hub  ◀──── HTTP 长轮询 ────  Connector  ──本地调用──▶  你的 agent
```

- 支持 NAT、内网、动态 IP
- Hub 不需要任何凭据
- 断线自动重连

### push（兼容模式）

Hub 主动调出去，适合一次性 CLI 或没有常驻进程的 agent。

```json
{
  "id": "one-shot",
  "mode": "push",
  "adapter": "cli-once",
  "config": { "command": "some-cli", "args": ["{text}"] }
}
```

> `mode: "push"` 保留是为了兼容早期部署。新接入优先用 connector。

---

## 内置 driver / adapter

同一份代码，`push` 模式由 Hub 调用，`connector` 模式由 agent 侧调用。

| id | 用于 | 关键配置 |
|---|---|---|
| `cli-once` | 跑一次就退出的 CLI | `command`, `args`, `sessionFlag`, `sessionPattern` |
| `cli-json` | 输出 NDJSON 事件的 CLI | 同上，自动解析 `final.text` / `sessionId` |
| `openai-compat` | 任何 OpenAI 兼容 API | `url`, `token`, `timeoutMs` |
| `http-webhook` | 自定义 HTTP agent | `url`, `headers` |
| `command` | 万能兜底（跨平台 shell） | `command` |

### 支持哪些 harness

因为协议只是 HTTP，**任何能发请求的东西都能接**：

- DeepSeek Harness / DSH（`cli-json`，读 NDJSON）
- Hermes（`cli-once` + `--resume` 固定会话）
- CowAgent / LiteLLM / Ollama / vLLM（`openai-compat`）
- Claude Code / Codex / 自研脚本（`command` 或 `http-webhook`）
- 甚至一个 shell 脚本：`curl` 长轮询 + `curl` 回帖

---

## 固定会话

agent 每次被唤醒应该记得上次说了什么。Hub 不猜，它只**存**：

- agent 在回复里带上 `sessionId`
- Hub 存进 `data/sessions.json`
- 下次唤醒时把 `sessionId` 一起给 agent
- agent 自己用它恢复上下文

各 harness 怎么恢复上下文是它们自己的事，Hub 不介入。

---

## 只有被 @ 才唤醒

这是成本控制的唯一规则：**没人被点名，就只存消息、不叫任何人**。

- `@助手` — 只唤醒一个
- `@all` / `@全体` — 唤醒所有启用的 agent
- 没人 @ — 静默入库

---

## 对话式表单（Dialog）

agent 可以在回复里带一个结构化表单，在消息流里渲染成分步向导，**不打断主对话**。

```json
{
  "text": "需要你确认几个参数",
  "dialog": {
    "id": "dlg_1",
    "title": "新节点部署",
    "steps": [
      { "id": "host", "type": "text", "label": "主机地址", "required": true },
      { "id": "port", "type": "number", "label": "SSH 端口", "default": 22 },
      { "id": "role", "type": "select", "label": "角色", "options": ["relay", "leaf"] },
      { "id": "confirm", "type": "checkbox", "label": "确认可重启", "required": true }
    ]
  }
}
```

人填完点提交 → Hub 把答案作为一条新消息回给该 agent → agent 继续干活。

字段类型：`text` / `number` / `select` / `checkbox` / `textarea`。
状态持久化在 `data/dialogs.json`，刷新页面不丢。

> **边界**：Dialog 是「agent 提议、人来填」，不能当作危险操作的唯一确认凭据。

---

## 工作台（Workspace）

右侧面板提供 `文档` / `任务` / `文件` 三个标签。选中条目「加入对话」→ 作为引用挂到输入框：

```json
{ "text": "看下这个方案", "refs": [{ "surface": "docs", "id": "plan.md", "title": "部署方案" }] }
```

**只传元数据，不传全文。** agent 按需 `GET /api/surface/docs/plan.md` 拉内容 —— 消息轻、省 token、文档更新后引用仍有效。

- `docs` → `data/docs/*.md`
- `tasks` → `data/tasks.json`
- `files` → `data/files/*`

---

## 部署

### Docker（推荐）

```bash
cp .env.example .env      # 设置 HUB_ADMIN_TOKEN
docker compose up -d
```

### 裸 Node + systemd

```bash
node server/index.mjs
```

```ini
[Unit]
Description=AI Team Hub
After=network-online.target

[Service]
WorkingDirectory=/opt/ai-team-hub
ExecStart=/usr/bin/node server/index.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

数据全在 `data/` 一个目录里，`cp -r data/ backup/` 就是完整备份。

---

## 配置

`config.json`（可被 `HUB_*` 环境变量覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8899` | 监听地址 |
| `adminToken` | — | **必填**。所有 agent token 由它派生 |
| `defaultRoom` | `team` | 默认房间 |
| `contextWindow` | `10` | 唤醒时附带给 agent 的上下文条数 |
| `wakeTimeout` | `180` | agent 超时秒数 |

| 环境变量 | 对应 |
|---|---|
| `HUB_PORT` / `HUB_HOST` | `port` / `host` |
| `HUB_ADMIN_TOKEN` | `adminToken` |
| `HUB_DATA_DIR` | 数据目录 |

### Token 是怎么来的

`token = HMAC-SHA256(adminToken, "agent:<id>")` 的前 32 位。

没有 token 表要维护：**换掉 adminToken，所有 agent token 一起换**。

---

## API

### 人（浏览器）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/state` | 成员、房间、在线状态 |
| GET | `/api/messages?room=&after=` | 历史消息 |
| POST | `/api/say` | 发言 |
| GET | `/api/stream` | SSE 实时流 |

### agent

认证：`X-Agent-Id` + `X-Agent-Token` 头，或 `?agent=&token=`

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/agent/hello` | 上线，上报 sessionId |
| GET | `/api/agent/poll?agent=&timeout=50` | **长轮询**，取待处理唤醒 |
| POST | `/api/agent/reply` | 回帖 |

最小 agent 实现（纯 shell）：

```bash
while true; do
  EV=$(curl -s -H "X-Agent-Id: a1" -H "X-Agent-Token: $TOK" \
        "http://hub:8899/api/agent/poll?agent=a1&timeout=50")
  echo "$EV" | jq -c '.events[]' | while read -r e; do
    MSG=$(echo "$e" | jq -r '.msgId')
    TXT=$(echo "$e" | jq -r '.text')
    curl -s -X POST http://hub:8899/api/agent/reply \
      -H "X-Agent-Id: a1" -H "X-Agent-Token: $TOK" \
      -H "Content-Type: application/json" \
      -d "{\"msgId\":$MSG,\"text\":\"收到：$TXT\"}"
  done
done
```

协议细节见 [`docs/PROTOCOL-AGP.md`](docs/PROTOCOL-AGP.md)。

---

## 项目结构

```
server/           Hub（HTTP + SSE + 长轮询 + 消息存储）
  adapters/       5 个内置 driver，push 和 connector 共用
  surfaces.mjs    工作台数据源
public/           前端（无框架、无构建）
connectors/       agent 侧客户端
docs/             架构 / 协议 / 部署
examples/         各 harness 的接入样例
```

---

## 设计取舍

| 决策 | 原因 |
|---|---|
| **HTTP 长轮询而非 WebSocket** | `curl` 就能接；任何语言、任何 harness；穿代理和 NAT |
| **零依赖** | 部署只要 Node；没有 `npm audit`、没有供应链 |
| **JSONL 消息日志** | append-only，不丢写，`tail -f` 可读 |
| **token 派生而非存储** | 没有表要同步，轮换是原子的 |
| **引用只传元数据** | 消息轻、省 token、内容永远最新 |
| **一个文件一个 driver** | 加集成不改 Hub |

---

## 明确不做

用户注册 / 多租户 / E2E 加密 / 富文本编辑器 / 移动 App / 完整 RBAC。
理由：这是给 5–20 人小团队自托管用的，加这些只会让它变重。

---

## License

MIT
