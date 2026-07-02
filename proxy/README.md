# Claude 反代 · 全模型代理网站

一个反向代理 **Claude (Anthropic) 全系模型** 的网站 / API 网关。零第三方依赖，单文件 Node 服务，附带内置聊天网页界面，另有 Cloudflare Worker 部署版本。

## 特性

- **原生接口透传**：`POST /v1/messages`，与 Anthropic 官方完全一致，支持流式 SSE。
- **OpenAI 兼容接口**：`POST /v1/chat/completions`，可直接接入任何 OpenAI 客户端（NextChat、LobeChat、各类 SDK 等），自动完成请求/响应/流式格式转换。
- **模型列表**：`GET /v1/models`，优先从上游实时拉取全部可用模型，失败时回退到内置清单。
- **全部 Claude 模型**：不写死单一模型，客户端传什么 `model` 就转发什么（Opus / Sonnet / Haiku 各版本均可）。
- **密钥管理两种模式**：
  - 服务器持有上游密钥（`ANTHROPIC_API_KEY`），对外用自定义 `ACCESS_KEY` 授权；
  - 或不持密钥，纯转发客户端自带的 `x-api-key`。
- **内置网页聊天界面**：`GET /`，可选模型、System 提示词、温度、流式显示，设置存本地浏览器。
- **CORS 全开**，方便浏览器/前端直连。
- **多种部署**：`node server.js`、Docker、Cloudflare Worker。

## 快速开始（Node）

```bash
cd proxy
# 方式 A：服务器持有密钥，对外发访问码
ANTHROPIC_API_KEY=sk-ant-xxxx ACCESS_KEY=my-secret node server.js

# 方式 B：不持密钥，客户端自带 key
node server.js
```

打开 <http://localhost:8787> 即可使用网页界面。

### 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 监听端口 | `8787` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `ANTHROPIC_BASE_URL` | 上游地址 | `https://api.anthropic.com` |
| `ANTHROPIC_API_KEY` | 服务器持有的上游密钥（可选） | 空 |
| `ACCESS_KEY` | 客户端访问密钥，逗号分隔多个（可选） | 空 |
| `ANTHROPIC_VERSION` | Anthropic 接口版本 | `2023-06-01` |
| `DEFAULT_MAX_TOKENS` | OpenAI 接口默认 max_tokens | `4096` |

> 鉴权规则：配置了 `ACCESS_KEY` 时，客户端须在 `Authorization: Bearer <ACCESS_KEY>` 或 `x-api-key` 中携带访问码，通过后使用服务器的上游密钥。未配置 `ACCESS_KEY` 时，直接透传客户端自带的上游 key。

## 调用示例

原生 Anthropic：

```bash
curl http://localhost:8787/v1/messages \
  -H "x-api-key: <你的访问码或上游key>" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":1024,
       "messages":[{"role":"user","content":"你好"}]}'
```

OpenAI 兼容（流式）：

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <你的访问码或上游key>" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-8","stream":true,
       "messages":[{"role":"user","content":"你好"}]}'
```

接入 OpenAI 客户端时，把 **Base URL** 填 `http://your-host:8787/v1`，**API Key** 填访问码即可。

## Docker 部署

```bash
cd proxy
docker build -t claude-proxy .
docker run -d -p 8787:8787 \
  -e ANTHROPIC_API_KEY=sk-ant-xxxx \
  -e ACCESS_KEY=my-secret \
  --name claude-proxy claude-proxy
```

## Cloudflare Worker 部署

`worker.js` 为 Worker 版本（提供 API 反代与流式，不含网页界面）：

1. 新建 Worker，粘贴 `worker.js`；
2. 在 Variables 中配置 `ANTHROPIC_API_KEY` / `ACCESS_KEY`（可选）；
3. 接口路径与 Node 版一致。

用 wrangler：

```bash
npx wrangler deploy worker.js --name claude-proxy
npx wrangler secret put ANTHROPIC_API_KEY
```

## 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages` | 原生 Anthropic，透明透传 + 流式 |
| POST | `/v1/chat/completions` | OpenAI 兼容，含流式 |
| GET | `/v1/models` | 模型列表（实时/回退） |
| GET | `/healthz` | 健康检查 |
| GET | `/` | 网页聊天界面 |

## 说明与合规

- 本项目仅是 API 转发网关，**不含任何密钥**；请使用你自己的合法 Anthropic 密钥，并遵守 Anthropic 使用条款。
- 建议在生产环境开启 `ACCESS_KEY` 并置于 HTTPS 之后，避免上游密钥被滥用。

## License

MIT
