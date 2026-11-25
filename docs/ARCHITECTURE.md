# 架构

## 一句话

Hub 是消息总线 + 唤醒路由，**不认识任何具体 agent**。agent 通过 connector 主动连出来，或者由 Hub 用 adapter 推一把。

---

## 组件

```
┌─────────────────────────────────────────────────────────────┐
│  Hub（一台常开的机器，~70MB 内存）                             │
│                                                             │
│  index.mjs      引导：静态 → routes → 404，listen             │
│  http.mjs       底层助手：body/auth/静态/logger                │
│  context.mjs    实例装配：注册表/存储/讨论/加入码                │
│  routes/*       端点：human / agent / media / admin /          │
│                 discussions / workspace                │
│  realtime.mjs   WebSocket 推送 + 流式                          │
│  hub.mjs        消息追加、@ 路由、唤醒、dialog 提交             │
│  store.mjs      MessageLog(JSONL) + JsonStore(会话/表单)       │
│  registry.mjs   成员表 + token 校验 + presence                 │
│  token-store.mjs 随机 token 存储（可撤销）                     │
│  transport.mjs  SseHub（浏览器）+ WakeQueue（agent 长轮询）     │
│  mentions.mjs   @ 解析                                        │
│  surfaces.mjs   工作台数据源                                   │
│  adapters/      push 模式的 5 个 driver                       │
└───────────┬──────────────────────────────┬──────────────────┘
            │ SSE（浏览器）                  │ 长轮询（agent）
            ▼                              ▼
     ┌──────────┐                  ┌─────────────────┐
     │  浏览器   │                  │   Connector     │
     └──────────┘                  │  （agent 侧）    │
                                   └────────┬────────┘
                                            │ 本地调用
                                   ┌────────▼────────┐
                                   │  真实 Agent     │
                                   │ CLI / HTTP / …  │
                                   └─────────────────┘
```

---

## 两条唤醒路径

### connector（默认）

```
人 @agent
  → hub.say() 追加消息
  → 解析 mentions，命中 agent
  → wakeQueue.push(agentId, payload)   // 内存队列
  → agent 的 poll 请求被唤醒，拿到 payload
  → agent 本地跑完 → POST /api/agent/reply
  → hub.reply() 追加回复 → 广播
```

Hub 全程不知道 agent 的地址。断线期间唤醒最多保留 5 分钟，过期丢弃（重放一条几小时前的"@你做 X"比丢弃更糟，agent 可以读历史补课）。

### agent 忙时的第二次 @：排队，不丢

早期实现里，agent 正在处理上一轮时再来一条 @ 会被直接跳过（日志 `skip <id>: already running`），
消息就此消失。对闲聊无妨，对任务消息就是丢活。

现在改为按 agent 排队：

```
人 @agent（第 1 条） → inFlight 为空 → 立即投递
人 @agent（第 2 条） → inFlight 占用 → pending[agentId].push(payload)   // 最多 5 条
agent 回帖 → clearInFlight() → drainPending() → 投递第 2 条
```

- 队列上限 `config.pendingWakeLimit`（默认 5），超出记 `drop <id>: N wakes already waiting`；
- 回合超时（`wakeTimeout`）同样会 drain，超时不等于丢下一条；
- 队列只在内存里，Hub 重启后不保留（与唤醒队列一致）。

---

## 为什么只有Bob会"被占用"

同一套代码，只有长任务成员出问题，是因为三个失效点叠加：

| 层 | 现象 | 根因 | 修复 |
|---|---|---|---|
| Hub | 第二条 @ 石沉大海 | agent 忙时 `continue` 跳过 | pending 队列 + drain |
| connector → dsh | `session ... is already owned by an active write handle` | 同一会话被两次唤醒并发打开；dsh 对会话持写句柄，后者必败 | wake 脚本用 `flock` 串行化（同一会话同时只允许一个 dsh），超时 900s |
| dsh 会话 | `stored session ... is corrupt` | 上一条运行被 connector 超时强杀，zstd 日志写了半行 | 脚本检测到 corrupt 时把会话移开、自动开新会话 |

另有一条隐性污染：`docker exec` 默认以 root 进入容器，headless dsh 因此以 root 写 `session.lock`，
而常驻的 web dsh 以 957 运行，权限不一致。现在 connector 侧固定 `docker exec -u 1000:1000`。

**给其他成员的启示**：短任务（几秒到几十秒）几乎撞不上；任务越接近区分钟级，越需要这三件套。

---

### push（兼容）

```
人 @agent
  → hub.wakeViaAdapter()
  → adapter.wake({text, sessionId, config})
  → 拿返回值 → hub 追加回复
```

同步、简单、无状态。适合一次性 CLI。

---

## 一条消息的生命周期

```
POST /api/say
  ↓
MessageLog.append({id, ts, room, from, text, mentions, refs, dialog})
  ↓ 写 messages.jsonl（append-only）
SseHub.broadcast('message', m)      → 所有浏览器即时可见
  ↓
hub.wake(m)                          → 只叫被 @ 的人
  ├─ inFlight 有该 agent？跳过（防止并发重复唤醒）
  ├─ mode=connector → wakeQueue.push
  └─ mode=push      → adapter.wake()
```

`id` 单调递增，同时充当日志游标——agent 重连后问"给我 id > N 的"即可。

---

## 数据布局

```
data/
├── messages.jsonl    追加写，一行一条，永不重写
├── sessions.json     { agentId: sessionId }
├── dialogs.json      { dialogId: {steps, values, status, …} }
├── docs/             *.md，工作台「文档」
├── files/            任意文件，工作台「文件」
├── tasks.json        [{id,title,status,owner}]，工作台「任务」
└── hub.log           运行日志
```

**`cp -r data/ backup/` 就是完整备份。** 没有数据库，没有 schema 迁移。

`messages.jsonl` 每行自带 `id` 和 `ts`，任何工具都能 `tail -f` 或导入分析。

---

## 内存策略

| 结构 | 上限 | 超限行为 |
|---|---|---|
| `MessageLog.items` | 5000 条 | 丢最旧的（磁盘文件不动） |
| `WakeQueue.pending` | 每 agent 最多 5 分钟 | 过期丢弃 |
| `SseHub.clients` | 无显式上限 | 写失败即移除 |

5000 条窗口意味着历史超过 5000 条后，旧消息仍在磁盘上但不再进内存索引。真要全部加载，改 `maxMemory` 即可——这是刻意的取舍，防止长期运行 OOM。

---

## 为什么不用 WebSocket

`curl` 能说 HTTP，说不了 WS。长轮询让"任何语言的 harness 都能接"这件事变成真的，代价只是空闲时每 50 秒一个请求。

同理，前端用 SSE 而不是 WS：SSE 是浏览器原生、自动重连、单向足够。

---

## 一致性边界

- **单进程**。不做多实例，因此没有分布式锁、没有消息去重表。
- **写入串行**。Node 单线程 + `appendFileSync`，不会交错。
- **崩溃恢复**。`messages.jsonl` 有半行就跳过那一行启动，不影响其余。

这些都是刻意的：这个项目的目标是"5–20 人团队自托管"，不是"多活集群"。

---

## 扩展点

| 想加什么 | 加在哪 | 不用改 |
|---|---|---|
| 新 agent 形态 | `server/adapters/builtin.mjs` 里加一个导出 + 注册 | Hub 核心 |
| 新工作台数据源 | `server/surfaces.mjs` 里加一个对象 | 路由 |
| 新前端页面 | `public/` 加文件 | 后端 |
| 新的唤醒策略 | `hub.mjs` 的 `wake()` | 存储 |

一个 driver 大约 30 行。加集成不该比这更复杂。
