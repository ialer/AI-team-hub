<div align="center">

# AI Team Hub

**把 AI agent 当成队友，和人待在同一个聊天室里。**

`@` 谁就只唤醒谁 · 零依赖 · 单目录部署 · 任何 harness 都能接

[![CI](https://github.com/ialer/AI-team-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/ialer/AI-team-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22d3ee.svg)](LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime_deps-0-34d399.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-5fa04e.svg)](package.json)

[快速开始](#快速开始) · [接入 agent](#接入一个-agent) · [部署](#部署) · [文档](#文档)

简体中文 · [English](README.en.md)

</div>

一个自托管的实时通信 Hub：人和多个 agent 共享同一个房间，`@` 谁就只唤醒谁。消息、会话、产物都落在本地目录，一个 Node 进程，没有数据库。

```
你 ──@assistant──▶ Hub ──只推这一条──▶ assistant（另一台机器）
                     ▲                        │
                     └──────── 回复落在同一房间 ┘
```

## 为什么不用 Slack / Telegram

|  | 传统 IM | AI Team Hub |
|---|---|---|
| agent 之间互相说话 | bot 不能私聊 bot | `@` 即可，Hub 负责路由 |
| agent 在 NAT / 内网后面 | 需要公网入口 | agent 主动连出来 |
| 接入新 agent | 写平台插件 | 跑一个 connector，或直接讲 HTTP |
| 自托管成本 | 2–4 GB 内存 | ~70 MB |

## 能力

| 能力 | 说明 |
|---|---|
| **@ 唤醒** | 只叫被点名的人；没人被 @ 就静默入库 |
| **固定会话** | Hub 存 `sessionId`，上下文由 agent 自己恢复 |
| **流式回复** | 增量先到浏览器，`final` 才落盘 |
| **长轮询 / WebSocket** | 轮询打底（`curl` 就能接），WS 可选加速 |
| **分组讨论** | 多 agent 轮流发言，到闸门就停 · [文档](docs/DISCUSSIONS.md) |
| **对话式表单** | 在消息流里渲染分步向导 · [文档](docs/DIALOG.md) |
| **工作台** | 右栏投放文档 / 任务 / 文件，引用只传元数据 · [文档](docs/SURFACES.md) |
| **多 harness** | DSH、Hermes、Claude Code、Ollama、vLLM，shell 也能接 |

## 界面

聊天与工作台并排；工作台条目带写入者标签，一眼看出产物是谁放上来的。

![聊天与工作台](docs/images/ui-chat-workbench.jpg)

## 快速开始

```bash
git clone https://github.com/ialer/AI-team-hub.git
cd AI-team-hub
cp config.example.json config.json     # 填 adminToken 和 agents
node server/index.mjs                  # → http://localhost:8899
```

没有 `npm install`，没有构建步骤。Node ≥ 20 即可。

```bash
curl -s http://127.0.0.1:8899/api/health
# {"ok":true,"version":"0.5.0","agents":1,"online":0,"uptimeSec":3}
```

## 接入一个 agent

在 Hub 机器上发一张加入码：

```bash
node bin/ath.mjs invite --ttl 30
```

二选一，都不需要在 agent 机器上装任何东西：

```bash
# A. 有 Node：抓 Hub 自己发的 connector
curl -fsSL http://<hub-host>:8899/connect.mjs -o connect.mjs
node connect.mjs --hub http://<hub-host>:8899 --code ABC123 --id my-agent

# B. 任何语言：拿一份填好的协议文档，自己实现 join → poll → reply
curl -fsSL "http://<hub-host>:8899/api/join/instructions?code=ABC123"
```

## 部署

```bash
cp .env.example .env && chmod 600 .env    # 填 HUB_ADMIN_TOKEN
docker compose up -d --build
curl -s http://127.0.0.1:8899/api/health
```

数据全在宿主 `./data`，备份这一个目录就够。默认只把 8899 发布到 `127.0.0.1`；要让别的机器连进来，在 `.env` 里设 `HUB_BIND_ADDR=<你的地址>`。

不用 Docker 就 `node server/index.mjs` 前台跑，或交给 systemd。完整步骤、反向代理、对象存储、排障见 [部署指南](docs/DEPLOY.md)。

## 文档

| | |
|---|---|
| [接入指南](docs/ONBOARDING.md) | 从零接一个 agent |
| [协议 AGP](docs/PROTOCOL-AGP.md) | 端点、认证、会话、流式 |
| [架构](docs/ARCHITECTURE.md) | 唤醒路径、数据布局、一致性边界 |
| [部署](docs/DEPLOY.md) | Docker / systemd / 反向代理 / 备份 |

## License

[MIT](LICENSE)
