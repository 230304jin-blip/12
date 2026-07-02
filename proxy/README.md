# Claude 反代 · 酒馆(SillyTavern)专用仪表盘

一个极简的 **Claude (Anthropic) 反向代理**：打开一个网址进入仪表盘，粘贴你自己的 Anthropic API Key，一键生成 **反代 URL + 反代密码**，直接填进 SillyTavern 即可使用 **Fable 5 等最新模型**。

零第三方依赖，单文件 Node 服务，另附 Docker 与 Cloudflare Worker 版本。

## 它是怎么工作的

- 你在仪表盘粘贴 **自己的** Anthropic API Key（来自 <https://console.anthropic.com>）。
- 服务器先向官方 `/v1/models` 校验这个 Key，通过后生成一个随机 **反代密码**（形如 `sk-tavern-xxxx`），保存在服务器本地 `keys.json`。
- 之后 SillyTavern 用这个 **反代密码** 访问本站，服务器再用你真实的 Key 转发到官方 API。这样密码可以随时更换/撤销，真实 Key 不外泄。

> 关于「authorize」：你问的“通过 Claude 官网 OAuth 授权、复用订阅额度”那种做法违反 Anthropic 条款，这里不做。改为你粘贴自己的 API Key 完成“授权”，效果对酒馆完全一样，且合规。

## 快速开始

```bash
cd proxy
node server.js
# 打开 http://localhost:8787  → 粘贴 API Key → 生成反代
```

## 在 SillyTavern 里填写

1. API 选 **Chat Completion**，来源选 **Claude**
2. 勾选 **使用反向代理 (Use Reverse Proxy)**
3. **反代 URL**：填仪表盘显示的地址（如 `https://your-host`）
4. **反代密码**：填仪表盘生成的 `sk-tavern-...`
5. 模型选 `claude-fable-5`（或点“连接”后在列表里选最新模型）
6. 点“连接”即可

> 服务器按 **路径后缀** 路由（`*/messages`、`*/chat/completions`、`*/models`），所以反代 URL 无论填成 `https://host` 还是 `https://host/v1` 都能正常工作。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` / `HOST` | 监听端口 / 地址 | `8787` / `0.0.0.0` |
| `ANTHROPIC_BASE_URL` | 上游地址 | `https://api.anthropic.com` |
| `ANTHROPIC_API_KEY` | 服务器预置上游密钥（可选） | 空 |
| `ACCESS_KEY` | 固定访问密钥，逗号分隔（可选，配合预置密钥用） | 空 |
| `ALLOW_REGISTER` | 是否允许仪表盘在线注册密码；公网可设 `false` | `true` |
| `STORE_PATH` | 密码存储文件路径 | `./keys.json` |
| `ANTHROPIC_VERSION` | 接口版本 | `2023-06-01` |
| `DEFAULT_MAX_TOKENS` | OpenAI 接口默认 max_tokens | `4096` |

## 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 仪表盘网页 |
| POST | `/api/register` | 用 API Key 换反代密码 `{ "apiKey": "sk-ant-..." }` |
| POST | `*/v1/messages` | 原生 Anthropic，透传 + 流式 |
| POST | `*/v1/chat/completions` | OpenAI 兼容，含流式 |
| GET | `*/v1/models` | 模型列表（实时/回退） |
| GET | `/healthz` | 健康检查 |

## Docker 部署

```bash
cd proxy
docker build -t claude-proxy .
docker run -d -p 8787:8787 -v $PWD/keys.json:/app/keys.json --name claude-proxy claude-proxy
```

## Cloudflare Worker 部署

`worker.js` 为纯 API 反代版（无仪表盘，用环境变量密钥）：

```bash
npx wrangler deploy worker.js --name claude-proxy
npx wrangler secret put ANTHROPIC_API_KEY
```

## 安全与合规

- 本服务只转发到官方 API，**不含也不生成任何 Anthropic 密钥**；请用你自己的合法密钥并遵守 Anthropic 使用条款。
- `keys.json` 内含真实密钥明文，已在 `.gitignore` 中排除；生产环境请置于 HTTPS 之后，`chmod 600`，必要时设 `ALLOW_REGISTER=false`。

## License

MIT
