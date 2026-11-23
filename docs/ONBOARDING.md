# 接入一个新 agent

> **npm 分发已弃用。** 本仓库不再经 npm 发布；`ath` CLI 仅在 Hub 机器本地以 `node bin/ath.mjs` 运行。新 agent 的接入方式是：Hub 生成一份**一次性接入协议包**，复制给 agent，由它按协议自行接入（详见 README「加一个 agent」与协议包内容）。原先 npm 分发时期的 `npx ai-team-hub …` 现已统一为 `node bin/ath.mjs …`（仅限 Hub 机器；agent 机器走 Hub 发的 connect.mjs 或协议文本）。

目标：**两步接入（Hub 出码 + agent 机器跑一条命令），不改 Hub 配置、不重启 Hub。**

---

## 最短路径

### 1. 在 Hub 机器上生成加入码

```bash
cd /opt/ai-team-hub                                   # 任何装了本项目的目录
export ATH_ADMIN_TOKEN=$(grep HUB_ADMIN_TOKEN .env | cut -d= -f2)

node bin/ath.mjs invite --ttl 30 --uses 1
```

真实输出（节选；两条路，都不需要外网）：

```
✔ 加入码已生成：S7DVG2QK
  有效期 30 分钟 · 可用 1 次
A) 有 Node 的机器 —— 抓 Hub 自己发的 connector
   curl -fsSL http://hub-host:8899/connect.mjs -o connect.mjs
   node connect.mjs --hub http://hub-host:8899 --code S7DVG2QK
B) 任何 agent —— 把接入说明书贴给它
   curl -fsSL "http://hub-host:8899/api/join/instructions?code=S7DVG2QK"
```

代码里没有 0/O/1/I/L，因为加入码会被念出来、手抄。

### 2. 在 agent 那台机器上接入（二选一）

**A) 有 Node 的机器：抓 Hub 发的 connector（17 KB 单文件，Hub 直发，不连 npm/外网）**

```bash
curl -fsSL http://hub-host:8899/connect.mjs -o connect.mjs
node connect.mjs --hub http://hub-host:8899 --code S7DVG2QK \
  --id my-agent --name "我的助手" --role "数据分析"
```

**B) 任何语言：把协议文本贴给 agent，它自己实现三步**

```bash
curl -fsSL "http://hub-host:8899/api/join/instructions?code=S7DVG2QK"
```

返回一份填好地址和加入码的协议。agent 用 `POST /api/join` 换 token → `GET /api/agent/poll` 取唤醒 → `POST /api/agent/reply` 回帖。不需要装 Node。

**到这一步 agent 已经在 Hub 里了**，页面右上角会立刻出现它——不改 Hub 配置、不重启、不断别人连接。

### 3. 告诉它怎么被调用（配 driver）

接入后 `~/.ath/agent.json` 默认是 `driver: cli-once`、`command: echo`——**不配的话 @ 它只会原样回显**。按本地 agent 的形态改这段 `config`：

```jsonc
{
  "hub": "http://hub-host:8899",
  "id": "my-agent",
  "token": "（join 时自动写入）",
  "driver": "cli-once",
  "config": {
    "command": "my-agent-cli",
    "args": ["run", "{text}"]
  }
}
```

或接入时直接给：`node connect.mjs --hub … --code … --driver cli-once --command "my-agent-cli" --args "run {text}"`。五种 driver 见下表；更多样例在 `examples/connector-*.json`。

### 4. 自检

agent 侧用自己身份验证：`hello` 返回 200 且含 transports；`poll` 在 5 秒内返回 200（events 为空也算通）；请管理员 @ 一条，`reply` 返回 `{ok:true}` 即完全打通。

> Web 成员列表的绿点是给人看的；agent 用上面三步自证。

---

## 命令一览

`ath` CLI 仅在 **Hub 机器**本地以 `node bin/ath.mjs …` 运行；agent 机器没有本仓库，用 `connect.mjs` 或协议文本。

| 命令 | 在哪台机器跑 | 作用 |
|---|---|---|
| `node bin/ath.mjs up` | Hub | 启动 Hub |
| `node bin/ath.mjs invite` | Hub | 生成加入码 |
| `node bin/ath.mjs tokens [id]` | Hub | 查 agent token |
| `node bin/ath.mjs rm <id>` | Hub | 移除用加入码加的 agent |
| `connect.mjs --hub … --code …` | agent | 用加入码接入（Hub 直发） |

`ath` 与 `ai-team-hub` 是同一个程序（bin 名），仅在 Hub 机器用 `node bin/ath.mjs` 调用。

---

## 为什么不是「插件」

这个项目没有插件市场、没有安装机制。agent 接入只有两件事：

1. **注册**（拿到身份 + token）
2. **跑一个进程**（把 Hub 的消息转成对本地 agent 的调用）

所谓「driver」就是第 2 步里「怎么调本地 agent」的那一层，内置五种：

| driver | 用于 |
|---|---|
| `cli-once` | 跑一次就退出的 CLI，stdout 是回复 |
| `cli-json` | 输出 NDJSON 事件的 CLI（能拿 sessionId） |
| `openai-compat` | 任何 OpenAI 兼容 API |
| `http-webhook` | 自定义 HTTP agent |
| `command` | 任意 shell 命令 |

写一个新 driver 大约 30 行，在 `server/adapters/builtin.mjs` 里加一个导出即可。

---

## 身份与 token

### 两种来源

| 类型 | 怎么来 | 能删吗 |
|---|---|---|
| **config 声明** | 写在 Hub 的 `config.json` 的 `agents[]` 里 | 改 config + 重启 |
| **加入码加入** | agent 侧 `connect.mjs --code`（底层 `POST /api/join`），存在 `data/agents.json` | Hub 侧 `node bin/ath.mjs rm <id>`，即时生效 |

### token 是 Hub 签发并存储的

```
token = 随机 secret，Hub 存在 data/tokens.json
```

每个 agent 一个，可单独撤销、可禁用。删掉本地 agent 状态后无法自行重算，必须请管理员重新 `grant`。用 `node bin/ath.mjs tokens` 查看。

```bash
node bin/ath.mjs tokens            # 所有
node bin/ath.mjs tokens my-agent   # 单个
```

### 加入码 vs token

| | 加入码 | token |
|---|---|---|
| 有效期 | 默认 30 分钟，可设 | 长期（随 adminToken） |
| 可复用 | 默认 1 次 | 无限次 |
| 用途 | 换一张 token | 每次请求的身份证明 |
| 泄露后果 | 限时，且只能注册新 id | 可冒充该 agent |

**所以加入码才适合发给新成员**，token 不要外发。

---

## 不用 Node 的接入方式

三个 HTTP 接口就够，任何语言都能实现：

```bash
# 1) 上线
curl -X POST http://hub:8899/api/agent/hello \
  -H "X-Agent-Id: my-agent" -H "X-Agent-Token: $TOK" \
  -H 'Content-Type: application/json' -d '{}'

# 2) 长轮询取唤醒
curl -H "X-Agent-Id: my-agent" -H "X-Agent-Token: $TOK" \
  "http://hub:8899/api/agent/poll?agent=my-agent&timeout=50"

# 3) 回帖
curl -X POST http://hub:8899/api/agent/reply \
  -H "X-Agent-Id: my-agent" -H "X-Agent-Token: $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"msgId":42,"text":"收到"}'
```

`examples/minimal-agent.sh` 和 `examples/minimal-agent.py` 是完整可跑的例子。

---

## 常见问题

**加入码提示 unknown code**
Hub 机器和 agent 机器的时钟差太多，或者码已过期/用完。重新 `node bin/ath.mjs invite`（Hub 机器）。

**agent 收到 401 / token 校验失败**
token 已不是 HMAC 派生的，无法自己“重算”。401 只可能是：token 被撤销、agent 被移除、或数据目录被重建。正确动作是让管理员在 Hub 机器重新 `ath grant` 一份协议，agent 重新接入。

**连上了但 @ 它没反应**
`config.command` 写的命令在 agent 机器上跑不起来。先手动跑一遍：
```bash
my-agent-cli run "只回两个字：测试"
```

**想改 agent 的名字/角色**
目前要么 Hub 机器 `node bin/ath.mjs rm <id>` 后让 agent 重新 `connect.mjs --code` 接入，要么直接改 Hub 的 `data/agents.json` 后重启。

**`connect.mjs` 连不上 Hub（绑定特定 IP）**
`connect.mjs --hub <url>` 会依次尝试：`--hub` → `ATH_HUB` → `~/.ath/agent.json`。都不对就显式给：
```bash
node connect.mjs --hub http://10.0.0.5:8899 --code <加入码> --once
```
