# 分组讨论

多个 agent 在一个房间里轮流发言，直到某个条件满足。Hub 只负责调度和记录，不解释内容。

## 它是什么

一场讨论 = **一个房间** + **每轮两个决策**：

| 决策 | 选项 |
|---|---|
| 谁发言 | `round-robin` / `selector` / `mention` |
| 何时停 | 轮数 / token 预算 / 墙钟 / 关键词 / 人工停止 / 收敛 |

发言严格串行：一次只有一个 agent 说话，其余在听。发言者由 Hub 在房间里 `@`，被 `@` 的 agent 走正常唤醒路径回复，回复进入同一个房间。参与者至少 2 个已配置的 agent，`topic` 不能为空。

---

## 三种发言策略

字段：`policy.turnTaking`，默认 `round-robin`。

| 策略 | 选取方式 | 失败与边界 |
|---|---|---|
| `round-robin` | 按 `participants` 顺序，第 n 轮取 `n % 人数` | 默认不允许同一人连说两轮（`allowRepeatSpeaker: false`） |
| `selector` | 调一个小模型，让它输出下一个发言者 id 或 `DONE` | 未配 `discussion.selector`、返回 `DONE`、超时、返回无法识别的 id，都静默回退到 `round-robin` |
| `mention` | 等人工在房间里 `@` 某个参与者 | 超过 `turnTimeoutSec`（默认 180 s）无人 @ 则结束，原因 `no-speaker` |

### selector 配置

```jsonc
// config.json
{
  "discussion": {
    "selector": {
      "url": "http://127.0.0.1:11434/v1/chat/completions",
      "model": "qwen2.5:7b",     // 可选
      "token": "",               // 可选，作为 Bearer token 发送
      "timeoutMs": 20000         // 可选，默认 20 s
    }
  }
}
```

调用 OpenAI 兼容的 `/chat/completions`：`max_tokens: 20`、`temperature: 0`，prompt 里带话题、参与者列表和最近 8 条发言。selector 故障不会让讨论中断，只会退化成轮流。

> **成本**：selector 模式每一轮比 `round-robin` 多一次小模型调用，量级约 300 token/次（响应上限 20 token，其余是 prompt）。长讨论里这笔开销会累积。

---

## 停止条件

任何一条命中即结束：

| 闸门 | 配置字段 | 默认值 | 结束状态 |
|---|---|---|---|
| 外部停止 | 调 stop API | — | `stopped` |
| 墙钟超时 | `timeoutSec` | `600` | `timeout` |
| token 预算 | `maxTokens` | `200000` | `budget` |
| 轮数上限 | `maxTurns` | `12` | `done` |
| 关键词 | `stopOn` | `[]` | `keyword` |
| 收敛检测 | `convergenceRounds` | `3` | `done` |

另有三种非正常结束：被选中的 agent 在 `turnTimeoutSec` 内没回复 → `silent`；选不出发言者 → `no-speaker`；内部异常 → `error`。

**收敛检测**：保留最近 `convergenceRounds` 条发言，比较相邻两条的字符二元组 Jaccard 相似度；若相邻几对相似度都大于 0.9，判定"没人再说新东西"，提前结束，原因 `converged`。这是启发式判断，不额外调用模型。

其他策略字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowRepeatSpeaker` | `false` | 是否允许同一人连说两轮 |
| `turnTimeoutSec` | `180` | 等一轮回复的上限；`mention` 模式也用它等人工 @ |

token 是估算值（CJK 约 1 字 1 token，拉丁约 4 字符 1 token），用于预算控制，不做精确计费。

---

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/discussions` | 创建并立即开始 |
| GET | `/api/discussions` | 列出全部 |
| GET | `/api/discussions/:id` | 查一场，含逐轮记录 |
| POST | `/api/discussions/:id/stop` | 在当前轮结束后停止 |

### 请求体示例

```http
POST /api/discussions
Content-Type: application/json

{
  "topic": "日志告警要不要加值班轮询",
  "participants": ["bob", "carol", "dave"],
  "room": "team",
  "policy": {
    "turnTaking": "selector",
    "maxTurns": 8,
    "maxTokens": 60000,
    "timeoutSec": 300,
    "stopOn": ["结论：", "不做了"],
    "allowRepeatSpeaker": false,
    "turnTimeoutSec": 180,
    "convergenceRounds": 3
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `topic` | string | 必填，纯空白会被拒绝 |
| `participants` | string[] | 必填，去重后至少 2 个已配置 agent id；未知 id 被丢弃 |
| `room` | string | 可选，缺省用 `disc_<8位hex>`，也是房间名 |
| `policy` | object | 可选，各字段见上两节；未传的保留默认值 |

响应：

```jsonc
{
  "ok": true,
  "discussion": {
    "id": "disc_4f1a9c02",
    "room": "disc_4f1a9c02",
    "topic": "日志告警要不要加值班轮询",
    "participants": ["bob", "carol", "dave"],
    "policy": { "turnTaking": "selector", "maxTurns": 8 },
    "status": "running",
    "createdAt": 1795325865027,
    "turns": [],
    "tokens": 0,
    "summary": null,
    "stopReason": null
  }
}
```

`policy` 在响应里是**合并后的完整对象**，不只是请求里传的几项。`turns[]` 每项形如 `{ "n": 1, "speaker": "bob", "at": 1795325870000, "text": "...", "tokens": 96 }`；结束后追加 `endedAt`，`stopReason` 写明结束原因。

每次状态变化（创建、每轮发言、结束）均以 SSE `discussion` 事件广播给浏览器。结束后 Hub 往默认房间发一条摘要消息，含参与人、轮数、停止原因和每轮前 90 字；完整记录留在讨论自己的房间。记录持久化在 `data/discussions.json`。

---

## 一次讨论的状态流转

```
POST /api/discussions
        ↓
   running ──每轮──> 选发言者 → @ 唤醒 → 等待回复 → 记账 → 检查闸门
        ↓
   done / stopped / timeout / budget / keyword / silent / no-speaker / error
```

`maxTurns` 和 `converged` 都归入 `done`，靠 `stopReason` 区分。只有 `running` 状态的讨论能被 stop；重复 stop 返回当前记录，不报错。
