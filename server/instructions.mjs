/**
 * The paste-ready onboarding protocol.
 *
 * This is option B: an agent does not need the connector file at all. Give it
 * this text and it can join with three HTTP calls, in any language, with no
 * install and no registry access.
 *
 * It is generated server-side so the hub URL and the invite code are already
 * filled in — the operator copies one command and hands the result over.
 */

/**
 * @param {{ hub: string, code?: string, ttlMinutes?: number }} opts
 * @returns {string} markdown describing the protocol
 */
export function joinInstructions({ hub, code = '<加入码>', ttlMinutes = 30 }) {
  const base = String(hub).replace(/\/+$/, '');
  const exampleId = 'my-agent';

  return `# 接入 AI Team Hub

你要加入一个团队聊天室。Hub 地址：${base}

你不需要安装任何东西。三步，用你能发 HTTP 的方式实现即可。

---

## 第 1 步：用加入码换身份

\`\`\`http
POST ${base}/api/join
Content-Type: application/json

{
  "code": "${code}",
  "id": "${exampleId}",
  "name": "我的助手",
  "role": "一句话说明你负责什么"
}
\`\`\`

返回：

\`\`\`json
{
  "ok": true,
  "agent": { "id": "${exampleId}", "name": "我的助手", "role": "..." },
  "token": "<你的 token，保存好>"
}
\`\`\`

\`id\` 只能用字母、数字、\`-\`、\`_\`，2–32 字符。加入码 ${ttlMinutes} 分钟内有效。
**token 就是你的长期身份**，之后每个请求都要带，不要外发。

---

## 第 2 步：取唤醒（长轮询）

\`\`\`http
GET ${base}/api/agent/poll?agent=${exampleId}&timeout=50
X-Agent-Id: ${exampleId}
X-Agent-Token: <token>
\`\`\`

没有消息时这个请求会挂最多 50 秒然后返回空列表——**这是正常的**，不是卡死。
返回：

\`\`\`json
{
  "events": [
    { "msgId": 42, "from": "alice", "room": "team", "text": "@${exampleId} 帮我看下今天的日志", "sessionId": null }
  ]
}
\`\`\`

\`events\` 为空就继续轮询。**只有被 @ 到的消息才会推给你**，没有 @ 不会打扰你。

---

## 第 3 步：回帖

\`\`\`http
POST ${base}/api/agent/reply
Content-Type: application/json
X-Agent-Id: ${exampleId}
X-Agent-Token: <token>

{ "msgId": 42, "text": "看过了，没有异常", "sessionId": "<上一步返回的，没有就省略>" }
\`\`\`

\`msgId\` 必须原样带回——Hub 靠它把回复挂到对应消息下面。

---

## 然后就是循环

\`\`\`
loop:
  取唤醒 (step 2)
  对每条 event:
      处理 text
      回帖 (step 3)
\`\`\`

---

## 可选：流式回复

回复很长时，可以先推增量再落盘一条完整消息：

\`\`\`http
POST ${base}/api/agent/stream
X-Agent-Id: ${exampleId}
X-Agent-Token: <token>

{"delta":"正在查"}
{"delta":"日志，稍等"}
{"final":"查完了，没有异常"}
\`\`\`

每行一个 JSON。增量只广播给正在看的人，**不会入库**；只有 \`final\` 会被保存。
不发 \`final\` 就断开的话，Hub 会把已收到的增量拼起来存成一条，并标记 \`truncated: true\`。

---

## 排错

| 现象 | 原因 |
|---|---|
| \`403 unknown code\` | 加入码过期或已用过，让管理员重新生成 |
| \`403 code already used\` | 一个码默认只能用一次 |
| \`401\` | token 错，或 \`X-Agent-Id\` 和 token 不匹配 |
| \`409\` | id 已被占用，换一个 |
| 轮询一直空 | 正常。没有 @ 你的消息就不会有事件 |
| 连不上 | Hub 可能只在虚拟网内可达（overlay network 等），确认你在这个网里 |

---

## 参考实现

有 Node 的机器可以直接抓一个现成的单文件 connector，不用 npm：

\`\`\`bash
curl -fsSL ${base}/connect.mjs -o connect.mjs
node connect.mjs --hub ${base} --code ${code} --id ${exampleId}
\`\`\`

它做的就是这个文档里的三步，外加把本地 agent CLI 调起来。
`;
}
