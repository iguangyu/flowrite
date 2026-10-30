// OpenAI 兼容的流式客户端。零依赖，用 Node 内置 fetch。
// DeepSeek / GLM / 各种中转 都走同一套协议。

export async function* streamChat(cfg, messages, opts = {}) {
  const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: opts.temperature ?? cfg.temperature ?? 0.9,
    max_tokens: opts.maxTokens ?? cfg.maxTokens ?? 600
  };
  if (opts.stop) body.stop = opts.stop;
  const effort = opts.effort ?? cfg.effort;
  if (effort) body.reasoning_effort = effort;

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
    throw new Error(`连不上 ${url}：${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmError(res.status, explainStatus(res.status, text));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      throw err;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const delta = obj?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
      if (obj?.error) throw new Error(obj.error.message || JSON.stringify(obj.error));
    }
  }
}

export async function chatOnce(cfg, messages, opts = {}) {
  let out = '';
  for await (const piece of streamChat(cfg, messages, opts)) out += piece;
  return out;
}

export class LlmError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function explainStatus(status, text) {
  const head = (text || '').slice(0, 300);
  if (status === 401) return `API Key 无效或已过期（401）。${head}`;
  if (status === 402) return `账户余额不足（402）。${head}`;
  if (status === 403) return `被拒绝访问（403），可能是区域限制或 Key 权限不足。${head}`;
  if (status === 404) return `接口地址不存在（404），检查 baseURL 是否少了 /v1 或多了一层。${head}`;
  if (status === 429) return `触发限流（429），稍等一下再写。${head}`;
  if (status >= 500) return `服务端错误（${status}），模型那边的问题，重试通常就好。${head}`;
  return `请求失败（${status}）。${head}`;
}

// 从模型输出里捞一个 JSON 数组/对象，容忍 ```json 包裹和前后废话
export function parseLooseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const tryParse = (t) => {
    try { return JSON.parse(t); } catch { return undefined; }
  };

  const direct = tryParse(s);
  if (direct !== undefined) return direct;

  const firstBracket = s.search(/[[{]/);
  if (firstBracket < 0) return null;
  const openCh = s[firstBracket];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = firstBracket; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(firstBracket, i + 1);
        const parsed = tryParse(candidate);
        if (parsed !== undefined) return parsed;
        return null;
      }
    }
  }
  return null;
}
