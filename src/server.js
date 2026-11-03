// 零依赖 HTTP 服务：静态资源 + JSON API + SSE 流式转发。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, publicConfig, resolveRole, PRESETS } from './config.js';
import { Store, countWords } from './store.js';
import { streamChat, chatOnce, parseLooseJson } from './llm.js';
import {
  buildGhostMessages,
  buildPlanMessages,
  buildSparkMessages,
  buildWordMessages,
  buildWenlingTalkMessages,
  buildExtractMessages,
  buildPolishMessages,
  cleanGhost
} from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png'
};

export function createApp({ quiet = false } = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, url, pathname);
        return;
      }
      serveStatic(req, res, pathname);
    } catch (err) {
      if (!quiet) console.error('[flowwrite]', err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message || String(err) });
      else try { res.end(); } catch {}
    }
  };
}

export function startServer({ port = 4780, host = '127.0.0.1', quiet = false } = {}) {
  const handler = createApp({ quiet });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    let attempt = 0;
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 12) {
          attempt++;
          setTimeout(() => server.listen(port + attempt, host), 30);
        } else {
          throw err;
        }
      });
      server.listen(port + attempt, host, () => {
        const actual = server.address().port;
        resolve({ server, port: actual, url: `http://${host}:${actual}` });
      });
    };
    tryListen();
  });
}

// ---------- 静态 ----------
// 构建戳：app.js 的修改时间。任何一次改动都会让 ?v= 变掉，
// 浏览器下次打开就必然重新拉 JS，不会再出现"改了但页面还是旧的"。
function buildStamp() {
  try {
    const st = fs.statSync(path.join(PUBLIC_DIR, 'app.js'));
    return String(Math.round(st.mtimeMs));
  } catch {
    return String(Date.now());
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (path.extname(file).toLowerCase() === '.html') {
      const html = buf.toString('utf8').replace(/__BUILD__/g, buildStamp());
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- 工具 ----------
const STAGES = ['铺垫', '升级', '转折', '收束'];

// 模型给的节奏字段可能缺、可能是字符串数字、可能 stage 不在枚举里
function normalizePacing(p) {
  if (!p || typeof p !== 'object') return null;
  const t = Number(p.tension);
  return {
    stage: STAGES.includes(p.stage) ? p.stage : STAGES[0],
    tension: Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.4,
    change: String(p.change || '').slice(0, 80),
    pull: String(p.pull || '').slice(0, 80),
    note: String(p.note || '').slice(0, 90)
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function readJson(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 解析失败：' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  let closed = false;
  return {
    send(obj) {
      if (closed) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    done(extra = {}) {
      if (closed) return;
      this.send({ done: true, ...extra });
      res.write('data: [DONE]\n\n');
      res.end();
      closed = true;
    },
    fail(message) {
      if (closed) return;
      this.send({ error: message });
      res.write('data: [DONE]\n\n');
      res.end();
      closed = true;
    },
    get closed() { return closed; }
  };
}

// ---------- API ----------
async function handleApi(req, res, url, pathname) {
  const cfg = loadConfig();
  const store = new Store(cfg.root);
  const q = url.searchParams;

  if (pathname === '/api/state' && req.method === 'GET') {
    const slug = q.get('story') || store.ensureAtLeastOne();
    const meta = store.readMeta(slug);
    if (!meta) return sendJson(res, 404, { error: '故事不存在：' + slug });
    const text = store.readManuscript(slug);
    return sendJson(res, 200, {
      slug,
      story: meta,
      text,
      words: countWords(text),
      bible: store.readBible(slug),
      beats: store.readBeats(slug, 20),
      stories: store.list(),
      config: publicConfig(cfg),
      state: store.readState(slug)
    });
  }

  if (pathname === '/api/stories' && req.method === 'GET') {
    return sendJson(res, 200, { stories: store.list() });
  }

  if (pathname === '/api/stories' && req.method === 'POST') {
    const body = await readJson(req);
    const created = store.create(body.title || '未命名故事');
    return sendJson(res, 200, created);
  }

  if (pathname === '/api/story' && req.method === 'PUT') {
    const body = await readJson(req);
    const slug = body.slug;
    if (!store.exists(slug)) return sendJson(res, 404, { error: '故事不存在' });
    const meta = store.writeMeta(slug, { ...store.readMeta(slug), ...body.patch });
    return sendJson(res, 200, { story: meta });
  }

  if (pathname === '/api/manuscript' && req.method === 'PUT') {
    const body = await readJson(req);
    const slug = body.story;
    if (!store.exists(slug)) return sendJson(res, 404, { error: '故事不存在' });
    const prev = store.readManuscript(slug);
    const next = String(body.text ?? '');
    // 防呆：某个开着空编辑器的页面把 autosave 打过来，就会把有内容的稿子清成空。
    // 这种"清空"必须显式声明（force:true），否则拒收。
    if (!next.trim() && prev.trim() && !body.force) {
      return sendJson(res, 409, { error: '拒收空稿：原稿有内容。确认要清空请在请求里带 force:true' });
    }
    const res1 = store.writeManuscript(slug, next);
    // 每涨 400 字留一个快照
    if (countWords(next) - countWords(prev) >= 400) store.snapshot(slug, next);
    return sendJson(res, 200, { ok: true, ...res1 });
  }

  if (pathname === '/api/bible' && req.method === 'GET') {
    const slug = q.get('story');
    return sendJson(res, 200, { bible: store.readBible(slug) });
  }

  if (pathname === '/api/bible' && req.method === 'PUT') {
    const body = await readJson(req);
    if (!store.exists(body.story)) return sendJson(res, 404, { error: '故事不存在' });
    const bible = store.writeBible(body.story, body.bible || {});
    return sendJson(res, 200, { bible });
  }

  // ---- 幽灵字（SSE 流式） ----
  if (pathname === '/api/ghost' && req.method === 'POST') {
    const body = await readJson(req);
    const slug = body.story;
    if (!store.exists(slug)) return sendJson(res, 404, { error: '故事不存在' });
    const sse = startSse(res);
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(); });

    try {
      const role = resolveRole(cfg, 'writer');
      const messages = buildGhostMessages({
        meta: store.readMeta(slug),
        bible: store.readBible(slug),
        text: String(body.text ?? ''),
        intent: body.intent || '',
        sentences: cfg.trigger.ghostSentences,
        long: Boolean(body.long)
      });
      let acc = '';
      for await (const piece of streamChat(role, messages, { signal: ac.signal })) {
        acc += piece;
        sse.send({ t: piece });
      }
      // 推理档位偶尔会吃满 token 导致正文为空，翻倍预算补一次
      if (!acc.trim() && !ac.signal.aborted) {
        const retry = await chatOnce(role, messages, {
          temperature: role.temperature,
          maxTokens: Math.min(2400, (role.maxTokens || 700) * 2),
          signal: ac.signal
        });
        if (retry.trim()) {
          acc = retry;
          sse.send({ t: retry });
        }
      }
      const cleaned = cleanGhost(acc);
      sse.done({ clean: cleaned, chars: countWords(cleaned) });
    } catch (err) {
      if (err?.name === 'AbortError') { try { res.end(); } catch {} return; }
      sse.fail(err.message || String(err));
    }
    return;
  }

  // ---- 走向 + 节奏（一次调用） ----
  if (pathname === '/api/beats' && req.method === 'POST') {
    const body = await readJson(req);
    const slug = body.story;
    if (!store.exists(slug)) return sendJson(res, 404, { error: '故事不存在' });
    const role = resolveRole(cfg, 'planner');
    const text = String(body.text ?? store.readManuscript(slug));
    const recent = store.readBeats(slug, 12).map((b) => b.text).filter(Boolean);
    const messages = buildPlanMessages({
      meta: store.readMeta(slug),
      bible: store.readBible(slug),
      text,
      recentBeats: recent
    });
    let raw = await chatOnce(role, messages, { temperature: role.temperature ?? 0.9 });
    // 推理档位吃满 token 时正文会是空的，翻倍预算再试一次
    if (!raw.trim()) {
      raw = await chatOnce(role, messages, {
        temperature: role.temperature ?? 0.9,
        maxTokens: Math.min(4000, (role.maxTokens || 1400) * 2)
      });
    }
    const parsed = parseLooseJson(raw);
    let beats = null;
    let pacing = null;
    if (Array.isArray(parsed)) {
      beats = parsed;
    } else if (parsed && typeof parsed === 'object') {
      beats = parsed.beats || parsed.options || parsed.next || null;
      pacing = parsed.pacing || parsed.rhythm || null;
    }
    if (!Array.isArray(beats)) {
      beats = raw
        .split('\n')
        .map((l) => l.replace(/^[\s\-*\d.、:：]+/, '').trim())
        .filter((l) => l.length > 4 && l.length < 60)
        .slice(0, 3);
    }
    beats = beats
      .map((b) => (typeof b === 'string' ? b : b?.text || b?.beat || '').replace(/^["'「]|["'」]$/g, '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return sendJson(res, 200, { beats, pacing: normalizePacing(pacing) });
  }

  // ---- 灵感（火花） ----
  if (pathname === '/api/sparks' && req.method === 'POST') {
    const body = await readJson(req);
    const slug = body.story;
    if (!store.exists(slug)) return sendJson(res, 404, { error: '故事不存在' });
    const role = resolveRole(cfg, 'sparker');
    const text = String(body.text ?? store.readManuscript(slug));
    const messages = buildSparkMessages({
      meta: store.readMeta(slug),
      bible: store.readBible(slug),
      text
    });
    let raw = await chatOnce(role, messages, { temperature: role.temperature ?? 1 });
    if (!raw.trim()) {
      raw = await chatOnce(role, messages, {
        temperature: role.temperature ?? 1,
        maxTokens: Math.min(2000, (role.maxTokens || 700) * 2)
      });
    }
    let sparks = parseLooseJson(raw);
    if (sparks && !Array.isArray(sparks)) sparks = sparks.sparks || sparks.ideas || null;
    if (!Array.isArray(sparks)) {
      sparks = raw
        .split('\n')
        .map((l) => l.replace(/^[\s\-*\d.、:：]+/, '').trim())
        .filter((l) => l.length > 4 && l.length < 60)
        .slice(0, 3);
    }
    sparks = sparks
      .map((s) => (typeof s === 'string'
        ? { kind: '', text: s }
        : { kind: s?.kind || '', text: s?.text || s?.idea || '' }))
      .map((s) => ({
        kind: String(s.kind || '').slice(0, 8),
        text: String(s.text || '').replace(/^["'「]|["'」]$/g, '').trim()
      }))
      .filter((s) => s.text)
      .slice(0, 4);
    return sendJson(res, 200, { sparks });
  }

  // ---- 文灵：换个词 ----
  if (pathname === '/api/wenling/word' && req.method === 'POST') {
    const body = await readJson(req);
    const word = String(body.word || '').slice(0, 12).trim();
    if (!word) return sendJson(res, 200, { word: '' });
    const role = resolveRole(cfg, 'planner');
    const messages = buildWordMessages({ text: String(body.text || ''), word });
    let raw = '';
    try {
      raw = await chatOnce(role, messages, { temperature: 0.9, maxTokens: 200 });
      if (!String(raw || '').trim()) {
        raw = await chatOnce(role, messages, { temperature: 0.9, maxTokens: 320 });
      }
    } catch {
      raw = '';
    }
    const clean = (x) => String(x || '')
      .replace(/^["'「『\s]+|["'」』。，、\s]+$/g, '')
      .split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    let out = clean(raw);
    // 原样吐回来等于没换，再摇一次
    if (!out || out === word) {
      try {
        const again = clean(await chatOnce(role, messages, { temperature: 1.08, maxTokens: 320 }));
        if (again && again !== word) out = again;
      } catch {}
    }
    return sendJson(res, 200, { word: out.slice(0, 12) });
  }

  // ---- 文灵：陪他说句话（本地规则接不住的时候才走这里） ----
  if (pathname === '/api/wenling/talk' && req.method === 'POST') {
    const body = await readJson(req);
    const say = String(body.say || '').slice(0, 300);
    if (!say.trim()) return sendJson(res, 200, { line: '' });
    const role = resolveRole(cfg, 'planner');
    const messages = buildWenlingTalkMessages({ text: String(body.text || ''), say });
    // 90 tokens 会被截断（回出来是"沉思前"这种半句），空返回更糟，所以给够再重试一次
    let raw = '';
    try {
      raw = await chatOnce(role, messages, { temperature: 0.95, maxTokens: 260 });
      if (!String(raw || '').trim()) {
        raw = await chatOnce(role, messages, { temperature: 0.95, maxTokens: 420 });
      }
    } catch {
      raw = '';
    }
    const line = String(raw || '')
      .replace(/^["'「『\s]+|["'」』\s]+$/g, '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)[0] || '';
    return sendJson(res, 200, { line: line.slice(0, 80) });
  }

  // ---- 抽取档案 ----
  if (pathname === '/api/extract' && req.method === 'POST') {
    const body = await readJson(req);
    const slug = body.story;
    if (!store.exists(slug)) return sendJson(res, 404, { error: '故事不存在' });
    const role = resolveRole(cfg, 'archivist');
    const delta = String(body.delta ?? '');
    if (countWords(delta) < 60) return sendJson(res, 200, { bible: store.readBible(slug), added: 0 });
    const messages = buildExtractMessages({ bible: store.readBible(slug), delta });
    const raw = await chatOnce(role, messages, { temperature: 0.2, maxTokens: 1400 });
    const patch = parseLooseJson(raw);
    if (!patch || typeof patch !== 'object') return sendJson(res, 200, { bible: store.readBible(slug), added: 0 });
    const before = store.readBible(slug);
    const after = store.mergeBible(slug, patch);
    const added = ['characters', 'world', 'threads', 'foreshadow', 'timeline'].reduce(
      (n, k) => n + Math.max(0, (after[k]?.length || 0) - (before[k]?.length || 0)),
      0
    );
    return sendJson(res, 200, { bible: after, added });
  }

  // ---- 润色 ----
  if (pathname === '/api/polish' && req.method === 'POST') {
    const body = await readJson(req);
    const slug = body.story;
    if (!store.exists(slug)) return sendJson(res, 404, { error: '故事不存在' });
    const role = resolveRole(cfg, 'writer');
    const messages = buildPolishMessages({ text: String(body.text ?? ''), instruction: body.instruction });
    const out = await chatOnce(role, messages, { temperature: 0.5, maxTokens: 1200 });
    return sendJson(res, 200, { text: out.trim() });
  }

  // ---- 配置 ----
  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, publicConfig(cfg));
  }

  if (pathname === '/api/config' && req.method === 'PUT') {
    const patch = await readJson(req);
    const merged = { ...cfg };
    if (patch.root) merged.root = patch.root;
    if (patch.providers) {
      merged.providers = { ...cfg.providers };
      for (const [k, v] of Object.entries(patch.providers)) {
        merged.providers[k] = { ...(cfg.providers[k] || {}), ...v };
      }
    }
    if (patch.roles) {
      merged.roles = { ...cfg.roles };
      for (const [k, v] of Object.entries(patch.roles)) {
        merged.roles[k] = { ...(cfg.roles[k] || {}), ...v };
      }
    }
    if (patch.trigger) merged.trigger = { ...cfg.trigger, ...patch.trigger };
    if (patch.ui) merged.ui = { ...cfg.ui, ...patch.ui };
    if (patch.effects) merged.effects = { ...cfg.effects, ...patch.effects };
    saveConfig(merged);
    return sendJson(res, 200, publicConfig(loadConfig()));
  }

  if (pathname === '/api/config/test' && req.method === 'POST') {
    const body = await readJson(req);
    const roleName = body.role || 'writer';
    const t0 = Date.now();
    try {
      const role = resolveRole(cfg, roleName);
      const target = body.model ? { ...role, model: body.model } : role;
      const reply = await chatOnce(
        target,
        [
          { role: 'system', content: '你是一个连通性测试端点。只回两个字：可用。' },
          { role: 'user', content: '在吗' }
        ],
        { maxTokens: 16, temperature: 0 }
      );
      return sendJson(res, 200, { ok: true, ms: Date.now() - t0, reply: reply.trim().slice(0, 40), model: target.model });
    } catch (err) {
      return sendJson(res, 200, { ok: false, ms: Date.now() - t0, error: err.message });
    }
  }

  // ---- 记一笔走向（采用/放弃） ----
  if (pathname === '/api/beat' && req.method === 'POST') {
    const body = await readJson(req);
    if (!store.exists(body.story)) return sendJson(res, 404, { error: '故事不存在' });
    store.appendBeat(body.story, {
      at: new Date().toISOString(),
      action: body.action || 'adopt',
      text: String(body.text || '').slice(0, 200)
    });
    return sendJson(res, 200, { ok: true });
  }

  // ---- 导出 ----
  if (pathname === '/api/export' && req.method === 'GET') {
    const slug = q.get('story') || store.ensureAtLeastOne();
    const fmt = q.get('fmt') || 'md';
    const meta = store.readMeta(slug) || { title: slug };
    const text = store.readManuscript(slug);
    let out = text;
    let type = 'text/markdown; charset=utf-8';
    if (fmt === 'txt') {
      out = `${meta.title}\n${'='.repeat(Math.min(24, meta.title.length * 2))}\n\n${text}`;
      type = 'text/plain; charset=utf-8';
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.title)}.${fmt === 'txt' ? 'txt' : 'md'}"`
    });
    return res.end(out);
  }

  // 版本号：前端拿它判断自己是不是旧页面
  if (pathname === '/api/version' && req.method === 'GET') {
    return sendJson(res, 200, { build: buildStamp() });
  }

  if (pathname === '/api/presets' && req.method === 'GET') {
    return sendJson(res, 200, { presets: PRESETS });
  }

  return sendJson(res, 404, { error: '未知接口：' + pathname });
}
