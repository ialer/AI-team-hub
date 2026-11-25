# Workspace — 工作台与引用

参照飞书的做法：把文档、任务、文件"拎"进对话上下文，让沟通和产出待在同一个界面里。

---

## 用法

右侧面板（手机上是底部抽屉）有三个标签：

```
┌───────────────────────────┬──────────────────┐
│  消息流                    │ 工作台            │
│                           │ [文档][任务][文件] │
│  [人] 看下这个方案          │ ┌──────────────┐ │
│    ┌ 引用：部署方案 ────┐   │ │部署方案.md   │ │
│    └──────────────────┘   │ │巡检记录.md   │ │
│                           │ └──────────────┘ │
│  [助手] 收到，我看了…       │  点条目加入对话   │
└───────────────────────────┴──────────────────┘
```

点一个条目 → 它变成输入框上方的引用芯片 → 随下一条消息发出。

---

## 为什么只传引用，不传全文

消息里带的是元数据：

```jsonc
{
  "text": "看下这个方案",
  "refs": [
    { "surface": "docs", "id": "deploy-plan.md", "title": "部署方案" }
  ]
}
```

agent 需要内容时自己拉：

```bash
curl http://hub:8899/api/surface/docs/deploy-plan.md
```

三个好处：

1. **消息轻** —— 一个 50 KB 的文档不会把消息日志撑爆，UI 也不卡
2. **省 token** —— agent 只在真需要时读，不是每条消息都塞全文
3. **永远最新** —— 引用指向文件本身，文档改了引用依然有效

---

## 内置 surface

### `docs` — 文档

- 位置：`data/docs/*.md`
- 列表字段：`id`（文件名）、`title`（去扩展名）、`meta`（大小 + 修改时间）
- 取内容：`GET /api/surface/docs/<filename>`

直接往目录里丢 `.md` 文件就行，不需要注册。

### `tasks` — 任务

- 位置：`data/tasks.json`
- 结构：

```json
[
  { "id": "t1", "title": "迁移 Hub 到新架构", "status": "doing", "owner": "bob" },
  { "id": "t2", "title": "补齐 README", "status": "todo" }
]
```

- 列表展示 `status · @owner`

### `files` — 文件

- 位置：`data/files/`
- 任意文件，列出名称和大小

---

## API

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/surfaces` | 所有 surface 的 `{id, label}` |
| GET | `/api/surface/:id` | `{items: [{id, title, meta}]}` |
| GET | `/api/surface/:id/:refId` | 文件内容（带 mime） |
| POST | `/api/surface/:id` | 写入（见上「写入」一节），需 admin 或 agent token |

---

## 加一个 surface

在 `server/surfaces.mjs` 里加一个对象，然后加进 `byId` 映射：

```js
const links = {
  id: 'links',
  label: '链接',
  async list() {
    return [
      { id: 'l1', title: '项目主页', meta: 'github.com/...' },
    ];
  },
  async fetch(id) {
    return { mime: 'text/plain', content: 'https://github.com/...' };
  },
};

const byId = new Map([docs, tasks, files, links].map((s) => [s.id, s]));
```

前端不用改——面板的标签是从 `/api/surfaces` 动态读的。

---

## 写入（v0.4.1 起）

工作台原本只能"往目录里丢文件"，没有入口——所以它一直是空的。现在三个 surface 都有写接口，
**管理员和 agent 都能写**，这也是 agent 产物能自动出现在右栏的最小闭环。

鉴权二选一：`x-admin-token`（面板/运维）或 `x-agent-id` + `x-agent-token`（agent 写自己的产出）。
两者都没有 → 401。

| 目标 | 请求 | 说明 |
|---|---|---|
| 文档 | `POST /api/surface/docs` `{ "id": "plan", "content": "# ..." }` | 自动补 `.md`；`overwrite:false` 时已存在返回 409 |
| 文档（按路径） | `POST /api/surface/docs/plan.md` 同上 | 路径里的名字优先 |
| 任务 | `POST /api/surface/tasks` `{ "upsert": {"id","title","status","owner"} }` | 同 id 覆盖，不重复追加 |
| 任务（删除） | `POST /api/surface/tasks` `{ "remove": "t1" }` | 不存在返回 404 |
| 文件 | `POST /api/surface/files?name=report.csv`，body 为原始字节 | `--data-binary`，上限 8 MB |

限制：文档/任务 body ≤ 1 MB；文件名经 `safeName()` 归一（`basename` + 去控制字符 + 截断 120 字符），
`../` 之类不会逃出目标目录——有单测覆盖。

**面板入口**：工作台底部有「＋ 新建文档 / 新建任务 / 上传文件」，需要先在「成员」标签解锁
（写入用存下来的 admin token）。未解锁点击只提示，不弹层。

### agent 写入示例

```bash
curl -X POST http://hub:8899/api/surface/docs \
  -H "X-Agent-Id: bob" -H "X-Agent-Token: $ATH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"deploy-report","content":"# 部署报告\n..."}'
```

---

## 一个刻意的限制

**工作台不做编辑器。** 它只负责「找到东西」「引用进对话」，以及上面那条最小的写入通道。
真要长时间编辑文档，用你自己的编辑器改 `data/docs/` 里的文件，或者让 agent 改。

理由是：一旦开始做富文本编辑器，就会滑向"再造一个 Notion"，而这个项目的价值是**通信**，不是文档编辑。
