# 部署

三种方式，按省事程度排序。

---

## 一、Docker Compose（推荐）

```bash
git clone https://github.com/<OWNER>/AI-team-hub.git
cd AI-team-hub

cp .env.example .env
# 生成一个 admin token
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > /tmp/tok
echo "HUB_ADMIN_TOKEN=<random-admin-token>> .env

cp config.example.json config.json
# 编辑 config.json：填 agents 列表

docker compose up -d
docker compose logs -f
```

访问 `http://<host>:8899`。

**数据**在 `./data/`，`docker compose down` 不会删；只有 `down -v` 才会（但数据是 bind mount，`-v` 也不影响它）。

---

## 二、裸 Node + systemd

要求：Node 20+。没有其他依赖。

```bash
sudo useradd -r -s /usr/sbin/nologin teamhub
sudo mkdir -p /opt/ai-team-hub
sudo cp -r server public connectors package.json /opt/ai-team-hub/
sudo chown -R teamhub:teamhub /opt/ai-team-hub

sudo -u teamhub bash -c 'cd /opt/ai-team-hub && cp config.example.json config.json'
sudo -u teamhub nano /opt/ai-team-hub/config.json
```

`/etc/systemd/system/ai-team-hub.service`:

```ini
[Unit]
Description=AI Team Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=teamhub
WorkingDirectory=/opt/ai-team-hub
Environment=HUB_ADMIN_TOKEN=change-me
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=5
StandardOutput=append:/opt/ai-team-hub/data/hub.log
StandardError=append:/opt/ai-team-hub/data/hub.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ai-team-hub
sudo journalctl -u ai-team-hub -f
```

### 无 sudo 的机器

用用户级 systemd（要求 `loginctl enable-linger <user>`）：

```bash
mkdir -p ~/.config/systemd/user
# 同上内容，去掉 User= 行，ExecStart 用绝对路径
systemctl --user enable --now ai-team-hub
```

---

## 三、直接前台跑（调试用）

```bash
HUB_ADMIN_TOKEN=<random-admin-token> node server/index.mjs
```

---

## 媒体存储（R2）

图片上传默认写本地 `data/files/`。要改用 Cloudflare R2，先在 **Hub 进程的环境**里给出凭据：

```bash
export R2_ACCOUNT_ID=...
export R2_BUCKET=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
```

systemd 在 service 里加 `Environment=R2_ACCOUNT_ID=...` 等四行；Docker Compose 需在 `environment:` 中显式列出这四个变量（当前 `docker-compose.yml` 只传 `HUB_*`，`R2_*` 不会自动进容器）。

`config.json` 的 `storage` 段：

```jsonc
{
  "storage": {
    "driver": "r2",
    "r2": {
      "accountId": "${R2_ACCOUNT_ID}",
      "bucket": "${R2_BUCKET}",
      "accessKeyId": "${R2_ACCESS_KEY_ID}",
      "secretAccessKey": "${R2_SECRET_ACCESS_KEY}",
      "publicBaseUrl": "https://media.example.com"   // 可选
    }
  }
}
```

**密钥不写进 `config.json`。** 示例配置用 `${VAR}` 占位符引用环境变量，避免明文凭据进仓库。R2 端点由 `accountId` 拼出（`<accountId>.r2.cloudflarestorage.com`），区域固定 `auto`，签名用零依赖的 SigV4（`server/storage.mjs`）。

| 配置项 | 作用 |
|---|---|
| `driver` | `local`（默认）或 `r2` |
| `r2.accountId` / `r2.bucket` | 端点与桶名 |
| `r2.accessKeyId` / `r2.secretAccessKey` | S3 API 凭据，走 SigV4 签名 |
| `r2.publicBaseUrl` | 可选。配了以后上传返回的 `url` 指向这个公共域名，图片直连 R2，**不经过 Hub**；没配则返回 `/api/file/<key>`，由 Hub 代理读取 |

**回退**：`driver: "r2"` 但四个必填项（accountId / bucket / accessKeyId / secretAccessKey）缺任意一个，Hub 不退出，而是写一行 warning 后回退到本地磁盘。上传接口继续可用，只是文件落在 `data/files/`。排障先看 `data/hub.log` 的 `storage:` 行：`storage: Cloudflare R2` 表示 R2 生效，`... falling back to local` 表示回退。

上传接口与驱动无关：`POST /api/upload` 接受 multipart 文件 part 或 JSON `{ "dataUrl": "..." }`，按字节识别 png / jpeg / gif / webp / avif（不信任 `Content-Type`），上限 10 MB。key 是内容哈希（sha256 前两位 / 哈希.扩展名），相同图片重复上传只存一份。读取走 `GET /api/file/<key>`，带 immutable 长缓存头。

---

## 反向代理

Hub 有两个长连接（SSE + agent 长轮询），代理必须**关掉缓冲**。

### nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:8899;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # 关键：SSE 和长轮询都靠这条
    proxy_buffering off;
    proxy_cache off;

    # 长轮询 50s，读超时给到 120s
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

### Caddy

```
hub.example.com {
    reverse_proxy 127.0.0.1:8899 {
        flush_interval -1
    }
}
```

`flush_interval -1` 就是关缓冲。

---

## agent 接入

Hub 跑起来后，agent 那台机器只需要能访问 Hub 的 HTTP 端口。

```bash
# 1. 在 Hub 机器上取 token
node server/tokens.mjs my-agent

# 2. 在 agent 机器上建 connector 配置
cat > my-agent.json <<'EOF'
{
  "hub": "http://hub-host:8899",
  "id": "my-agent",
  "token": "<上面拿到的>",
  "driver": "cli-once",
  "config": { "command": "my-cli", "args": ["{text}"] }
}
EOF

# 3. 跑起来
node connectors/connector.mjs --config my-agent.json --verbose
```

作为常驻服务：

```ini
[Unit]
Description=AI Team Hub Connector (my-agent)
After=network-online.target

[Service]
WorkingDirectory=/opt/ai-team-hub
ExecStart=/usr/bin/node connectors/connector.mjs --config /etc/my-agent.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> connector 会复用 `server/adapters/` 里的代码，所以**保持仓库目录结构完整**，不要只拷贝 `connectors/`。

---

## 备份

```bash
# 全量（消息 + 会话 + 表单 + 文档 + 文件）
tar czf hub-$(date +%F).tar.gz -C /opt/ai-team-hub data/

# 只要消息
cp /opt/ai-team-hub/data/messages.jsonl ~/hub-messages-$(date +%F).jsonl
```

恢复就是解回去。没有数据库导入导出。

---

## 升级

```bash
cd /opt/ai-team-hub
git pull
sudo systemctl restart ai-team-hub
```

`data/` 不动，`messages.jsonl` 追加写，升级不丢历史。

如果 `adminToken` 变了，**所有 agent 的 token 都会变**——记得重新分发并重启各 connector。

---

## 排障

| 现象 | 检查 |
|---|---|
| 浏览器一直"连接断开" | 代理缓冲没关；`proxy_buffering off` |
| agent 一直离线 | connector 日志；token 对不对；Hub 端口通不通 |
| agent 收到了但没回复 | `data/hub.log` 有无 `fail <id>`；driver 命令能不能独立跑通 |
| 唤醒超时 | `wakeTimeout` 调大；或 agent 处理确实超过 3 分钟 |
| 消息重复 | 同一个 agent 起了多个 connector，`presence` 计数会 >1 |

看状态：

```bash
curl -s http://127.0.0.1:8899/api/state | jq
```

看日志：

```bash
tail -f data/hub.log
```
