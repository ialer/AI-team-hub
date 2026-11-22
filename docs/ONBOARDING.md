# 接入一个新 agent

目标：**一条命令加入，不改 Hub 配置、不重启 Hub。**

---

## 最短路径

### 1. 在 Hub 机器上，生成加入码

```bash
cd /opt/ai-team-hub            # 或任何装了本项目的目录
export ATH_ADMIN_TOKEN=$(grep HUB_ADMIN_TOKEN .env | cut -d= -f2)

npx ai-team-hub invite --ttl 30 --uses 1
```

输出：

```
✔ 加入码已生成：QSMW2P69
  有效期 30 分钟 · 可用 1 次

在新 agent 的机器上执行：
  npx ai-team-hub join http://hub-host:8899 --code QSMW2P69
```

代码里没有 0/O/1/I/L，因为加入码会被念出来、手抄。

### 2. 在 agent 那台机器上，执行那条命令

```bash
npx ai-team-hub join http://hub-host:8899 --code QSMW2P69 \
  --id my-agent --name "我的助手" --role "数据分析"
```

输出：

```
✔ 已加入：我的助手 (my-agent)
  Hub: http://hub-host:8899
✔ 配置已写入 ~/.ath/agent.json (权限 600)
```

**到这一步 agent 已经在 Hub 里了**，页面右上角会立刻出现它。没有改配置、没有重启、没有断别人连接。

### 3. 告诉它怎么被调用

编辑 `~/.ath/agent.json` 里的 `config`：

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

### 4. 启动连接

```bash
npx ai-team-hub connect
```

```
[..] connector up — agent=my-agent driver=cli-once hub=http://hub-host:8899
[..] hello ok (session=none)
[..] transport: websocket
[..] ws connected
```

### 5. 自检

```bash
npx ai-team-hub doctor
```

```
✔ 配置：~/.ath/agent.json
✔ Hub 可达：AI-team-hub v0.3.0 · 6/6 在线
✔ token 有效
✔ 命令可执行：my-agent-cli
✔ 全部检查通过
```

---

## 命令一览

| 命令 | 在哪台机器跑 | 作用 |
|---|---|---|
| `ath up` | Hub | 启动 Hub |
| `ath invite` | Hub | 生成加入码 |
| `ath tokens [id]` | Hub | 查 agent token |
| `ath rm <id>` | Hub | 移除用加入码加的 agent |
| `ath join <url> --code` | agent | 用加入码接入 |
| `ath connect` | agent | 启动连接 |
| `ath doctor` | agent | 自检 |

`ath` 与 `ai-team-hub` 是同一个程序。

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
| **加入码加入** | `ath join`，存在 `data/agents.json` | `ath rm <id>`，即时生效 |

### token 是算出来的

```
token = base64url( HMAC-V8.4(adminToken, "agent:<id>") )[0:32]
```

没有 token 表。知道 `adminToken` 就能算任何 agent 的；改 `adminToken` 全部同时失效。

```bash
ath tokens              # 所有
ath tokens my-agent     # 单个
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
Hub 机器和 agent 机器的时钟差太多，或者码已过期/用完。重新 `ath invite`。

**doctor 说 token 校验失败**
Hub 的 `HUB_ADMIN_TOKEN` 变过。用新 adminToken 重算：`ath tokens <id>`，把新 token 填进 agent 配置。

**连上了但 @ 它没反应**
`config.command` 写的命令在 agent 机器上跑不起来。先手动跑一遍：
```bash
my-agent-cli run "只回两个字：测试"
```

**想改 agent 的名字/角色**
目前要么 `ath rm` 再 `ath join`，要么直接改 Hub 的 `data/agents.json` 后重启。

**Hub 绑定在特定 IP，`ath` 连不上**
`ath` 会依次尝试：`--hub` → `ATH_HUB` → `~/.ath/agent.json` → Hub 的 `config.json`。都不对就显式给：
```bash
ath doctor --hub http://10.0.0.5:8899
```
