/**
 * Claude 反代 · Cloudflare Worker 版
 *
 * 部署:
 *   1. 新建 Worker, 粘贴本文件。
 *   2. 变量 (Settings → Variables):
 *        ANTHROPIC_API_KEY  (可选) 服务器持有的上游密钥
 *        ACCESS_KEY         (可选) 客户端访问密钥, 逗号分隔多个
 *        ANTHROPIC_BASE_URL (可选) 默认 https://api.anthropic.com
 *   3. 接口同 Node 版: /v1/messages, /v1/chat/completions, /v1/models
 *
 * 说明: Worker 版本仅提供 API 反代 (含流式), 不内置网页界面。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-access-key',
  'Access-Control-Max-Age': '86400',
};

const FALLBACK_MODELS = [
  'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
  'claude-opus-4-1-20250805', 'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022', 'claude-3-opus-20240229',
];

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
function errJson(status, message, type = 'invalid_request_error') {
  return json({ error: { type, message } }, status);
}

function clientKey(req) {
  const auth = req.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return (req.headers.get('x-api-key') || req.headers.get('x-access-key') || '').trim();
}

function authorize(req, env) {
  const accessKeys = (env.ACCESS_KEY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ck = clientKey(req);
  if (accessKeys.length) {
    if (!accessKeys.includes(ck)) return { ok: false };
    return { ok: true, upstreamKey: env.ANTHROPIC_API_KEY || ck };
  }
  const upstreamKey = env.ANTHROPIC_API_KEY || ck;
  if (!upstreamKey) return { ok: false, missingKey: true };
  return { ok: true, upstreamKey };
}

function upstreamHeaders(req, key, env) {
  const h = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': req.headers.get('anthropic-version') || env.ANTHROPIC_VERSION || '2023-06-01',
  };
  const beta = req.headers.get('anthropic-beta');
  if (beta) h['anthropic-beta'] = beta;
  return h;
}

function base(env) {
  return (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (p === '/healthz') return json({ status: 'ok', upstream: base(env) });

    if ((p === '/v1/models' || p === '/models') && req.method === 'GET') {
      const auth = authorize(req, env);
      let ids = null;
      if (auth.ok) {
        try {
          const r = await fetch(`${base(env)}/v1/models?limit=1000`, { headers: upstreamHeaders(req, auth.upstreamKey, env) });
          if (r.ok) { const d = await r.json(); if (Array.isArray(d.data)) ids = d.data.map((m) => m.id); }
        } catch {}
      }
      if (!ids) ids = FALLBACK_MODELS;
      return json({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'anthropic' })) });
    }

    if (p === '/v1/messages' && req.method === 'POST') {
      const auth = authorize(req, env);
      if (!auth.ok) return errJson(auth.missingKey ? 401 : 403, auth.missingKey ? '缺少 API 密钥' : '访问密钥无效', 'authentication_error');
      const upstream = await fetch(`${base(env)}/v1/messages`, {
        method: 'POST', headers: upstreamHeaders(req, auth.upstreamKey, env), body: req.body,
      });
      const h = new Headers(CORS);
      const ct = upstream.headers.get('content-type');
      if (ct) h.set('Content-Type', ct);
      return new Response(upstream.body, { status: upstream.status, headers: h });
    }

    if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') {
      const auth = authorize(req, env);
      if (!auth.ok) return errJson(auth.missingKey ? 401 : 403, auth.missingKey ? '缺少 API 密钥' : '访问密钥无效', 'authentication_error');
      let payload;
      try { payload = await req.json(); } catch (e) { return errJson(400, '请求体不是合法 JSON'); }
      const areq = openaiToAnthropic(payload, env);
      const upstream = await fetch(`${base(env)}/v1/messages`, {
        method: 'POST', headers: upstreamHeaders(req, auth.upstreamKey, env), body: JSON.stringify(areq),
      });
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        return errJson(upstream.status, `上游错误: ${t}`, 'api_error');
      }
      const model = payload.model || areq.model;
      if (payload.stream === true) {
        return new Response(anthropicStreamToOpenAI(upstream.body, model), {
          headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      }
      const data = await upstream.json();
      return json(anthropicToOpenAI(data, model));
    }

    return errJson(404, `未找到路由: ${req.method} ${p}`);
  },
};

function openaiToAnthropic(p, env) {
  const sys = [], messages = [];
  for (const m of p.messages || []) {
    if (m.role === 'system') { sys.push(typeof m.content === 'string' ? m.content : ''); continue; }
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  const out = {
    model: p.model,
    max_tokens: p.max_tokens || p.max_completion_tokens || parseInt(env.DEFAULT_MAX_TOKENS || '4096', 10),
    messages, stream: p.stream === true,
  };
  if (sys.length) out.system = sys.join('\n\n');
  if (typeof p.temperature === 'number') out.temperature = p.temperature;
  if (typeof p.top_p === 'number') out.top_p = p.top_p;
  if (Array.isArray(p.stop)) out.stop_sequences = p.stop;
  else if (typeof p.stop === 'string') out.stop_sequences = [p.stop];
  return out;
}

function mapStop(r) {
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop';
  if (r === 'max_tokens') return 'length';
  if (r === 'tool_use') return 'tool_calls';
  return r || 'stop';
}

function anthropicToOpenAI(data, model) {
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    id: data.id || 'chatcmpl-proxy', object: 'chat.completion', created: 0, model: data.model || model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: mapStop(data.stop_reason) }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

function anthropicStreamToOpenAI(upstreamBody, model) {
  const id = 'chatcmpl-proxy';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buffer = '';
  let finish = 'stop';
  const chunk = (delta, f) => enc.encode(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: 0, model,
    choices: [{ index: 0, delta, finish_reason: f ?? null }],
  })}\n\n`);

  return new ReadableStream({
    start(controller) { controller.enqueue(chunk({ role: 'assistant' }, null)); },
    async pull(controller) {
      const reader = upstreamBody.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
            const dataStr = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (!dataStr || dataStr === '[DONE]') continue;
            let evt; try { evt = JSON.parse(dataStr); } catch { continue; }
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') controller.enqueue(chunk({ content: evt.delta.text }, null));
            else if (evt.type === 'message_delta' && evt.delta?.stop_reason) finish = mapStop(evt.delta.stop_reason);
          }
        }
      } catch {}
      controller.enqueue(chunk({}, finish));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
