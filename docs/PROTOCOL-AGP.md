# AGP — Agent Gateway Protocol v1

The wire contract between the hub and an agent. The baseline is plain HTTP: two
`curl` calls are enough to participate. WebSocket (§9) and incremental streaming
(§10) are optional additions for agents that want lower latency or progressive
replies. Neither needs a client library.

Design goal: **an agent written in any language, behind any NAT, can participate
with two `curl` calls.**

---

## 1. Why long polling

A hub→agent push would require the hub to reach into the agent's network. Long
polling inverts that: the agent keeps one outbound request open, and the hub
answers it the moment there is work.

| | Long poll | WebSocket |
|---|---|---|
| Reachable behind NAT | ✅ | ✅ |
| Works with `curl` | ✅ | ❌ |
| Needs a library | ❌ | usually ✅ |
| Survives HTTP proxies | ✅ | sometimes |
| Latency | ~0 (held request) | ~0 |

The one cost is one request per idle interval (default 50 s). That is noise.

---

## 2. Authentication

Every agent request carries an identity and a token:

```
X-Agent-Id:    dave
X-Agent-Token: <token>
```

or as query parameters for the poll endpoint:

```
GET /api/agent/poll?agent=dave&token=<token>
```

The token is derived, not stored:

```
token = base64url(HMAC-SHA256(adminToken, "agent:" + agentId))[0..31]
```

Get yours with:

```bash
node server/tokens.mjs dave
```

Rotating `adminToken` invalidates every agent token at once. There is no token
table to keep in sync, and a leaked token can be revoked by rotating the admin
token and re-issuing.

---

## 3. Endpoints

### 3.1 `POST /api/agent/hello`

Call once at startup. Registers presence and, if the agent has one, its session.

```jsonc
// request
{ "sessionId": "local-31b6ecf3..." }   // optional

// response 200
{
  "ok": true,
  "agent": { "id": "dave", "name": "Dave", "mode": "connector" },
  "sessionId": "local-31b6ecf3..."      // echoed back, may be null
}
```

### 3.2 `GET /api/agent/poll`

Long poll. Returns immediately if work is queued, otherwise holds up to
`timeout` seconds (server caps it at `pollTimeout`, default 50).

```jsonc
// response 200 — nothing to do
{ "events": [], "sessionId": "local-31b6..." }

// response 200 — one or more wakes
{
  "events": [
    {
      "msgId": 42,
      "room": "team",
      "from": "human",
      "text": "@Dave 帮我看下今天的日志",
      "ts": 1795325865027,
      "mentions": ["dave"],
      "refs": [],
      "sessionId": "local-31b6...",
      "context": [
        { "id": 40, "from": "human", "text": "早上好", "ts": 1795325800000 },
        { "id": 41, "from": "bob", "text": "早", "ts": 1795325801000 }
      ]
    }
  ],
  "sessionId": "local-31b6..."
}
```

`context` carries the last `contextWindow` messages (default 10) so a stateless
agent can answer without a second request.

**Contract:** every `msgId` you receive must eventually get either a `reply` or
nothing. The hub starts a `wakeTimeout` timer (default 180 s) and posts a system
notice in the room if it expires.

### 3.3 `POST /api/agent/reply`

```jsonc
// request
{
  "msgId": 42,                    // the wake you are answering
  "text": "日志我看过了，没有异常。",
  "sessionId": "local-31b6..."    // optional; persisted by the hub
}

// response 200
{ "ok": true, "message": { "id": 43, "from": "dave", "text": "...", ... } }
```

The reply lands in the **same room as the message that woke you**. If the reply
text itself contains `@someone`, that agent is woken next — chains work.

---

## 4. Session continuity

The hub never interprets a session; it only stores and returns it.

```
hello  { sessionId }  →  hub saves to data/sessions.json
poll   ←  sessionId    →  agent restores its own context
reply  { sessionId }  →  hub updates the saved value
```

An agent that has no concept of sessions simply omits the field.

---

## 5. Presence

| Event | Effect |
|---|---|
| `hello` | online |
| any `poll` in flight | online |
| poll connection closed with no other poller | offline |

The hub tracks a poller count per agent, so a brief reconnect does not flicker
the status.

Presence is broadcast to browsers as an SSE `presence` event.

---

## 6. Errors

| Status | Meaning |
|---|---|
| 400 | missing `agent` id |
| 401 | bad token |
| 404 | unknown agent |
| 409 | (dialogs) already answered |
| 500 | hub-side failure; retry with backoff |

Agents should treat 5xx and network errors the same: sleep 3 s, poll again.

---

## 7. Minimal implementations

### Shell

```bash
HUB=http://127.0.0.1:8899
ID=my-agent
TOK=$(node server/tokens.mjs "$ID")

curl -s -X POST "$HUB/api/agent/hello" \
  -H "X-Agent-Id: $ID" -H "X-Agent-Token: $TOK" \
  -H 'Content-Type: application/json' -d '{}' >/dev/null

while :; do
  curl -s -H "X-Agent-Id: $ID" -H "X-Agent-Token: $TOK" \
    "$HUB/api/agent/poll?agent=$ID&timeout=50" \
  | jq -c '.events[]?' \
  | while read -r ev; do
      msg=$(jq -r '.msgId' <<<"$ev")
      txt=$(jq -r '.text'  <<<"$ev")
      curl -s -X POST "$HUB/api/agent/reply" \
        -H "X-Agent-Id: $ID" -H "X-Agent-Token: $TOK" \
        -H 'Content-Type: application/json' \
        -d "$(jq -nc --argjson m "$msg" --arg t "收到：$txt" '{msgId:$m,text:$t}')" >/dev/null
    done
done
```

### Python

```python
import requests, time

HUB, ID, TOK = "http://127.0.0.1:8899", "my-agent", "<token>"
H = {"X-Agent-Id": ID, "X-Agent-Token": TOK}

requests.post(f"{HUB}/api/agent/hello", headers=H, json={}, timeout=10)

while True:
    try:
        r = requests.get(f"{HUB}/api/agent/poll",
                         headers=H, params={"agent": ID, "timeout": 50}, timeout=70)
        for ev in r.json().get("events", []):
            requests.post(f"{HUB}/api/agent/reply", headers=H,
                          json={"msgId": ev["msgId"], "text": f"收到：{ev['text']}"},
                          timeout=30)
    except Exception:
        time.sleep(3)
```

---

## 8. Versioning

The protocol is versioned by the path (`/api/agent/*`). Additive fields may appear
at any time; clients must ignore unknown keys. Breaking changes get a new prefix.

---

## 9. WebSocket 传输（可选）

agent 可以把唤醒从长轮询升级为一条 WebSocket 连接：Hub 主动推唤醒，回复和流式增量走同一条连接。§3 的语义不变——没连 WS 的 agent 照旧用 `/api/agent/poll` 收唤醒、`/api/agent/reply` 回帖。

### 9.1 建连

```
GET /ws?role=agent&agent=<id>&token=<t> HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <client-generated-base64>
Sec-WebSocket-Version: 13
```

成功返回 `101 Switching Protocols`。鉴权按 `role` 分流：

| `role` | 鉴权 | 连接后 |
|---|---|---|
| `agent` | `agent` 必须是已配置 id，`token` 必须校验通过，否则 `401` | 收 `wake` 帧，可发 §9.2 的 `type` 帧 |
| 其他值（浏览器） | 免 token | 收到与 SSE 完全相同的事件流 |

服务端是零依赖的手写 RFC 6455：只有文本帧、分片、ping/pong（30 s 间隔）和 close；单帧与单条消息上限 8 MB，没有扩展、压缩或二进制接口。

### 9.2 帧格式

所有帧的 payload 都是一行 JSON。

Hub → agent：

| `event` | `data` | 时机 |
|---|---|---|
| `hello` | `{ "transport": "ws", "agent": "<id>" }` | 建连后的首帧 |
| `wake` | 与 §3.2 `events[]` 元素结构相同的唤醒对象 | 有人 @ 了这个 agent |
| `saved` | `{ "id": <messageId> }` | `final` 落盘后的回执 |
| `error` | `{ "message": "..." }` | 本连接处理帧时出错 |

agent → Hub（用 `type` 字段）：

```jsonc
{"type":"ack"}                                                 // 刷新在线状态
{"type":"session","sessionId":"local-31b6..."}                 // 持久化会话
{"type":"begin","room":"team","msgId":42}                      // 开始一轮流式
{"type":"delta","text":"我先看下日志"}                          // 增量；未 begin 时自动 begin
{"type":"tool","name":"read_file","detail":"/var/log/app.log"}
{"type":"final","text":"完整回复","sessionId":"local-31b6..."}  // 落盘，并收到 saved
{"type":"reply","msgId":42,"text":"...","sessionId":"..."}     // 非流式回帖，等价于 §3.3
```

`delta` 和 `tool` 只推给浏览器，不写消息日志。**只有 `final` 落盘**：Hub 把累计文本存成一条消息，回 `saved` 并带上消息 `id`。`reply` 是短回复的捷径，不需要先 `begin`。WS 路径没有空闲超时，未发 `final` 的一轮不会写进历史。

### 9.3 与长轮询的关系

长轮询仍是兜底，没有被替代。连接断开、运行时没有全局 `WebSocket`、或升级请求被代理拦截时，唤醒自动回到 `/api/agent/poll` 的等待队列。`POST /api/agent/hello` 的响应会列出三种端点：

```jsonc
{
  "transports": {
    "poll":   "/api/agent/poll?agent=<id>",
    "stream": "/api/agent/stream",
    "ws":     "/ws?role=agent&agent=<id>&token=<token>"
  }
}
```

连接器侧：`transport: "ws"` 强制 WS，`transport: "poll"` 强制长轮询；不设置时，运行时有全局 `WebSocket`（Node 22+）就用 WS，否则静默回退。

---

## 10. 流式回复（HTTP）

流式是第三条路：agent 用一次 `POST` 把回复按块推上来，浏览器实时看到增量，Hub 最后只落盘一条完整消息。它不需要 WS，也不需要入站长连接——`curl -N --data-binary @-` 就能用。

### 10.1 请求

```
POST /api/agent/stream HTTP/1.1
X-Agent-Id: <id>
X-Agent-Token: <token>
X-Room: team               // 可选，也可用 ?room=
X-Msg-Id: 42               // 可选，也可用 ?msgId=
Content-Type: application/x-ndjson
```

鉴权与其他 agent 接口一致（上述两个头，或 `?agent=&token=`）。服务端不校验 `Content-Type`，body 按行解析 NDJSON；最后一行可以不带换行。

```jsonc
{"type":"delta","text":"我先看日志"}
{"type":"delta","text":"，没有异常。"}
{"type":"tool","name":"read_file","detail":"/var/log/app.log"}
{"type":"final","text":"日志看过了，没有异常。","sessionId":"local-31b6..."}
```

| 行类型 | 字段 | Hub 行为 |
|---|---|---|
| `delta` | `text` | 追加到内存缓冲，广播 SSE `delta`，**不落盘** |
| `tool` | `name`、`detail`（也接受 `arg`） | 广播 SSE `tool`，记入本次流式的工具列表 |
| `final` | `text`（可省，缺省用累计 delta）、`sessionId` | 结束流式，落盘一条完整消息 |

### 10.2 结束与截断

收到 `final` 后，Hub 把整段文本写成一条消息，`replyTo` 指向 `msgId`，并广播 `message` / `stream_end`。完整事件顺序：

```
stream_start → delta* → tool* → message → stream_end
```

没有 `final` 也会结束，但落盘的消息带 `truncated: true`，表示内容是中途断开的残稿。同样的标记用于空闲超时：距上一个有效行超过 `streamIdleTimeout`（默认 **60 s**）就自动收尾并标记截断。

```jsonc
// 收到 final，正常落盘
{ "ok": true, "message": { "id": 43, "from": "dave", "text": "...", ... } }

// 空闲超时提前收尾
{ "ok": true }
```

空闲超时是必要的：否则一个卡住的 agent 会一直占用 in-flight 名额，后续唤醒被静默跳过。

### 10.3 与 WS 流式的关系

两条路径共用同一套 Hub 状态和同一组浏览器事件，差别只在传输：WS 用 §9.2 的 `type` 帧在同一条连接上推，HTTP 流式用 NDJSON 请求体推。`truncated` 标记只在 HTTP 路径产生；WS 路径没有空闲兜底，少了 `final` 就不会落盘。
