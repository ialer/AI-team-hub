# Dialog — 对话式表单

agent 可以在回复里带一个结构化表单，在消息流里渲染成**分步向导**，不打断主对话。

---

## 为什么不是"来回聊天问参数"

| | 纯聊天 | Dialog |
|---|---|---|
| 4 个参数要问几轮 | 4 轮 | 1 张卡 |
| 中间忘了某个参数 | 得往上翻 | 卡里回看 |
| 必填校验 | 靠 agent 自己盯 | 前端拦住 |
| 填到一半切走 | 上下文丢了 | 状态在服务端，刷新还在 |
| 想改第 2 项 | 得重新说 | 「上一步」 |

---

## 数据模型

agent 发一条消息，除了 `text` 再带一个 `dialog`：

```jsonc
{
  "text": "需要你确认几个参数",
  "dialog": {
    "id": "dlg_7f3a",                    // 唯一；重复提交用它去重
    "title": "新节点部署",
    "steps": [
      { "id": "host",  "type": "text",     "label": "主机地址", "required": true,
        "placeholder": "192.168.1.7" },
      { "id": "port",  "type": "number",   "label": "SSH 端口", "default": 22 },
      { "id": "role",  "type": "select",   "label": "角色",
        "options": ["relay", "leaf"], "default": "leaf" },
      { "id": "note",  "type": "textarea", "label": "备注" },
      { "id": "ok",    "type": "checkbox", "label": "我已确认该机器可重启", "required": true }
    ],
    "submitLabel": "提交"                 // 可选
  }
}
```

### 字段类型

| `type` | 渲染 | 校验 |
|---|---|---|
| `text` | 单行输入 | `required` |
| `number` | 数字输入 | `required` + 非 NaN |
| `select` | 下拉（`options` 可以是字符串数组或 `{value,label}`） | `required` |
| `checkbox` | 勾选框 | `required` 表示必须勾上 |
| `textarea` | 多行输入 | `required` |

`options` 两种写法都行：

```jsonc
"options": ["relay", "leaf"]
"options": [{ "value": "relay", "label": "中继节点" }, { "value": "leaf", "label": "叶子节点" }]
```

---

## 交互

```
消息流
├── [人] @助手 帮我加个新节点
├── [助手] 需要你确认几个参数
│    ┌─────────────────────────────────┐
│    │ 新节点部署                1/4    │
│    │                                 │
│    │ 主机地址 *                       │
│    │ [192.168.1.7_______________]    │
│    │                                 │
│    │          [取消]  [下一步]        │
│    └─────────────────────────────────┘
└── （线程继续，可以往下滚看别的消息）
```

- **不阻断**：卡片在流里，不是 modal，往下滚照常看历史
- **逐项校验**：必填没填，点「下一步」会拦住并标红
- **可回退**：「上一步」保留已填的值
- **提交后折叠**：变成一行 `✅ 已提交`，展开可看答案
- **刷新不丢**：状态在 `data/dialogs.json`

---

## 提交回路

```
人点「提交」
  → POST /api/dialogs/:id/submit  { values: {...} }
  → Hub 把 values 存进 dialogs.json（status: submitted）
  → Hub 自动发一条新消息：
       @<原 agent> 表单「新节点部署」已提交
       · host: 192.168.1.7
       · port: 2222
       · role: relay
  → 该 agent 被唤醒，接着干活
```

取消同理：`POST /api/dialogs/:id/cancel`，Hub 发一条「表单已取消」的 mention。

**agent 不需要实现任何新接口**——表单结果就是一条普通消息，它按正常流程收到。

---

## 状态

| `status` | 含义 |
|---|---|
| `open` | 等人填 |
| `submitted` | 已提交，`values` 有值 |
| `cancelled` | 已取消 |

重复提交返回 `409`。

---

## 安全边界

> **Dialog 是 agent 提议、人来填，不能当作危险操作的唯一确认凭据。**

一个勾选框 `我已确认可重启` 不等于真获得了授权。破坏性动作仍然要走原有的审批机制（二次确认、审批流、人工复核）。表单只是**收集参数**更方便，不是**授权凭证**。

同理，前端渲染严格按白名单字段类型，不接受 agent 传任意 HTML。

---

## 实现要点（给改代码的人）

- 前端 `dialogCard()`（`public/app.js`）：纯 DOM 构建，无框架，逐步渲染
- 后端 `hub.submitDialog()` / `hub.cancelDialog()`（`server/hub.mjs`）
- 存储 `data/dialogs.json`，`JsonStore` 原子写
- 消息内嵌的 `dialog` 是**创建时的快照**；渲染时用 `state.dialogs[id]` 的最新状态覆盖，所以提交后卡片会更新
