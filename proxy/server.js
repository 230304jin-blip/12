'use strict';

/**
 * Claude 反向代理服务 (Anthropic API reverse proxy) —— 酒馆(SillyTavern)友好版
 *
 * 使用流程:
 *   1. 打开首页仪表盘 (GET /)
 *   2. 粘贴你自己的 Anthropic API Key (来自 console.anthropic.com)
 *   3. 一键生成「反代 URL」+「反代密码」
 *   4. 把这两项填进 SillyTavern 的 Claude 反代设置即可, 支持 Fable 5 等最新模型
 *
 * 接口:
 *   - POST *​/v1/messages          原生 Anthropic (透传 + 流式)
 *   - POST *​/v1/chat/completions  OpenAI 兼容 (含流式转换)
 *   - GET  *​/v1/models            模型列表
 *   - POST /api/register          用 API Key 换取反代密码
 *   - GET  /healthz               健康检查
 *   - GET  /                      仪表盘网页
 *
 * 说明: 本服务只转发到官方 API, 使用你自己的合法密钥。它不包含、也不生成任何
 * Anthropic 密钥, 请遵守 Anthropic 使用条款。
 *
 * 零第三方依赖, 仅使用 Node 内置模块 (Node >= 18, 需要全局 fetch)。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// 配置 (全部通过环境变量)
// ---------------------------------------------------------------------------
const CONFIG = {
  port: parseInt(process.env.PORT || '8787', 10),
  host: process.env.HOST || '0.0.0.0',
  upstream: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  // 服务器可预置一个上游密钥 (可选)。仪表盘生成的密码优先。
  upstreamKey: process.env.ANTHROPIC_API_KEY || '',
  // 兼容旧用法: 固定访问密钥 (逗号分隔)。
  accessKeys: (process.env.ACCESS_KEY || '').split(',').map((s) => s.trim()).filter(Boolean),
  anthropicVersion: process.env.ANTHROPIC_VERSION || '2023-06-01',
  defaultMaxTokens: parseInt(process.env.DEFAULT_MAX_TOKENS || '4096', 10),
  // 是否允许仪表盘注册新的反代密码 (公网部署可设 false 后仅用环境变量密钥)。
  allowRegister: process.env.ALLOW_REGISTER !== 'false',
  storePath: process.env.STORE_PATH || path.join(__dirname, 'keys.json'),
};

const FALLBACK_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
];

// ---------------------------------------------------------------------------
// 反代密码 -> 上游密钥 存储 (本地 JSON 文件)
// 结构: { "<password>": { key, label, created } }
// ---------------------------------------------------------------------------
let STORE = {};
function loadStore() {
  try {
    STORE = JSON.parse(fs.readFileSync(CONFIG.storePath, 'utf8')) || {};
  } catch (_) {
    STORE = {};
  }
}
function saveStore() {
  try {
    fs.writeFileSync(CONFIG.storePath, JSON.stringify(STORE, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('无法写入 keys 存储:', e.message);
  }
}
loadStore();

// ---------------------------------------------------------------------------
// HTTP 小工具
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

function extractClientKey(req) {
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  if (req.headers['x-access-key']) return String(req.headers['x-access-key']).trim();
  return '';
}

// 决定这次请求应发往上游的真实密钥。
function authorize(req) {
  const clientKey = extractClientKey(req);

  // 1) 仪表盘生成的反代密码
  if (clientKey && STORE[clientKey]) {
    return { ok: true, upstreamKey: STORE[clientKey].key };
  }
  // 2) 环境变量固定访问密钥 -> 用服务器预置上游密钥
  if (CONFIG.accessKeys.length > 0) {
    if (CONFIG.accessKeys.includes(clientKey)) {
      const upstreamKey = CONFIG.upstreamKey || clientKey;
      if (upstreamKey) return { ok: true, upstreamKey };
    }
    return { ok: false };
  }
  // 3) 无任何配置: 用服务器预置密钥, 否则透传客户端自带的 key
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

function newPassword() {
  return 'sk-tavern-' + crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------------
// /api/register  —— 用 Anthropic API Key 换取反代密码
// ---------------------------------------------------------------------------
async function handleRegister(req, res) {
  if (!CONFIG.allowRegister) return errorJson(res, 403, '本服务未开放在线注册反代密码');

  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch (e) {
    return errorJson(res, 400, '请求体不是合法 JSON');
  }
  const apiKey = String(payload.apiKey || payload.key || '').trim();
  const label = String(payload.label || '').slice(0, 80);
  if (!apiKey) return errorJson(res, 400, '请提供 Anthropic API Key (apiKey 字段)');

  // 校验密钥: 调用上游 /v1/models
  let valid = false;
  let detail = '';
  try {
    const r = await fetch(`${CONFIG.upstream}/v1/models?limit=1`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': CONFIG.anthropicVersion,
      },
    });
    valid = r.ok;
    if (!r.ok) detail = `上游返回 ${r.status}`;
  } catch (e) {
    detail = `无法连接上游: ${e.message || e}`;
  }
  if (!valid) return errorJson(res, 401, `密钥校验失败: ${detail || '无效的 API Key'}`, 'authentication_error');

  // 若同一 key 已注册, 复用其密码 (幂等)。
  let password = Object.keys(STORE).find((p) => STORE[p].key === apiKey);
  if (!password) {
    password = newPassword();
    STORE[password] = { key: apiKey, label, created: new Date().toISOString() };
    saveStore();
  }

  sendJson(res, 200, { ok: true, password, note: '把此密码填入 SillyTavern 的「反代密码」, URL 填本站地址。' });
}

// ---------------------------------------------------------------------------
// /v1/models
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
    } catch (_) {}
  }
  if (!list) list = FALLBACK_MODELS;
  sendJson(res, 200, {
    object: 'list',
    data: list.map((id) => ({ id, object: 'model', created: 0, owned_by: 'anthropic' })),
  });
}

// ---------------------------------------------------------------------------
// /v1/messages  (原生 Anthropic, 透传 + 流式)
// ---------------------------------------------------------------------------
async function handleMessages(req, res) {
  const auth = authorize(req);
  if (!auth.ok) {
    return errorJson(
      res,
      auth.missingKey ? 401 : 403,
      auth.missingKey ? '缺少反代密码 / API 密钥' : '反代密码无效',
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

async function pipeUpstream(upstream, res) {
  const headers = { ...CORS_HEADERS };
  const ct = upstream.headers.get('content-type');
  if (ct) headers['Content-Type'] = ct;
  const reqId = upstream.headers.get('request-id');
  if (reqId) headers['request-id'] = reqId;
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (_) {
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// /v1/chat/completions  (OpenAI 兼容)
// ---------------------------------------------------------------------------
async function handleChatCompletions(req, res) {
  const auth = authorize(req);
  if (!auth.ok) {
    return errorJson(
      res,
      auth.missingKey ? 401 : 403,
      auth.missingKey ? '缺少反代密码 / API 密钥' : '反代密码无效',
      'authentication_error'
    );
  }
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
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
    let detail = '';
    try {
      detail = JSON.stringify(await upstream.json());
    } catch (_) {
      detail = await upstream.text().catch(() => '');
    }
    return errorJson(res, upstream.status, `上游返回错误: ${detail}`, 'api_error');
  }
  const model = payload.model || anthropicReq.model;
  if (stream) await streamAnthropicToOpenAI(upstream, res, model);
  else sendJson(res, 200, anthropicResponseToOpenAI(await upstream.json(), model));
}

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
  if (Array.isArray(content)) return content.map((x) => (typeof x === 'string' ? x : x.text || '')).join('');
  return '';
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') blocks.push({ type: 'text', text: part });
    else if (part.type === 'text') blocks.push({ type: 'text', text: part.text || '' });
    else if (part.type === 'image_url' && part.image_url) {
      const url = part.image_url.url || '';
      const m = /^data:(.+?);base64,(.*)$/s.exec(url);
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
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
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    id: data.id || 'chatcmpl-proxy',
    object: 'chat.completion',
    created: 0,
    model: data.model || model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: mapStopReason(data.stop_reason) }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

async function streamAnthropicToOpenAI(upstream, res, model) {
  res.writeHead(200, {
    ...CORS_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
  const baseChunk = (delta, finish) => ({
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });
  const writeChunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
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
        const dataStr = rawEvent
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!dataStr || dataStr === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(dataStr);
        } catch (_) {
          continue;
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') writeChunk(baseChunk({ content: evt.delta.text }, null));
        else if (evt.type === 'message_delta' && evt.delta?.stop_reason) finishReason = mapStopReason(evt.delta.stop_reason);
        else if (evt.type === 'error') writeChunk(baseChunk({ content: `\n[proxy error] ${JSON.stringify(evt.error)}` }, null));
      }
    }
  } catch (_) {
  } finally {
    writeChunk(baseChunk({}, finishReason));
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
function serveStatic(res, relPath) {
  const publicDir = path.join(__dirname, 'public');
  const filePath = path.join(publicDir, relPath === '/' ? 'index.html' : relPath);
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
// 主分发 (按路径后缀匹配, 兼容 SillyTavern 各种 base URL 写法)
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
        registered: Object.keys(STORE).length,
        allowRegister: CONFIG.allowRegister,
      });
    }
    if (pathname === '/api/register' && req.method === 'POST') return await handleRegister(req, res);

    // 后缀路由: 无论客户端把 base 设成 / 还是 /v1, 都能命中。
    if (req.method === 'POST' && /\/messages$/.test(pathname)) return await handleMessages(req, res);
    if (req.method === 'POST' && /\/chat\/completions$/.test(pathname)) return await handleChatCompletions(req, res);
    if (req.method === 'GET' && /\/models$/.test(pathname)) return await handleModels(req, res);

    if (req.method === 'GET') return serveStatic(res, url.pathname);
    return errorJson(res, 404, `未找到路由: ${req.method} ${pathname}`);
  } catch (e) {
    console.error('unhandled error:', e);
    if (!res.headersSent) errorJson(res, 500, `内部错误: ${e.message || e}`, 'api_error');
    else res.end();
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`\n  Claude 反代 (酒馆版) 已启动`);
  console.log(`  ├─ 仪表盘:    http://${CONFIG.host}:${CONFIG.port}/`);
  console.log(`  ├─ 上游:      ${CONFIG.upstream}`);
  console.log(`  ├─ 已注册密码: ${Object.keys(STORE).length}`);
  console.log(`  ├─ 在线注册:  ${CONFIG.allowRegister ? '开启' : '关闭'}`);
  console.log(`  ├─ 原生接口:  POST /v1/messages`);
  console.log(`  ├─ OpenAI接口: POST /v1/chat/completions`);
  console.log(`  └─ 模型列表:  GET  /v1/models\n`);
});
