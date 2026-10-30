// 故事存储：一个故事 = 一个目录，纯文本，可 git 版本化。
// story.json / manuscript.md / bible.json / beats.jsonl / .flowwrite/
import fs from 'node:fs';
import path from 'node:path';

const EMPTY_BIBLE = () => ({
  characters: [],
  world: [],
  threads: [],
  foreshadow: [],
  timeline: [],
  updatedAt: null
});

function safeName(title) {
  const base = String(title || '未命名故事')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return base || '未命名故事';
}

export class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  dir(slug) {
    return path.join(this.root, slug);
  }

  list() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const meta = this.readMeta(e.name);
        const text = this.readManuscript(e.name);
        return {
          slug: e.name,
          title: meta?.title || e.name,
          words: countWords(text),
          updatedAt: meta?.updatedAt || null
        };
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  create(title) {
    const name = safeName(title);
    let slug = name;
    let i = 2;
    while (fs.existsSync(this.dir(slug))) {
      slug = `${name}-${i++}`;
    }
    const d = this.dir(slug);
    fs.mkdirSync(path.join(d, '.flowwrite', 'snapshots'), { recursive: true });
    const now = new Date().toISOString();
    const meta = {
      title: name,
      logline: '',
      genre: '短剧',
      targetLength: '1-3 万字',
      styleSample: '',
      createdAt: now,
      updatedAt: now
    };
    this.writeMeta(slug, meta);
    fs.writeFileSync(path.join(d, 'manuscript.md'), '', 'utf8');
    fs.writeFileSync(path.join(d, 'bible.json'), JSON.stringify(EMPTY_BIBLE(), null, 2), 'utf8');
    fs.writeFileSync(path.join(d, 'beats.jsonl'), '', 'utf8');
    return { slug, meta };
  }

  ensureAtLeastOne() {
    const list = this.list();
    if (list.length) return list[0].slug;
    return this.create('未命名故事').slug;
  }

  exists(slug) {
    return Boolean(slug) && fs.existsSync(this.dir(slug));
  }

  readMeta(slug) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(slug), 'story.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  writeMeta(slug, meta) {
    const d = this.dir(slug);
    fs.mkdirSync(d, { recursive: true });
    const merged = { ...meta, updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(d, 'story.json'), JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  readManuscript(slug) {
    try {
      return fs.readFileSync(path.join(this.dir(slug), 'manuscript.md'), 'utf8');
    } catch {
      return '';
    }
  }

  writeManuscript(slug, text) {
    const d = this.dir(slug);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manuscript.md'), text, 'utf8');
    const meta = this.readMeta(slug) || { title: slug };
    this.writeMeta(slug, { ...meta, words: countWords(text) });
    return { words: countWords(text) };
  }

  readBible(slug) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(this.dir(slug), 'bible.json'), 'utf8'));
      return { ...EMPTY_BIBLE(), ...b };
    } catch {
      return EMPTY_BIBLE();
    }
  }

  writeBible(slug, bible) {
    const d = this.dir(slug);
    fs.mkdirSync(d, { recursive: true });
    const next = { ...EMPTY_BIBLE(), ...bible, updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(d, 'bible.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  // 只新增不覆盖：AI 抽取走这里
  mergeBible(slug, patch) {
    const cur = this.readBible(slug);
    const out = { ...cur };
    for (const key of ['characters', 'world', 'threads', 'foreshadow', 'timeline']) {
      const incoming = Array.isArray(patch?.[key]) ? patch[key] : [];
      if (!incoming.length) continue;
      const existing = Array.isArray(cur[key]) ? [...cur[key]] : [];
      const lockedNames = new Set(existing.filter((x) => x && x.locked).map((x) => keyOf(key, x)));
      const seen = new Set(existing.map((x) => keyOf(key, x)));
      for (const item of incoming) {
        if (!item) continue;
        const k = keyOf(key, item);
        if (!k || seen.has(k) || lockedNames.has(k)) continue;
        existing.push({ ...item, addedBy: 'ai', at: new Date().toISOString() });
        seen.add(k);
      }
      out[key] = existing;
    }
    return this.writeBible(slug, out);
  }

  appendBeat(slug, record) {
    const d = this.dir(slug);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'beats.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  }

  readBeats(slug, limit = 40) {
    try {
      const raw = fs.readFileSync(path.join(this.dir(slug), 'beats.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  readState(slug) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(slug), '.flowwrite', 'state.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  writeState(slug, patch) {
    const d = path.join(this.dir(slug), '.flowwrite');
    fs.mkdirSync(d, { recursive: true });
    const cur = this.readState(slug);
    const next = { ...cur, ...patch };
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  snapshot(slug, text) {
    const d = path.join(this.dir(slug), '.flowwrite', 'snapshots');
    fs.mkdirSync(d, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(d, `${stamp}.md`), text, 'utf8');
    const files = fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort();
    while (files.length > 50) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(d, old)); } catch {}
    }
  }
}

function keyOf(kind, item) {
  if (!item) return '';
  if (kind === 'characters') return String(item.name || '').trim();
  if (kind === 'world') return String(item.name || '').trim();
  if (kind === 'threads') return String(item.name || item.id || '').trim();
  if (kind === 'foreshadow') return String(item.note || item.id || '').trim().slice(0, 24);
  if (kind === 'timeline') return `${item.when || ''}|${item.what || ''}`.trim();
  return JSON.stringify(item).slice(0, 32);
}

// 中文字符数，不含标点与空白
export function countWords(text) {
  if (!text) return 0;
  const m = String(text).match(/[\u4e00-\u9fa5\u3040-\u30ffA-Za-z0-9]/g);
  return m ? m.length : 0;
}
