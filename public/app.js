/* FlowWrite 前端。
   一句话原则：AI 永远不自动改动人写的字，它只在后面给出「淡灰色的下一句」和「三条路」。 */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = {
    app: $('#app'),
    paper: $('#paper'),
    editor: $('#editor'),
    title: $('#storyTitle'),
    topMeta: $('#topMeta'),
    beats: $('#beats'),
    beatsEmpty: $('#beatsEmpty'),
    beatCount: $('#beatCount'),
    alts: $('#alts'),
    altsEmpty: $('#altsEmpty'),
    altCount: $('#altCount'),
    intent: $('#intent'),
    intentText: $('#intentText'),
    ghostHint: $('#ghostHint'),
    statStatus: $('#statStatus'),
    statWords: $('#statWords'),
    statLatency: $('#statLatency'),
    statModel: $('#statModel'),
    overlay: $('#overlay'),
    sheetTitle: $('#sheetTitle'),
    sheetBody: $('#sheetBody'),
    toast: $('#toast'),
    rail: $('#rail'),
    workspace: $('.workspace')
  };

  const S = {
    slug: '',
    story: {},
    text: '',
    bible: { characters: [], world: [], threads: [], foreshadow: [], timeline: [] },
    beats: [],
    alts: [],
    config: null,
    muted: false,
    intent: '',
    intentSpent: false,
    ghostText: '',
    ghostBusy: false,
    ghostAbort: null,
    beatsBusy: false,
    bibleBusy: false,
    wordsAtGhost: 0,
    wordsAtBeats: 0,
    wordsAtBible: 0,
    extractOffset: 0,
    saveTimer: 0,
    ghostTimer: 0,
    bgTimer: 0,
    statusTimer: 0
  };

  const GLYPHS = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感';

  /* ---------------- 工具 ---------------- */
  const countWords = (t) => {
    const m = String(t || '').match(/[\u4e00-\u9fa5\u3040-\u30ffA-Za-z0-9]/g);
    return m ? m.length : 0;
  };

  function toast(msg, kind) {
    if (!msg) return;
    el.toast.textContent = msg;
    el.toast.className = 'toast is-on' + (kind === 'err' ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.className = 'toast' + (kind === 'err' ? ' err' : '');
    }, kind === 'err' ? 5200 : 2400);
  }

  function setStatus(txt, hold) {
    el.statStatus.textContent = txt;
    clearTimeout(S.statusTimer);
    if (hold) {
      S.statusTimer = setTimeout(() => (el.statStatus.textContent = '就绪'), hold);
    }
  }

  // 走向文字的解码动效：用 baffle.js 逐字还原。
  // baffle 每 tick 还原 ceil(len / (duration/speed)) 个字，要让效果看得见，
  // 就得让每一步只还原一个字 —— 于是把 speed 反算成 1600/len，总时长固定在 1.6s。
  function decodeInto(node, finalText, ms = 1600) {
    node.textContent = finalText;
    if (reduced) return;
    if (window.baffle) {
      try {
        const len = Math.max(1, finalText.length);
        const speed = Math.max(16, Math.min(60, Math.round(ms / len)));
        window.baffle(node, { characters: GLYPHS, speed }).reveal(ms);
        return;
      } catch {
        node.textContent = finalText;
      }
    }
    fallbackScramble(node, finalText, ms);
  }

  function fallbackScramble(node, finalText, ms) {
    const start = performance.now();
    const len = finalText.length;
    function tick(now) {
      const p = Math.min(1, (now - start) / ms);
      const shown = Math.floor(p * len);
      let out = finalText.slice(0, shown);
      for (let i = shown; i < len; i++) {
        const ch = finalText[i];
        if (/\s/.test(ch)) out += ch;
        else out += GLYPHS[(i * 17 + Math.floor(now / 40) * 7) % GLYPHS.length];
      }
      node.textContent = out;
      if (p < 1) requestAnimationFrame(tick);
      else node.textContent = finalText;
    }
    requestAnimationFrame(tick);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
  }

  /* ---------------- 编辑器 ---------------- */
  function rawText() {
    const clone = el.editor.cloneNode(true);
    clone.querySelectorAll('.ghost,.ghost-thinking').forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return clone.textContent || '';
  }

  function setText(t) {
    removeGhost();
    el.editor.textContent = t || '';
    S.text = rawText();
  }

  function removeGhost() {
    el.editor.querySelectorAll('.ghost,.ghost-thinking').forEach((n) => n.remove());
    S.ghostText = '';
    updateGhostUI();
  }

  function showThinking() {
    if (el.editor.querySelector('.ghost-thinking')) return;
    const s = document.createElement('span');
    s.className = 'ghost-thinking';
    s.contentEditable = 'false';
    const caret = document.createElement('i');
    caret.className = 'think-caret';
    const label = document.createElement('span');
    label.className = 'think-text';
    label.textContent = '在接你的下一句';
    s.append(caret, label);
    el.editor.appendChild(s);
    scheduleEnsure(s);
  }

  function showGhost(text) {
    el.editor.querySelectorAll('.ghost-thinking').forEach((n) => n.remove());
    let span = el.editor.querySelector('.ghost');
    if (!span) {
      span = document.createElement('span');
      span.className = 'ghost';
      span.contentEditable = 'false';
      el.editor.appendChild(span);
    }
    span.textContent = text;
    S.ghostText = text;
    updateGhostUI();
    if (text) scheduleEnsure(span);
  }

  let visRaf = 0;
  function scheduleEnsure(node) {
    if (visRaf) return;
    visRaf = requestAnimationFrame(() => {
      visRaf = 0;
      ensureVisible(node);
    });
  }

  // 让某个节点进入纸面的可视范围（body 不滚动，所以不能靠 scrollIntoView）
  function ensureVisible(node) {
    if (!node || !el.paper) return;
    const r = node.getBoundingClientRect();
    const p = el.paper.getBoundingClientRect();
    const margin = Math.min(180, p.height * 0.3);
    if (r.bottom > p.bottom - margin) {
      el.paper.scrollTop += r.bottom - (p.bottom - margin);
    } else if (r.top < p.top + 40) {
      el.paper.scrollTop -= p.top + 40 - r.top;
    }
  }

  function updateGhostUI() {
    el.ghostHint.hidden = !S.ghostText;
  }

  function caretAtEnd() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!el.editor.contains(range.endContainer) && range.endContainer !== el.editor) return false;
    const probe = document.createRange();
    probe.selectNodeContents(el.editor);
    probe.setStart(range.endContainer, range.endOffset);
    const frag = probe.cloneContents();
    frag.querySelectorAll?.('.ghost,.ghost-thinking').forEach((n) => n.remove());
    return frag.textContent.replace(/\u200b/g, '').trim() === '';
  }

  function placeCaretEnd() {
    const r = document.createRange();
    r.selectNodeContents(el.editor);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function insertAtEnd(t) {
    el.editor.appendChild(document.createTextNode(t));
    placeCaretEnd();
  }

  function firstSentence(t) {
    const m = t.match(/^[\s\S]*?[。！？…\n]/);
    return m ? m[0] : t;
  }

  /* ---------------- 存档 ---------------- */
  function queueSave() {
    clearTimeout(S.saveTimer);
    setStatus('写了 ' + countWords(S.text) + ' 字 · 保存中…');
    S.saveTimer = setTimeout(doSave, 800);
  }

  async function doSave() {
    if (!S.slug) return;
    try {
      await api('/api/manuscript', {
        method: 'PUT',
        body: JSON.stringify({ story: S.slug, text: S.text })
      });
      setStatus('已保存', 1600);
    } catch (e) {
      setStatus('保存失败：' + e.message, 4000);
    }
  }

  function onTextChanged() {
    S.text = rawText();
    updateCounts();
    updateBeatsStale();
    queueSave();
    clearTimeout(S.ghostTimer);
    S.ghostTimer = setTimeout(maybeGhost, S.config?.trigger?.idleMs ?? 1200);
    clearTimeout(S.bgTimer);
    S.bgTimer = setTimeout(maybeBackground, 2600);
  }

  function updateCounts() {
    const w = countWords(S.text);
    el.statWords.textContent = w + ' 字';
    el.topMeta.textContent = w + ' 字';
  }

  /* ---------------- 幽灵字 ---------------- */
  function maybeGhost() {
    if (S.muted || S.ghostBusy) return;
    if (!caretAtEnd()) return;
    if (countWords(S.text) - S.wordsAtGhost < (S.config?.trigger?.minCharsForGhost ?? 6)) return;
    if (countWords(S.text) < 3) return;
    requestGhost();
  }

  async function requestGhost(opts = {}) {
    if (S.muted && !opts.force) return;
    if (S.ghostBusy && !opts.force) return;
    const text = rawText();
    if (countWords(text) < 2) {
      toast('先写半句，它才接得上。');
      return;
    }
    cancelGhost();
    S.ghostBusy = true;
    const ac = new AbortController();
    if (S.intent) S.intentSpent = true;
    S.ghostAbort = ac;
    showThinking();
    setStatus('在想下一句…');
    const t0 = performance.now();
    let acc = '';
    let firstAt = 0;

    try {
      const res = await fetch('/api/ghost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story: S.slug,
          text,
          intent: S.intent,
          long: Boolean(opts.long)
        }),
        signal: ac.signal
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || '请求失败 ' + res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let obj;
            try { obj = JSON.parse(payload); } catch { continue; }
            if (obj.error) throw new Error(obj.error);
            if (obj.t) {
              if (!firstAt) {
                firstAt = performance.now();
                el.statLatency.textContent = '首字 ' + ((firstAt - t0) / 1000).toFixed(1) + 's';
              }
              acc += obj.t;
              showGhost(acc);
            }
            if (obj.done && obj.clean) {
              acc = obj.clean;
              showGhost(acc);
            }
          }
        }
      }
      if (!acc.trim()) {
        removeGhost();
        toast('模型这次没接上话，再试一次。');
      } else {
        setStatus('接上了 · Tab 收下', 2600);
      }
    } catch (err) {
      removeGhost();
      if (err.name !== 'AbortError') toast(err.message || '幽灵字失败', 'err');
      if (err.name !== 'AbortError') setStatus('AI 出错了', 3000);
    } finally {
      S.ghostBusy = false;
      S.ghostAbort = null;
      S.wordsAtGhost = countWords(rawText());
    }
  }

  function cancelGhost() {
    if (S.ghostAbort) {
      try { S.ghostAbort.abort(); } catch {}
      S.ghostAbort = null;
    }
    el.editor.querySelectorAll('.ghost-thinking').forEach((n) => n.remove());
  }

  function acceptGhost(mode) {
    const span = el.editor.querySelector('.ghost');
    if (!span) return;
    const full = S.ghostText || span.textContent || '';
    const take = mode === 'sentence' ? firstSentence(full) : full;
    const rest = full.slice(take.length);
    const node = document.createTextNode(take);
    span.replaceWith(node);
    const r = document.createRange();
    r.setStartAfter(node);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    el.editor.focus();
    S.ghostText = '';
    if (rest.trim()) showGhost(rest.replace(/^\n+/, ''));
    else updateGhostUI();
    // 意图是一次性的：用过就清掉，否则后面每一段都会被旧方向带偏
    clearIntent();
    S.wordsAtGhost = countWords(rawText());
    onTextChanged();
    if (countWords(S.text) - S.wordsAtBeats > 120 && !S.beatsBusy) {
      clearTimeout(S.bgTimer);
      S.bgTimer = setTimeout(() => requestBeats(true), 900);
    }
  }

  function rejectGhost() {
    const span = el.editor.querySelector('.ghost');
    if (!span) return;
    const text = (S.ghostText || span.textContent || '').trim();
    span.remove();
    S.ghostText = '';
    updateGhostUI();
    if (text) {
      S.alts.unshift({ text, at: Date.now() });
      S.alts = S.alts.slice(0, 6);
      renderAlts();
    }
    clearIntent();
    S.wordsAtGhost = countWords(rawText());
  }

  /* ---------------- 走向 ---------------- */
  async function requestBeats(silent) {
    if (S.beatsBusy) return;
    if (countWords(rawText()) < 10) {
      if (!silent) toast('先写十几个字，它才好判断往哪走。');
      return;
    }
    S.beatsBusy = true;
    const btn = $('#btnBeats');
    if (btn) btn.textContent = '在想…';
    setStatus('在想三条路…');
    try {
      const j = await api('/api/beats', {
        method: 'POST',
        body: JSON.stringify({ story: S.slug, text: rawText() })
      });
      S.beats = (j.beats || []).filter(Boolean);
      S.wordsAtBeats = countWords(rawText());
      renderBeats(true);
      setStatus(S.beats.length ? '给了 ' + S.beats.length + ' 条路' : '暂时没有新想法', 2600);
    } catch (e) {
      if (!silent) toast(e.message, 'err');
      setStatus('走向失败', 3000);
    } finally {
      S.beatsBusy = false;
      if (btn) btn.textContent = '重想';
    }
  }

  function renderBeats(animate) {
    el.beats.innerHTML = '';
    el.beatCount.textContent = String(S.beats.length);
    el.beatsEmpty.hidden = S.beats.length > 0;
    S.beats.forEach((b, i) => {
      const li = document.createElement('li');
      li.className = 'beat';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', '采用第 ' + (i + 1) + ' 条走向：' + b);
      const n = document.createElement('span');
      n.className = 'beat-n';
      n.textContent = String(i + 1);
      const t = document.createElement('span');
      t.className = 'beat-t';
      t.textContent = b;
      li.append(n, t);
      li.addEventListener('click', () => adoptBeat(i));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          adoptBeat(i);
        }
      });
      el.beats.appendChild(li);
      if (animate) {
        t.textContent = '';
        decodeInto(t, b);
      }
    });
    updateBeatsStale();
  }

  // 正文已经往前走了很多、而这三条路还是旧的 —— 视觉上要看得出来
  function updateBeatsStale() {
    if (!el.beats) return;
    const pane = el.beats.closest('.pane-beats');
    if (!pane) return;
    const drift = countWords(S.text) - S.wordsAtBeats;
    pane.classList.toggle('is-stale', S.beats.length > 0 && drift > 120);
  }

  function adoptBeat(i) {
    const b = S.beats[i];
    if (!b) return;
    S.intent = b;
    el.intent.hidden = false;
    el.intentText.textContent = b;
    [...el.beats.children].forEach((li, k) => li.classList.toggle('is-picked', k === i));
    api('/api/beat', {
      method: 'POST',
      body: JSON.stringify({ story: S.slug, text: b, action: 'adopt' })
    }).catch(() => {});
    requestGhost({ force: true });
  }

  function clearIntent() {
    S.intent = '';
    S.intentSpent = false;
    el.intent.hidden = true;
    el.intentText.textContent = '';
    [...el.beats.children].forEach((li) => li.classList.remove('is-picked'));
  }

  function renderAlts() {
    el.alts.innerHTML = '';
    el.altCount.textContent = String(S.alts.length);
    el.altsEmpty.hidden = S.alts.length > 0;
    S.alts.forEach((a, i) => {
      const li = document.createElement('li');
      li.className = 'alt';
      const t = document.createElement('span');
      t.className = 'alt-t';
      t.textContent = a.text;
      const btn = document.createElement('button');
      btn.className = 'alt-btn';
      btn.type = 'button';
      btn.textContent = '捡回';
      btn.addEventListener('click', () => {
        const cur = rawText().replace(/\s+$/, '');
        setText(cur + (cur.endsWith('\n') ? '' : '\n\n') + a.text);
        placeCaretEnd();
        S.alts.splice(i, 1);
        renderAlts();
        onTextChanged();
      });
      li.append(t, btn);
      el.alts.appendChild(li);
    });
  }

  /* ---------------- 后台：档案 ---------------- */
  function maybeBackground() {
    if (S.muted) return;
    const w = countWords(S.text);
    // 第一次给路要快：写了十几个字就该有反应；之后才按字数额度刷新
    const needBeats = S.beats.length === 0 ? 12 : (S.config?.trigger?.charsForBeats ?? 240);
    if (w - S.wordsAtBeats >= needBeats && !S.beatsBusy) {
      requestBeats(true);
    }
    if (w - S.wordsAtBible >= (S.config?.trigger?.charsForBible ?? 800) && !S.bibleBusy) {
      extractBible();
    }
  }

  async function extractBible(force) {
    if (S.bibleBusy) return;
    const text = rawText();
    if (!force && countWords(text) - S.wordsAtBible < (S.config?.trigger?.charsForBible ?? 800)) return;
    if (text.length <= S.extractOffset) {
      S.extractOffset = Math.max(0, text.length - 4000);
    }
    const delta = text.slice(S.extractOffset);
    if (countWords(delta) < 60) return;
    S.bibleBusy = true;
    try {
      const j = await api('/api/extract', {
        method: 'POST',
        body: JSON.stringify({ story: S.slug, delta })
      });
      if (j.bible) S.bible = j.bible;
      S.extractOffset = text.length;
      S.wordsAtBible = countWords(text);
      if (j.added > 0) {
        toast('档案 +' + j.added);
        if (!el.overlay.hidden && currentTab === 'global') renderGlobal();
      }
    } catch {
      /* 档案失败不打扰写作 */
    } finally {
      S.bibleBusy = false;
    }
  }

  /* ---------------- 覆盖层 ---------------- */
  let currentTab = 'global';

  function openSheet(tab) {
    currentTab = tab || 'global';
    el.overlay.hidden = false;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === currentTab));
    el.sheetTitle.textContent = currentTab === 'global' ? '总览' : '设置';
    if (currentTab === 'global') renderGlobal();
    else renderSettings();
  }

  function closeSheet() {
    el.overlay.hidden = true;
    el.sheetBody.innerHTML = '';
  }

  function renderGlobal() {
    const b = S.bible || {};
    const scenes = (S.text.match(/^[ \t]*(?:##[ \t]*)?场[ \t]*\d+/gm) || []).length;
    const openThreads = (b.threads || []).filter((t) => t.status !== 'closed').length;
    const openFore = (b.foreshadow || []).filter((f) => !f.payoffIn).length;

    const cell = (k, v) => `<div class="stat-cell"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const item = (title, sub, pill) =>
      `<div class="bible-item"><b>${esc(title)}</b>${pill || ''}${
        sub ? '<br><span>' + esc(sub) + '</span>' : ''
      }</div>`;
    const empty = (t) => `<div class="bible-empty">${t}</div>`;

    const chars = (b.characters || [])
      .map((c) => {
        const bits = [];
        if (c.want) bits.push('想要 ' + c.want);
        if (c.fear) bits.push('怕 ' + c.fear);
        if (c.secret) bits.push('藏着 ' + c.secret);
        if (c.state) bits.push('此刻 ' + c.state);
        return item(c.name || '（未命名）', bits.join('；') || c.firstSeen || '');
      })
      .join('');
    const world = (b.world || []).map((w) => item(w.name || '—', w.rule || '')).join('');
    const threads = (b.threads || [])
      .map((t) =>
        item(
          t.name || '—',
          t.note || '',
          `<span class="pill ${t.status === 'closed' ? 'closed' : 'open'}">${t.status === 'closed' ? '已合' : '悬着'}</span>`
        )
      )
      .join('');
    const fore = (b.foreshadow || [])
      .map((f) => item(f.note || '—', (f.plantedIn || '') + (f.payoffIn ? ' → ' + f.payoffIn : ' · 未回收')))
      .join('');
    const time = (b.timeline || []).map((t) => item(t.when || '—', t.what || '')).join('');

    el.sheetBody.innerHTML = `
      <div class="stats-row">
        ${cell('字数', countWords(S.text))}
        ${cell('场', scenes || '—')}
        ${cell('角色', (b.characters || []).length)}
        ${cell('悬着的线', openThreads)}
        ${cell('未回收伏笔', openFore)}
      </div>
      <div class="bible-grid">
        <div class="bible-sec"><h3>角色<i></i></h3>${chars || empty('还没有人出现。')}</div>
        <div class="bible-sec"><h3>世界的规则<i></i></h3>${world || empty('还没立规矩。')}</div>
        <div class="bible-sec"><h3>线索<i></i></h3>${threads || empty('还没有悬着的事。')}</div>
        <div class="bible-sec"><h3>伏笔<i></i></h3>${fore || empty('还没埋钩子。')}</div>
        <div class="bible-sec"><h3>时间线<i></i></h3>${time || empty('还没发生什么。')}</div>
        <div class="bible-sec"><h3>最近采用的路<i></i></h3>${
          S.beats.length
            ? S.beats.map((x) => `<div class="bible-item"><span>${esc(x)}</span></div>`).join('')
            : empty('还没选过走向。')
        }</div>
      </div>
      <p class="form-note" style="margin-top:24px">档案是 AI 从你已经写的正文里抽出来的，它只新增、不覆盖，也不会改你写的字。想强制再抽一次，按下面的按钮。</p>
      <button class="btn-ghost" id="btnForceExtract" type="button">现在重新梳理一次</button>
    `;
    const btn = $('#btnForceExtract');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.textContent = '正在梳理…';
        await extractBible(true);
        btn.textContent = '现在重新梳理一次';
        renderGlobal();
      });
    }
  }

  function renderSettings() {
    const c = S.config;
    if (!c) return;
    const provOpts = Object.entries(c.providers)
      .map(([k, v]) => `<option value="${k}">${v.label}${v.hasKey ? '' : '（未填 Key）'}</option>`)
      .join('');
    const roleRow = (key, label) => `
      <div class="form-row">
        <label>${label}</label>
        <select data-role-prov="${key}">${provOpts}</select>
        <input data-role-model="${key}" value="${esc(c.roles[key].model || '')}" placeholder="模型名" />
      </div>`;
    const provRow = (k, v) => `
      <div class="form-row">
        <label>${v.label}</label>
        <input data-prov-url="${k}" value="${esc(v.baseURL || '')}" placeholder="https://.../v1" />
        <input type="password" data-prov-key="${k}" placeholder="${v.hasKey ? '已保存，留空不改' : 'sk-...'}" />
      </div>`;

    el.sheetBody.innerHTML = `
      <div class="form-sec">模型接入（OpenAI 兼容）</div>
      <p class="form-note">国内直连可用的是 DeepSeek 和智谱 GLM；Claude / GPT 需要填中转地址。Key 只存在本机 <code>~/.flowwrite/config.json</code>，不会进浏览器存储，也不会打进包里。</p>
      ${Object.entries(c.providers).map(([k, v]) => provRow(k, v)).join('')}

      <div class="form-sec">分工</div>
      <p class="form-note">实测：<b>deepseek-flash</b> 首字 1.4 秒；<b>deepseek-v4-pro</b> 会把 token 全烧在推理上、正文返回空，不建议用来写。</p>
      ${roleRow('writer', '写正文')}
      ${roleRow('planner', '想走向')}
      ${roleRow('archivist', '理档案')}
      <div class="form-row"><label></label><button class="btn-ghost" id="btnTest" type="button">测一下写正文的连通性</button><span class="form-note" id="testOut" style="margin:0"></span></div>

      <div class="form-sec">手的节奏</div>
      <div class="form-row"><label>停笔多久出手</label><input data-trig="idleMs" type="number" min="400" max="5000" step="100" value="${c.trigger.idleMs}" /><span class="form-note" style="margin:0">毫秒</span></div>
      <div class="form-row"><label>写够多少字才接话</label><input data-trig="minCharsForGhost" type="number" min="2" max="200" value="${c.trigger.minCharsForGhost}" /><span class="form-note" style="margin:0">字</span></div>
      <div class="form-row"><label>一次写几句</label><input data-trig="ghostSentences" type="number" min="1" max="12" value="${c.trigger.ghostSentences}" /><span class="form-note" style="margin:0">句</span></div>

      <div class="form-sec">界面</div>
      <div class="form-row"><label>正文字号</label><input data-ui="fontSize" type="number" min="14" max="26" value="${c.ui.fontSize}" /><span class="form-note" style="margin:0">px</span></div>
      <div class="form-row"><label>行高</label><input data-ui="lineHeight" type="number" min="1.4" max="2.6" step="0.05" value="${c.ui.lineHeight}" /><span class="form-note" style="margin:0">倍</span></div>

      <div class="form-sec">故事</div>
      <div class="form-row"><label>存放位置</label><input data-root value="${esc(c.root)}" style="grid-column:span 2" /></div>
      <ul class="story-list" id="storyList"></ul>
      <div class="form-row" style="margin-top:12px"><label>新建一个</label><input id="newStory" placeholder="故事名" /><button class="btn-ghost" id="btnNewStory" type="button">建</button></div>

      <div class="form-sec">备份</div>
      <div class="form-row"><label>导出</label>
        <a class="btn-ghost" href="/api/export?fmt=md&story=${encodeURIComponent(S.slug)}" download>Markdown</a>
        <a class="btn-ghost" href="/api/export?fmt=txt&story=${encodeURIComponent(S.slug)}" download>纯文本</a>
      </div>

      <div style="margin-top:26px;display:flex;gap:10px">
        <button class="btn-primary" id="btnSaveCfg" type="button" style="margin:0">保存设置</button>
      </div>
    `;

    Object.entries(c.roles).forEach(([k, v]) => {
      const sel = el.sheetBody.querySelector(`[data-role-prov="${k}"]`);
      if (sel) sel.value = v.provider;
    });

    renderStoryList();

    $('#btnTest')?.addEventListener('click', async (e) => {
      const out = $('#testOut');
      out.textContent = '测试中…';
      try {
        const r = await api('/api/config/test', { method: 'POST', body: JSON.stringify({ role: 'writer' }) });
        out.textContent = r.ok ? `通了 ${r.ms}ms（${r.model}）` : '失败：' + r.error;
      } catch (err) {
        out.textContent = '失败：' + err.message;
      }
    });

    $('#btnSaveCfg')?.addEventListener('click', saveSettings);
    $('#btnNewStory')?.addEventListener('click', async () => {
      const name = $('#newStory').value.trim();
      if (!name) return;
      const r = await api('/api/stories', { method: 'POST', body: JSON.stringify({ title: name }) });
      await loadStory(r.slug);
      openSheet('settings');
      toast('建好了：' + name);
    });
  }

  function renderStoryList() {
    const list = $('#storyList');
    if (!list) return;
    list.innerHTML = '';
    (S.stories || []).forEach((s) => {
      const li = document.createElement('li');
      li.className = 'story-row' + (s.slug === S.slug ? ' is-on' : '');
      li.innerHTML = `<span class="t">${esc(s.title)}</span><span class="m">${s.words || 0} 字</span>`;
      li.addEventListener('click', async () => {
        if (s.slug === S.slug) return;
        await doSave();
        await loadStory(s.slug);
        openSheet('settings');
      });
      list.appendChild(li);
    });
  }

  async function saveSettings() {
    const body = { providers: {}, roles: {}, trigger: {}, ui: {} };
    el.sheetBody.querySelectorAll('[data-prov-url]').forEach((i) => {
      const k = i.dataset.provUrl;
      body.providers[k] = body.providers[k] || {};
      body.providers[k].baseURL = i.value.trim();
    });
    el.sheetBody.querySelectorAll('[data-prov-key]').forEach((i) => {
      const k = i.dataset.provKey;
      if (!i.value.trim()) return;
      body.providers[k] = body.providers[k] || {};
      body.providers[k].apiKey = i.value.trim();
    });
    el.sheetBody.querySelectorAll('[data-role-prov]').forEach((s) => {
      const k = s.dataset.roleProv;
      body.roles[k] = body.roles[k] || {};
      body.roles[k].provider = s.value;
    });
    el.sheetBody.querySelectorAll('[data-role-model]').forEach((i) => {
      const k = i.dataset.roleModel;
      body.roles[k] = body.roles[k] || {};
      body.roles[k].model = i.value.trim();
    });
    el.sheetBody.querySelectorAll('[data-trig]').forEach((i) => {
      body.trigger[i.dataset.trig] = Number(i.value);
    });
    el.sheetBody.querySelectorAll('[data-ui]').forEach((i) => {
      body.ui[i.dataset.ui] = Number(i.value);
    });
    const rootInput = el.sheetBody.querySelector('[data-root]');
    if (rootInput && rootInput.value.trim()) body.root = rootInput.value.trim();

    try {
      const cfg = await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
      S.config = cfg;
      applyUi();
      toast('设置已保存');
      renderSettings();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function applyUi() {
    const ui = S.config?.ui || {};
    if (ui.fontSize) document.documentElement.style.setProperty('--fs', ui.fontSize + 'px');
    if (ui.lineHeight) document.documentElement.style.setProperty('--lh', String(ui.lineHeight));
    if (ui.sidebarWidth) document.documentElement.style.setProperty('--rail', ui.sidebarWidth + 'px');
    const w = S.config?.roles?.writer;
    el.statModel.textContent = w ? `${w.model}` : '—';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------- 加载 ---------------- */
  async function loadStory(slug) {
    const q = slug ? '?story=' + encodeURIComponent(slug) : '';
    const data = await api('/api/state' + q);
    S.slug = data.slug;
    S.story = data.story || {};
    S.text = data.text || '';
    S.bible = data.bible || S.bible;
    S.stories = data.stories || [];
    S.config = data.config;
    S.muted = false;
    S.alts = [];
    S.beats = [];
    S.intent = '';
    S.wordsAtGhost = countWords(S.text);
    S.wordsAtBeats = countWords(S.text);
    S.wordsAtBible = countWords(S.text);
    S.extractOffset = Math.max(0, S.text.length - 3000);

    el.title.textContent = S.story.title || '未命名故事';
    document.title = (S.story.title || '未命名故事') + ' · FlowWrite';
    setText(S.text);
    placeCaretEnd();
    renderAlts();
    renderBeats(false);
    el.intent.hidden = true;
    el.statLatency.textContent = '—';
    el.btnMuteUpdate?.();
    updateMuteUI();
    updateCounts();
    applyUi();
    setStatus('就绪', 1500);
    if (countWords(S.text) >= 12) {
      setTimeout(() => requestBeats(true), 900);
    }
  }

  function updateMuteUI() {
    const btn = $('#btnMute');
    if (!btn) return;
    btn.textContent = S.muted ? 'AI 静音' : 'AI 开着';
    btn.setAttribute('aria-pressed', S.muted ? 'true' : 'false');
  }

  function toggleMute() {
    S.muted = !S.muted;
    updateMuteUI();
    if (S.muted) {
      cancelGhost();
      removeGhost();
      setStatus('静音了，按 Alt+M 叫回来', 2600);
    } else {
      setStatus('AI 回来了', 1600);
    }
  }

  function toggleRail() {
    if (window.innerWidth <= 900) {
      el.workspace.classList.toggle('rail-open');
    } else {
      el.workspace.classList.toggle('rail-off');
    }
  }

  /* ---------------- 事件 ---------------- */
  function bindEditor() {
    el.editor.addEventListener('input', () => {
      // 人一动手，就说明这条走向已经用过了，别再拿它牵着后面的续写
      if (S.intentSpent) {
        S.intentSpent = false;
        clearIntent();
      }
      if (S.ghostBusy) cancelGhost();
      removeGhost();
      onTextChanged();
    });

    el.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '\n');
      }
    });

    el.editor.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });

    el.editor.addEventListener('blur', () => {
      setTimeout(() => {
        if (!el.editor.contains(document.activeElement)) {
          clearTimeout(S.ghostTimer);
          S.ghostTimer = setTimeout(() => {
            if (document.activeElement !== el.editor && !S.muted && !S.ghostText) {
              /* 失焦就不主动接话，避免在别的窗口写时突然冒字 */
            }
          }, 50);
        }
      }, 0);
    });

    el.title?.addEventListener('blur', async () => {
      const t = el.title.textContent.trim() || '未命名故事';
      if (t === S.story.title) return;
      S.story.title = t;
      document.title = t + ' · FlowWrite';
      try {
        await api('/api/story', { method: 'PUT', body: JSON.stringify({ slug: S.slug, patch: { title: t } }) });
      } catch {}
    });
    el.title?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.title.blur();
      }
    });
  }

  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const inField = e.target.closest && e.target.closest('input,select,textarea');
      if (inField) return;

      const alt = e.altKey;
      const k = (e.key || '').toLowerCase();

      if (!el.overlay.hidden && e.key === 'Escape') {
        e.preventDefault();
        closeSheet();
        return;
      }
      if (e.key === 'Tab' && S.ghostText && document.activeElement !== el.title) {
        e.preventDefault();
        acceptGhost('all');
        return;
      }
      if (e.ctrlKey && e.key === 'ArrowRight' && S.ghostText) {
        e.preventDefault();
        acceptGhost('sentence');
        return;
      }
      if (e.key === 'Escape') {
        if (S.ghostText) {
          e.preventDefault();
          rejectGhost();
        }
        return;
      }
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        requestGhost({ long: true, force: true });
        return;
      }
      if (alt && /^[1-3]$/.test(e.key)) {
        e.preventDefault();
        if (S.beats[Number(e.key) - 1]) adoptBeat(Number(e.key) - 1);
        return;
      }
      if (!alt) return;
      if (k === 'g') { e.preventDefault(); openSheet('global'); }
      else if (k === 's') { e.preventDefault(); openSheet('settings'); }
      else if (k === 'b') { e.preventDefault(); toggleRail(); }
      else if (k === 'm') { e.preventDefault(); toggleMute(); }
      else if (k === 'r') { e.preventDefault(); requestBeats(); }
    });
  }

  function bindChrome() {
    $('#btnGlobal')?.addEventListener('click', () => openSheet('global'));
    $('#btnSettings')?.addEventListener('click', () => openSheet('settings'));
    $('#btnRail')?.addEventListener('click', toggleRail);
    $('#btnMute')?.addEventListener('click', toggleMute);
    $('#btnBeats')?.addEventListener('click', () => requestBeats());
    $('#sheetClose')?.addEventListener('click', closeSheet);
    $('#intentClear')?.addEventListener('click', clearIntent);
    el.overlay?.addEventListener('click', (e) => {
      if (e.target === el.overlay) closeSheet();
    });
    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => {
        currentTab = b.dataset.tab;
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-on', x === b));
        el.sheetTitle.textContent = currentTab === 'global' ? '总览' : '设置';
        if (currentTab === 'global') renderGlobal();
        else renderSettings();
      });
    });
    window.addEventListener('beforeunload', () => {
      if (!S.slug) return;
      const blob = JSON.stringify({ story: S.slug, text: rawText() });
      navigator.sendBeacon?.('/api/manuscript', new Blob([blob], { type: 'application/json' }));
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) el.workspace.classList.remove('rail-open');
    });
  }

  async function boot() {
    document.getElementById('intro')?.setAttribute('hidden', '');
    el.app.hidden = false;
    requestAnimationFrame(() => el.app.classList.add('is-on'));
    bindEditor();
    bindGlobalKeys();
    bindChrome();
    try {
      await loadStory();
      el.editor.focus();
      placeCaretEnd();
    } catch (e) {
      toast('加载失败：' + e.message, 'err');
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelGhost();
        doSave();
      }
    });
  }

  window.__fw = { S, maybeGhost, requestGhost, caretAtEnd, rawText, decodeInto };

  document.addEventListener('flowwrite:enter', boot, { once: true });
})();
