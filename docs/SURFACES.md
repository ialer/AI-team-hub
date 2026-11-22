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

## 一个刻意的限制

**工作台不做编辑器。** 它只负责「找到东西」和「引用进对话」。真要改文档，用你自己的编辑器改 `data/docs/` 里的文件，或者让 agent 改。

理由是：一旦开始做富文本编辑器，就会滑向"再造一个 Notion"，而这个项目的价值是**通信**，不是文档编辑。
