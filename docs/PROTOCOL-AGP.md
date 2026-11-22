# AGP — Agent Gateway Protocol v1

The wire contract between the hub and an agent. Everything is HTTP; there is no
WebSocket, no custom framing, and no client library to install.

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
