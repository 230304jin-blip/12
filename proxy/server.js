'use strict';

/**
 * Claude 反向代理服务 (Anthropic API reverse proxy)
 *
 * 功能:
 *  - 透明反代原生 Anthropic 接口:  POST /v1/messages
 *  - 兼容 OpenAI 接口:             POST /v1/chat/completions
 *  - 列出全部 Claude 模型:         GET  /v1/models
 *  - 健康检查:                     GET  /healthz
 *  - 内置网页聊天界面:             GET  /
 *
 * 零第三方依赖, 仅使用 Node 内置模块 (Node >= 18, 需要全局 fetch)。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// 配置 (全部通过环境变量)
// ---------------------------------------------------------------------------
const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  host: process.env.HOST || '0.0.0.0',
  // 上游 Anthropic API 地址 (可指向其它兼容网关)
  upstream: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  // 服务器持有的上游密钥。设置后客户端无需再传 key。
  upstreamKey: process.env.ANTHROPIC_API_KEY || '',
  // 客户端访问本代理需要的密钥 (可选, 逗号分隔支持多个)。留空则不校验。
  accessKeys: (process.env.ACCESS_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  anthropicVersion: process.env.ANTHROPIC_VERSION || '2023-06-01',
  defaultMaxTokens: parseInt(process.env.DEFAULT_MAX_TOKENS || '4096', 10),
};

// 当无法访问上游 /v1/models 时使用的兜底模型清单。
const FALLBACK_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1-20250805',
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-access-key',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body, headers = {}) {
  const payload =
    typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS_HEADERS, ...headers });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8' });
}

function errorJson(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { type, message } });
}

function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 从客户端请求里解析出访问密钥 / 上游密钥。
function extractClientKey(req) {
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  if (req.headers['x-access-key']) return String(req.headers['x-access-key']).trim();
  return '';
}

// 校验访问权限。返回应发往上游的密钥, 或 null 表示拒绝。
function authorize(req) {
  const clientKey = extractClientKey(req);
  if (CONFIG.accessKeys.length > 0) {
    if (!CONFIG.accessKeys.includes(clientKey)) return { ok: false };
    // 通过校验后, 使用服务器自带的上游密钥 (若有), 否则回退到客户端 key。
    return { ok: true, upstreamKey: CONFIG.upstreamKey || clientKey };
  }
  // 未配置访问密钥: 优先用服务器上游密钥, 否则透传客户端 key。
  const upstreamKey = CONFIG.upstreamKey || clientKey;
  if (!upstreamKey) return { ok: false, missingKey: true };
  return { ok: true, upstreamKey };
}

function buildUpstreamHeaders(req, upstreamKey) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': upstreamKey,
    'anthropic-version': req.headers['anthropic-version'] || CONFIG.anthropicVersion,
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  return headers;
}

// ---------------------------------------------------------------------------
// 路由: /v1/models
// ---------------------------------------------------------------------------
async function handleModels(req, res) {
  const auth = authorize(req);
  let list = null;
  if (auth.ok) {
    try {
      const upstream = await fetch(`${CONFIG.upstream}/v1/models?limit=1000`, {
        headers: buildUpstreamHeaders(req, auth.upstreamKey),
      });
      if (upstream.ok) {
        const data = await upstream.json();
        if (Array.isArray(data.data)) list = data.data.map((m) => m.id);
      }
    } catch (_) {
      /* 忽略, 使用兜底清单 */
    }
  }
  if (!list) list = FALLBACK_MODELS;

  // 同时返回 OpenAI 与 Anthropic 风格, 方便各种客户端识别。
  sendJson(res, 200, {
    object: 'list',
    data: list.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'anthropic',
    })),
  });
}

// ---------------------------------------------------------------------------
// 路由: /v1/messages  (原生 Anthropic, 透明透传 + 流式)
// ---------------------------------------------------------------------------
async function handleMessages(req, res) {
  const auth = authorize(req);
  if (!auth.ok) {
    return errorJson(
      res,
      auth.missingKey ? 401 : 403,
      auth.missingKey ? '缺少 API 密钥 (x-api-key 或 Authorization)' : '访问密钥无效',
      'authentication_error'
    );
  }

  let bodyBuf;
  try {
    bodyBuf = await readBody(req);
  } catch (e) {
    return errorJson(res, 413, String(e.message || e));
  }

  let upstream;
  try {
    upstream = await fetch(`${CONFIG.upstream}/v1/messages`, {
      method: 'POST',
      headers: buildUpstreamHeaders(req, auth.upstreamKey),
      body: bodyBuf,
    });
  } catch (e) {
    return errorJson(res, 502, `上游请求失败: ${e.message || e}`, 'api_error');
  }

  await pipeUpstream(upstream, res);
}

// 把上游响应 (含 SSE 流) 透传给客户端。
async function pipeUpstream(upstream, res) {
  const headers = { ...CORS_HEADERS };
  const ct = upstream.headers.get('content-type');
  if (ct) headers['Content-Type'] = ct;
  const reqId = upstream.headers.get('request-id');
  if (reqId) headers['request-id'] = reqId;
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (_) {
    /* 客户端断开等 */
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// 路由: /v1/chat/completions  (OpenAI 兼容)
// ---------------------------------------------------------------------------
async function handleChatCompletions(req, res) {
  const auth = authorize(req);
  if (!auth.ok) {
    return errorJson(
      res,
      auth.missingKey ? 401 : 403,
      auth.missingKey ? '缺少 API 密钥' : '访问密钥无效',
      'authentication_error'
    );
  }

  let payload;
  try {
    const buf = await readBody(req);
    payload = JSON.parse(buf.toString('utf8') || '{}');
  } catch (e) {
    return errorJson(res, 400, `请求体不是合法 JSON: ${e.message || e}`);
  }

  const stream = payload.stream === true;
  const anthropicReq = openaiToAnthropic(payload);

  let upstream;
  try {
    upstream = await fetch(`${CONFIG.upstream}/v1/messages`, {
      method: 'POST',
      headers: buildUpstreamHeaders(req, auth.upstreamKey),
      body: JSON.stringify(anthropicReq),
    });
  } catch (e) {
    return errorJson(res, 502, `上游请求失败: ${e.message || e}`, 'api_error');
  }

  if (!upstream.ok) {
    // 把上游错误原样转成 OpenAI 风格。
    let detail = '';
    try {
      detail = JSON.stringify(await upstream.json());
    } catch (_) {
      detail = await upstream.text().catch(() => '');
    }
    return errorJson(res, upstream.status, `上游返回错误: ${detail}`, 'api_error');
  }

  const model = payload.model || anthropicReq.model;
  if (stream) {
    await streamAnthropicToOpenAI(upstream, res, model);
  } else {
    const data = await upstream.json();
    sendJson(res, 200, anthropicResponseToOpenAI(data, model));
  }
}

// 将 OpenAI chat 请求转换为 Anthropic messages 请求。
function openaiToAnthropic(p) {
  const systemParts = [];
  const messages = [];
  for (const m of p.messages || []) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : stringifyContent(m.content));
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: normalizeContent(m.content) });
  }

  const out = {
    model: p.model,
    max_tokens: p.max_tokens || p.max_completion_tokens || CONFIG.defaultMaxTokens,
    messages,
    stream: p.stream === true,
  };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (typeof p.temperature === 'number') out.temperature = p.temperature;
  if (typeof p.top_p === 'number') out.top_p = p.top_p;
  if (Array.isArray(p.stop)) out.stop_sequences = p.stop;
  else if (typeof p.stop === 'string') out.stop_sequences = [p.stop];
  return out;
}

function stringifyContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part.text || ''))
      .join('');
  }
  return '';
}

// OpenAI content 可能是字符串或多模态数组, 归一化为 Anthropic content。
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
    } else if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text || '' });
    } else if (part.type === 'image_url' && part.image_url) {
      const url = part.image_url.url || '';
      const m = /^data:(.+?);base64,(.*)$/s.exec(url);
      if (m) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] },
        });
      } else if (url) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }
  return blocks.length ? blocks : '';
}

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason || 'stop';
  }
}

function anthropicResponseToOpenAI(data, model) {
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    id: data.id || 'chatcmpl-proxy',
    object: 'chat.completion',
    created: 0,
    model: data.model || model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapStopReason(data.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

// 读取 Anthropic 的 SSE 流, 转换为 OpenAI chat.completion.chunk 流。
async function streamAnthropicToOpenAI(upstream, res, model) {
  res.writeHead(200, {
    ...CORS_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const id = 'chatcmpl-' + Math.abs(hashString(model + upstream.url)).toString(36);
  const created = 0;
  const baseChunk = (delta, finish) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });

  const writeChunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // 首个 chunk 声明角色。
  writeChunk(baseChunk({ role: 'assistant' }, null));

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = 'stop';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        const dataStr = dataLines.join('\n');
        if (dataStr === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(dataStr);
        } catch (_) {
          continue;
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          writeChunk(baseChunk({ content: evt.delta.text }, null));
        } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          finishReason = mapStopReason(evt.delta.stop_reason);
        } else if (evt.type === 'error') {
          writeChunk(baseChunk({ content: `\n[proxy error] ${JSON.stringify(evt.error)}` }, null));
        }
      }
    }
  } catch (_) {
    /* 上游/客户端中断 */
  } finally {
    writeChunk(baseChunk({}, finishReason));
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------
// 静态文件 (网页界面)
// ---------------------------------------------------------------------------
function serveStatic(res, relPath) {
  const publicDir = path.join(__dirname, 'public');
  const filePath = path.join(publicDir, relPath === '/' ? 'index.html' : relPath);
  // 防目录穿越
  if (!filePath.startsWith(publicDir)) return errorJson(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return errorJson(res, 404, 'not found');
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    send(res, 200, data, { 'Content-Type': types[ext] || 'application/octet-stream' });
  });
}

// ---------------------------------------------------------------------------
// 主分发
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return send(res, 204, '', {});

  try {
    if (pathname === '/healthz') {
      return sendJson(res, 200, {
        status: 'ok',
        upstream: CONFIG.upstream,
        hasServerKey: Boolean(CONFIG.upstreamKey),
        accessKeyRequired: CONFIG.accessKeys.length > 0,
      });
    }

    if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
      return await handleModels(req, res);
    }
    if (pathname === '/v1/messages' && req.method === 'POST') {
      return await handleMessages(req, res);
    }
    if (
      (pathname === '/v1/chat/completions' || pathname === '/chat/completions') &&
      req.method === 'POST'
    ) {
      return await handleChatCompletions(req, res);
    }

    // 其余走静态资源 (GET)。
    if (req.method === 'GET') return serveStatic(res, url.pathname);

    return errorJson(res, 404, `未找到路由: ${req.method} ${pathname}`);
  } catch (e) {
    console.error('unhandled error:', e);
    if (!res.headersSent) errorJson(res, 500, `内部错误: ${e.message || e}`, 'api_error');
    else res.end();
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`\n  Claude 反代服务已启动`);
  console.log(`  ├─ 监听:        http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  ├─ 上游:        ${CONFIG.upstream}`);
  console.log(`  ├─ 服务器密钥:  ${CONFIG.upstreamKey ? '已配置' : '未配置 (需客户端自带)'}`);
  console.log(`  ├─ 访问校验:    ${CONFIG.accessKeys.length ? '开启' : '关闭'}`);
  console.log(`  ├─ 原生接口:    POST /v1/messages`);
  console.log(`  ├─ OpenAI接口:  POST /v1/chat/completions`);
  console.log(`  ├─ 模型列表:    GET  /v1/models`);
  console.log(`  └─ 网页界面:    GET  /\n`);
});
