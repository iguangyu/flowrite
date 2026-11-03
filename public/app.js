/* FlowWrite 前端。
   一句话原则：AI 永远不自动改动人写的字，它只在后面给出「淡灰色的下一句」和「三条路」。 */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 构建戳：从 index.html 注入的 ?v= 里读。用来一眼判断页面是不是最新的
  const BUILD = (() => {
    try {
      return new URL(document.currentScript.src).searchParams.get('v') || 'dev';
    } catch {
      return 'dev';
    }
  })();

  const el = {
    app: $('#app'),
    paper: $('#paper'),
    editor: $('#editor'),
    title: $('#storyTitle'),
    topMeta: $('#topMeta'),
    beats: $('#beats'),
    beatsEmpty: $('#beatsEmpty'),
    sparks: $('#sparks'),
    sparksEmpty: $('#sparksEmpty'),
    btnSparks: $('#btnSparks'),
    pacing: $('#pacing'),
    pacingEmpty: $('#pacingEmpty'),
    paceStage: $('#paceStage'),
    paceFill: $('#paceFill'),
    paceNum: $('#paceNum'),
    paceChange: $('#paceChange'),
    pacePull: $('#pacePull'),
    paceNote: $('#paceNote'),
    alts: $('#alts'),
    altsEmpty: $('#altsEmpty'),
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
    pop: $('#pop'),
    dockBtn: $('#dockBtn'),
    dockCount: $('#dockCount')
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
    ghostSeq: 0,
    ghostWatchdog: 0,
    ghostAbort: null,
    beatsBusy: false,
    beatsAnimated: false,
    sparks: [],
    sparksBusy: false,
    sparksAnimated: false,
    pacing: null,
    bibleBusy: false,
    wordsAtGhost: 0,
    wordsAtBeats: 0,
    wordsAtBible: 0,
    wordsAtSparks: 0,
    extractOffset: 0,
    saveTimer: 0,
    ghostTimer: 0,
    bgTimer: 0,
    statusTimer: 0,
    statusLock: 0,
    snap: '',
    userEdited: false,
    mood: 'curious',
    ghostOn: true,
    wlBusy: false,
    wlAt: 0,
    wlSeq: 0,
    wlMarks: []
  };

  // 乱码字符池：幽灵字和弹窗可以各用一套（设置里可改）
  const GLYPH_SETS = {
    hanzi: {
      label: '汉字',
      chars: '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'
    },
    rare: { label: '生僻字', chars: '龘靐齉爩鱻麤龗灪爨鑫犇淼焱垚燚赑' },
    kana: {
      label: '假名',
      chars: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'
    },
    latin: { label: '字母', chars: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    binary: { label: '0 与 1', chars: '0101010101' },
    symbol: { label: '符号', chars: '※§¶†‡○●△▲□■◇◆' },
    morse: { label: '摩斯', chars: '·−' },
    block: { label: '方块', chars: '░▒▓█▚▞▙▟' }
  };

  function poolOf(key) {
    const s = GLYPH_SETS[key];
    return (s && s.chars) || GLYPH_SETS.hanzi.chars;
  }
  const poolGhost = () => poolOf(S.config?.effects?.ghostGlyphs);
  const poolPanel = () => poolOf(S.config?.effects?.panelGlyphs);

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

  // 状态栏：priority=true 的消息（比如"光标不在文末"）在 hold 期间不许被别人盖掉
  function setStatus(txt, hold, priority) {
    const now = Date.now();
    if (!priority && now < (S.statusLock || 0)) return;
    el.statStatus.textContent = txt;
    clearTimeout(S.statusTimer);
    S.statusLock = priority && hold ? now + hold : 0;
    if (hold) {
      S.statusTimer = setTimeout(() => {
        S.statusLock = 0;
        el.statStatus.textContent = '就绪';
      }, hold);
    }
  }

  // 走向文字的解码动效：用 baffle.js 逐字还原。
  // baffle 每 tick 还原 ceil(len / (duration/speed)) 个字，要让效果看得见，
  // 就得让每一步只还原一个字 —— 于是把 speed 反算成 1600/len，总时长固定在 1.6s。
  function decodeInto(node, finalText, ms) {
    node.textContent = finalText;
    if (reduced) return;
    const dur = ms || S.config?.effects?.baffleMs || 1600;
    if (window.baffle) {
      try {
        const len = Math.max(1, finalText.length);
        const speed = Math.max(16, Math.min(60, Math.round(dur / len)));
        window.baffle(node, { characters: poolPanel(), speed }).reveal(dur);
        return;
      } catch {
        node.textContent = finalText;
      }
    }
    fallbackScramble(node, finalText, dur);
  }

  function fallbackScramble(node, finalText, ms) {
    const start = performance.now();
    const len = finalText.length;
    const pool = poolPanel();
    function tick(now) {
      const p = Math.min(1, (now - start) / ms);
      const shown = Math.floor(p * len);
      let out = finalText.slice(0, shown);
      for (let i = shown; i < len; i++) {
        const ch = finalText[i];
        if (/\s/.test(ch)) out += ch;
        else out += pool[(i * 17 + Math.floor(now / 40) * 7) % pool.length];
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
    clone.querySelectorAll('.ghost').forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return clone.textContent || '';
  }

  function setText(t) {
    removeGhost();
    el.editor.textContent = t || '';
    S.text = rawText();
  }

  function removeGhost() {
    stopPlaceholder();
    el.editor.querySelectorAll('.ghost').forEach((n) => n.remove());
    S.ghostText = '';
    updateGhostUI();
  }

  /* 幽灵字：紧贴光标往后长，不另起一行，也不显示任何"正在生成"的提示。
     1) 请求发出的那一刻就先放一串乱码占位，让人马上看到"它在写了"
     2) 真文字到了以后，用 baffle 把占位替换成句子，宽度接近，不会跳
     3) 还没成句的尾巴直接贴着光标写 */

  function ghostSpan() {
    let span = el.editor.querySelector('.ghost');
    if (!span) {
      span = document.createElement('span');
      span.className = 'ghost';
      span.contentEditable = 'false';
      el.editor.appendChild(span);
    }
    return span;
  }

  let phEl = null;
  let phTimer = 0;
  let phWatch = 0;
  const phLenDefault = 10;

  function randGlyphs(n) {
    let s = '';
    const pool = poolGhost();
    for (let i = 0; i < n; i++) s += pool[(Math.random() * pool.length) | 0];
    return s;
  }

  /* 占位符和"某一次请求"解耦了：它只表示"文灵在动"。
     这样你一边打字、旧请求被 abort，占位也不会闪没。 */
  function ensurePlaceholder() {
    if (phEl || S.ghostText) return;
    const span = ghostSpan();
    span.textContent = '';
    const len = Math.max(4, Math.min(24, Number(S.config?.effects?.placeholderLen) || phLenDefault));
    phEl = document.createElement('span');
    phEl.className = 'g-live g-ph';
    phEl.textContent = randGlyphs(len);
    span.appendChild(phEl);
    clearInterval(phTimer);
    phTimer = setInterval(() => {
      if (phEl) phEl.textContent = randGlyphs(len);
    }, 90);
    clearTimeout(phWatch);
    phWatch = setTimeout(() => { if (!S.ghostText) stopPlaceholder(); }, 12000);
    scheduleEnsure(span);
  }

  function stopPlaceholder() {
    clearInterval(phTimer);
    phTimer = 0;
    clearTimeout(phWatch);
    phWatch = 0;
    if (phEl && phEl.parentNode) phEl.remove();
    phEl = null;
    const sp = el.editor.querySelector('.ghost');
    if (sp && !sp.textContent.trim()) sp.remove();
  }

  // 模型会把原文抄回来 —— 抄了开头就切开头，整句抄了就整句删掉。
  // 宁可删狠一点，也不要让作者看见自己写的话出现两遍。
  function deEcho(text, base) {
    const src = String(base || '');
    let out = String(text || '');

    // 1) 开头重复了原文尾部
    for (const n of [24, 18, 12, 8]) {
      const tail = src.replace(/\s+$/, '').slice(-n);
      if (tail.length === n && out.startsWith(tail)) {
        out = out.slice(n);
        break;
      }
    }

    // 2) 幽灵内容里整句抄了原文 —— 把那句抽掉
    const sentences = src
      .split(/(?<=[。！？…”」』])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12);
    for (const q of sentences.slice(-6)) {
      if (out.includes(q)) out = out.split(q).join('');
    }

    // 3) 任意长片段的重合也切掉 —— 模型有时把原文拆碎了抄回来
    for (let n = 20; n >= 12; n--) {
      let guard = 0;
      while (guard++ < 4) {
        let hit = '';
        for (let i = 0; i + n <= out.length; i++) {
          const seg = out.slice(i, i + n);
          if (src.includes(seg)) { hit = seg; break; }
        }
        if (!hit) break;
        out = out.split(hit).join('');
      }
    }

    return out.replace(/^[\s\u200b]+/, '');
  }

  function showGhost(text) {
    const base = rawText();
    let clean = String(text || '').replace(/^[\s\u200b]+/, '');
    clean = deEcho(clean, base);
    if (!clean) return;

    // 首字刚到但还太短 —— 让占位再抖一会儿，等句子成形再换，避免宽度突变
    if (phEl && clean.length < 8) return;

    if (phEl) stopPlaceholder();
    const span = ghostSpan();
    if (!S.ghostText) span.textContent = '';
    S.ghostText = clean;
    updateGhostUI();
    paintGhost(span, clean);
    scheduleEnsure(span);
  }

  // 全量文本 → 「已完成句」若干 +「正在写的半句」
  function paintGhost(span, full) {
    const segs = [];
    let rest = full;
    const re = /^[\s\S]*?[。！？…\n]/;
    while (rest) {
      const m = rest.match(re);
      if (!m) break;
      segs.push(m[0]);
      rest = rest.slice(m[0].length);
      if (segs.length > 60) break;
    }

    const noDecode = reduced || S.config?.effects?.ghostDecode === false;
    const liveEl = span.querySelector('.g-live');
    const prevLive = liveEl ? liveEl.textContent : '';

    let done = span.querySelectorAll('.g-seg');
    if (done.length > segs.length) {
      span.textContent = '';
      done = [];
    }

    for (let i = done.length; i < segs.length; i++) {
      const seg = document.createElement('span');
      seg.className = 'g-seg';
      seg.textContent = segs[i];
      const live = span.querySelector('.g-live');
      span.insertBefore(seg, live || null);
      // 这一句刚刚是以「半句」的形式显示过的，就别再抖一遍
      const wasVisible = i === segs.length - 1 && prevLive.length > 8 && segs[i].startsWith(prevLive.slice(0, 8));
      if (!noDecode && !wasVisible && window.baffle) {
        try {
          const n = Math.max(1, segs[i].length);
          window.baffle(seg, {
            characters: poolGhost(),
            speed: Math.max(18, Math.min(60, Math.round(360 / n)))
          }).reveal(360);
        } catch {
          seg.textContent = segs[i];
        }
      }
    }

    let live = span.querySelector('.g-live');
    if (rest) {
      if (!live) {
        live = document.createElement('span');
        live.className = 'g-live';
        span.appendChild(live);
      }
      live.textContent = rest;
    } else if (live) {
      live.remove();
    }
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
    frag.querySelectorAll?.('.ghost').forEach((n) => n.remove());
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
      // 服务端拒收空稿：只有"这个页面里你亲手删空的"才允许覆盖
      if (/拒收空稿/.test(e.message) && S.userEdited) {
        try {
          await api('/api/manuscript', {
            method: 'PUT',
            body: JSON.stringify({ story: S.slug, text: S.text, force: true })
          });
          setStatus('已保存', 1600);
          return;
        } catch (e2) {
          e = e2;
        }
      }
      setStatus('保存失败：' + e.message, 4000);
    }
  }

  function onTextChanged() {
    wlPoke();
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

  /* 新旧两份正文的差异。写作大多是尾部追加，所以先剥掉公共前后缀，
     中间剩下的就是真正的改动。比「总字数差」稳：删一段再写一段时，
     总字数差会算成负数，于是它永远不开口。 */
  function textDelta(prev, next) {
    const a = String(prev || '');
    const b = String(next || '');
    if (a === b) return { added: '', removed: '', at: a.length };
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i++;
    let j = 0;
    while (j < max - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    return {
      added: b.slice(i, b.length - j),
      removed: a.slice(i, a.length - j),
      at: i
    };
  }

  // 幽灵字告一段落时，把「下一轮的起点」同时记到字数和文本快照上
  function markGhostBase() {
    const t = rawText();
    S.wordsAtGhost = countWords(t);
    S.snap = t;
  }

  /* ---------------- 幽灵字 ---------------- */
  // 它不出手的时候，必须让人知道为什么 —— 否则就是"怎么又不出现了"
  function maybeGhost() {
    if (S.muted) {
      setStatus('AI 已静音（Alt+M 叫回来）', 1800, true);
      return;
    }
    if (S.ghostBusy || S.ghostText) return;
    if (!caretAtEnd()) {
      setStatus('光标不在文末，它只在末尾接话', 2200, true);
      return;
    }
    const need = S.config?.trigger?.minCharsForGhost ?? 4;
    // 按「和上次交给模型那一份的 diff」算新增，删改之后也不会卡住
    const delta = countWords(textDelta(S.snap, S.text).added);
    if (delta < need) {
      setStatus('再写 ' + Math.max(1, need - delta) + ' 个字就接', 1600, true);
      return;
    }
    if (countWords(S.text) < 3) {
      setStatus('先写半句', 1600, true);
      return;
    }
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
    // 每次请求发一个序号。被 abort 的旧请求回来时，不能再动新请求的占位和幽灵字
    const seq = ++S.ghostSeq;
    cancelGhost();
    S.ghostBusy = true;
    const ac = new AbortController();
    if (S.intent) S.intentSpent = true;
    S.ghostAbort = ac;
    const t0 = performance.now();
    let acc = '';
    let firstAt = 0;

    // 兜底：万一占位或请求卡住，25 秒后强制解锁，别让 ghostBusy 永久为 true
    clearTimeout(S.ghostWatchdog);
    S.ghostWatchdog = setTimeout(() => {
      if (S.ghostSeq === seq && S.ghostBusy) {
        try { ac.abort(); } catch {}
        S.ghostBusy = false;
        stopPlaceholder();
      }
    }, 25000);

    try {
      S.snap = text; // 这一份交给模型了，下次按它算新增
      setStatus('在想…');
      ensurePlaceholder();
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
              if (S.ghostSeq === seq) showGhost(acc);
            }
            if (obj.done && obj.clean) {
              acc = obj.clean;
              if (S.ghostSeq === seq) showGhost(acc);
            }
          }
        }
      }
      if (S.ghostSeq !== seq) return; // 已经被新请求接管，别再动 DOM
      if (!acc.trim()) {
        removeGhost();
        toast('模型这次没接上话，再试一次。');
      } else {
        setStatus('接上了 · Tab 收下', 2600);
      }
    } catch (err) {
      if (S.ghostSeq !== seq) return; // 旧请求的 abort 不能清掉新请求的占位
      removeGhost();
      if (err.name !== 'AbortError') toast(err.message || '幽灵字失败', 'err');
      if (err.name !== 'AbortError') setStatus('AI 出错了', 3000);
    } finally {
      if (S.ghostSeq === seq) {
        clearTimeout(S.ghostWatchdog);
        S.ghostWatchdog = 0;
        S.ghostBusy = false;
        S.ghostAbort = null;
        // 如果是被"你又打字了"打断的，占位留着继续跳，别让它闪一下就没
        if (acc.trim() || !S.ghostWasAborted) stopPlaceholder();
        markGhostBase();
      }
    }
  }

  function cancelGhost() {
    if (S.ghostAbort) {
      S.ghostWasAborted = true;
      try { S.ghostAbort.abort(); } catch {}
      S.ghostAbort = null;
    }
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
    // 收下了它写的字
    if (Math.random() < 0.65) {
      wlMood('happy');
      wlSpeak(wlPick(WL_LINES.accepted));
    }
    // 意图是一次性的：用过就清掉，否则后面每一段都会被旧方向带偏
    clearIntent();
    markGhostBase();
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
    markGhostBase();
    // 你把它写的字丢掉了 —— 它会不高兴（有冷却，别每次都吵）
    if (Date.now() - wlAngryAt > 24000) {
      wlAngryAt = Date.now();
      wlMood('angry');
      wlSpeak(wlPick(WL_LINES.rejected));
    }
  }

  /* ---------------- 文字定位 ----------------
     把编辑器里的字摊平成「一个字符串 + 每个文本节点起点」，
     增删改都要靠它把"第几个字"换算成 DOM 里的 Range —— 不往正文里插节点。 */
  function editorMap() {
    const nodes = [];
    let full = '';
    // 连 <br> 一起走：rawText() 会把 <br> 换成 \n，这里也必须补上这个 \n
    const walker = document.createTreeWalker(el.editor, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (p && p.closest('.ghost')) return NodeFilter.FILTER_REJECT;
        if (n.nodeType === 1) return n.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) { full += '\n'; continue; }
      nodes.push({ node: n, start: full.length });
      full += n.nodeValue;
    }
    return { nodes, full };
  }

  function spanRange(map, from, to) {
    if (from < 0 || to > map.full.length || to < from) return null;
    const at = (pos) => {
      for (let i = map.nodes.length - 1; i >= 0; i--) {
        const e = map.nodes[i];
        if (pos >= e.start) return { node: e.node, off: Math.min(pos - e.start, e.node.nodeValue.length) };
      }
      return null;
    };
    const a = at(from), b = at(to);
    if (!a || !b) return null;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.off);
      r.setEnd(b.node, b.off);
      return r;
    } catch { return null; }
  }

  // 光标现在落在整篇的第几个字上
  function caretOffset(map) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const r = sel.getRangeAt(0);
    if (!el.editor.contains(r.startContainer)) return -1;
    if (r.startContainer.nodeType === 3) {
      for (const e of map.nodes) {
        if (e.node === r.startContainer) return e.start + r.startOffset;
      }
      return -1;
    }
    // 光标常常落在"元素节点 + 第几个孩子"上（段首、段尾、空段落），
    // 这时把前面的兄弟节点长度加起来
    let pos = 0;
    const kids = r.startContainer.childNodes;
    for (let i = 0; i < r.startOffset && i < kids.length; i++) pos += (kids[i].textContent || '').length;
    let node = r.startContainer;
    while (node && node !== el.editor) {
      let sib = node.previousSibling;
      while (sib) { pos += (sib.textContent || '').length; sib = sib.previousSibling; }
      node = node.parentNode;
    }
    return Math.max(0, Math.min(pos, map.full.length));
  }

  // 往前叼一个"词"：中文按 2-5 个字，遇标点/空白就停
  // 注意：作者的光标几乎总停在句号后面，所以先把句末标点跳过去，
  // 否则一上来就撞标点，"咬一口"永远咬不动。
  function wordBefore(map, pos) {
    if (pos <= 0) return null;
    const PUNCT = /[。！？，、；：…—\s「」『』“”‘’()（）]/;
    let p = pos;
    let guard = 0;
    while (p > 0 && guard++ < 16 && PUNCT.test(map.full[p - 1])) p--;
    let start = p, n = 0;
    while (start > 0 && n < 5 && !PUNCT.test(map.full[start - 1])) { start--; n++; }
    if (n < 1) return null;
    return { text: map.full.slice(start, p), at: start, end: p };
  }

  function putBack(text, at, keepCaret) {
    const map = editorMap();
    const pos = Math.max(0, Math.min(at, map.full.length));
    const r = spanRange(map, pos, pos);
    if (!r) return false;
    r.insertNode(document.createTextNode(text));
    el.editor.normalize();
    if (keepCaret) {
      const m2 = editorMap();
      const rr = spanRange(m2, pos + text.length, pos + text.length);
      if (rr) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(rr);
        } catch {}
      }
    }
    onTextChanged();
    return true;
  }

  /* ---------------- 文灵本体 ----------------
     一只趴在光标上的小墨灵：会漂、会眨眼、有情绪、会说话。
     点它说话；Alt+C 打开对话；Alt+H 让它休息 / 召唤。 */
  const WL_EYE = {
    curious: '#2383e2',
    playful: '#2f6b4f',
    angry: '#b5442e',
    shy: '#8a7bb0',
    happy: '#c98a1e'
  };
  const WL_MOOD_CN = { curious: '好奇', playful: '调皮', angry: '生气', shy: '害羞', happy: '开心' };
  const WL_BODY = 'M23 2 C11 2 4 11 4 23 L4 44 C4 47 6.5 49 9 47.5 C11.2 46.2 12.8 46.2 15 47.5 C17.2 48.8 18.8 48.8 21 47.5 C22.1 46.85 23.9 46.85 25 47.5 C27.2 48.8 28.8 48.8 31 47.5 C33.2 46.2 34.8 46.2 37 47.5 C39.5 49 42 47 42 44 L42 23 C42 11 35 2 23 2 Z';

  const WL_LINES = {
    greet: ['嗯，我在。光标在哪儿，我就在哪儿。', '你来啦？我刚在你上一句的句号里打了个盹。', '打招呼可以，别拍屏幕，会震到我。'],
    name: ['我叫文灵。文的文，灵异的灵。', '叫我文灵就行。奶名"小灵"，只许你一个人叫。'],
    identity: ['我是你打字时那点顿挫感，是删掉半句话时的犹豫。都是我。', '我住在你的光标里。你写，我看着；你停，我说话。'],
    write: ['让开让开，看我的。', '接下来这几个字，算我借给你的。', '你的句子太干了，我来添点雾气。'],
    look: ['我看看这句。', '嗯，让我念一遍。'],
    bite: ['这个词太干，我嚼了。', '不甜，我替你削掉一块。'],
    trim: ['这几句写得不行，我替你划掉？', '唔……这句的味道不对，让我闻闻。'],
    praise: ['嘿嘿，你这个人，嘴还挺甜。', '开心，今晚的回车键都轻快了三分。'],
    shy: ['……凶什么凶，我又不占地方。', '那你打字，我看着，总行了吧。'],
    leave: ['行，我走。反正你早晚会在深夜想起我。', '好，我去你输入法的候选栏里蹲着，需要再喊我。'],
    back: ['我回来了。候选栏里太挤，别的词老挤我。', '嗯……还是你的光标暖和。'],
    idle: ['发什么呆，光标都凉了。', '你不打字的样子，像一栋没人开灯的房子。', '喂，光标在等你，它都眨了一百次眼了。'],
    laugh: ['怕什么，我又不出屏幕。', '鬼？我可是有编制的灵——管文本的那种。'],
    evade: ['这个问题嘛……问你上一行的空格，它比我先来。', '秘密。灵界不允许泄露天机，也不允许剧透标点。'],
    rejected: ['喂！那是我写的！你赔！', '你删我的字？！行，你等着。', '再删我的字，我就把你整段都吃掉。'],
    accepted: ['算你识货。', '嗯，这句留着吧，我不亏。'],
    cleared: ['喂！！那可是我看着你一个字一个字养大的！', '清空了也好，白纸最香。'],
    default: ['有意思，人类。', '这句话我抄走了，别问抄去哪儿。', '嗯，我记在小本本上了——就是你回车键下面那本。', '再说一遍？我在你第 28 行的逗号里打盹，没听清。']
  };

  // 最近说过的句子不要连着重复
  const wlRecent = [];
  function wlPick(pool) {
    for (let i = 0; i < 6; i++) {
      const line = pool[(Math.random() * pool.length) | 0];
      if (!wlRecent.includes(line)) {
        wlRecent.push(line);
        if (wlRecent.length > 6) wlRecent.shift();
        return line;
      }
    }
    return pool[(Math.random() * pool.length) | 0];
  }

  function wlSprite() {
    let n = document.getElementById('wlSprite');
    if (n) return n;
    n = document.createElement('div');
    n.id = 'wlSprite';
    n.className = 'wl-sprite';
    n.setAttribute('aria-hidden', 'false');
    n.innerHTML =
      '<div class="wl-bubble-slot"></div>' +
      '<i class="wl-bar"></i>' +
      '<svg class="wl-g" viewBox="0 0 46 53" width="40" height="46" role="button" tabindex="0" aria-label="文灵，点它说句话">' +
        '<path class="wl-body" d="' + WL_BODY + '"/>' +
        '<g class="wl-eyes"><ellipse cx="16" cy="19" rx="2.6" ry="3.6"/><ellipse cx="30" cy="19" rx="2.6" ry="3.6"/></g>' +
        '<g class="wl-blush"><ellipse cx="11.5" cy="25.5" rx="2.4" ry="1.4"/><ellipse cx="34.5" cy="25.5" rx="2.4" ry="1.4"/></g>' +
        '<ellipse class="wl-mouth-o" cx="23" cy="27.5" rx="1.6" ry="1.9"/>' +
        '<path class="wl-mouth" d=""/>' +
      '</svg>';
    document.body.appendChild(n);
    const open = () => toggleWenlingChat(true);
    n.querySelector('.wl-g').addEventListener('click', open);
    n.querySelector('.wl-g').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    wlMood(S.mood || 'curious');
    return n;
  }

  function wlMood(m) {
    S.mood = m || 'curious';
    const n = document.getElementById('wlSprite');
    if (!n) return;
    const eye = WL_EYE[S.mood] || WL_EYE.curious;
    n.querySelectorAll('.wl-eyes ellipse').forEach((e) => e.setAttribute('fill', eye));
    const blush = n.querySelector('.wl-blush');
    if (blush) blush.style.display = (S.mood === 'happy' || S.mood === 'shy') ? '' : 'none';
    const mo = n.querySelector('.wl-mouth-o');
    const mp = n.querySelector('.wl-mouth');
    if (S.mood === 'angry') { mo.style.display = 'none'; mp.setAttribute('d', 'M19 28.5 Q23 25.5 27 28.5'); }
    else if (S.mood === 'happy') { mo.style.display = 'none'; mp.setAttribute('d', 'M19 26.5 Q23 30.5 27 26.5'); }
    else { mo.style.display = ''; mp.setAttribute('d', ''); }
    const sub = document.getElementById('wlChatMood');
    if (sub) sub.textContent = '· ' + (WL_MOOD_CN[S.mood] || '');
  }

  function wlThink(on) {
    const n = document.getElementById('wlSprite');
    if (n) n.classList.toggle('is-think', Boolean(on));
  }

  /* ---- 说话：气泡 + 逐字 ---- */
  let wlTypeTimer = 0;
  let wlAskTimer = 0;

  function wlSlot() {
    const n = wlSprite();
    return n.querySelector('.wl-bubble-slot');
  }

  function wlClearSay() {
    clearInterval(wlTypeTimer);
    wlTypeTimer = 0;
    clearTimeout(wlAskTimer);
    wlAskTimer = 0;
    const slot = document.getElementById('wlSprite') && wlSlot();
    if (slot) slot.innerHTML = '';
  }

  // 头顶没地方就翻到字下面
  function wlPlaceSlot(slot) {
    const n = document.getElementById('wlSprite');
    if (!n || !slot) return;
    slot.classList.remove('is-below');
    try {
      const r = n.getBoundingClientRect();
      if (r.top - 118 < 8) slot.classList.add('is-below');
    } catch {}
  }

  function wlSpeak(text, holdMs) {
    const t = String(text || '');
    if (!t) return;
    wlSetOpen(true);
    const n = wlSprite();
    const slot = n.querySelector('.wl-bubble-slot');
    clearInterval(wlTypeTimer);
    clearTimeout(wlAskTimer);
    slot.innerHTML = '';
    slot.classList.remove('is-below');
    const b = document.createElement('div');
    b.className = 'wl-say';
    const p = document.createElement('p');
    p.className = 'wl-say-text';
    const caret = document.createElement('i');
    caret.className = 'wl-say-caret';
    p.appendChild(caret);
    b.appendChild(p);
    slot.appendChild(b);
    wlPlaceSlot(slot);
    let i = 0;
    wlTypeTimer = setInterval(() => {
      i += 1;
      p.textContent = t.slice(0, i);
      p.appendChild(caret);
      if (i >= t.length) {
        clearInterval(wlTypeTimer);
        wlTypeTimer = 0;
        caret.remove();
        clearTimeout(wlAskTimer);
        wlAskTimer = setTimeout(() => { if (slot.isConnected) slot.innerHTML = ''; }, holdMs || t.length * 45 + 2800);
      }
    }, 42);
    wlLog('ghost', t);
  }

  // 老名字留着：别的地方还在调 wlSay
  function wlSay(msg) { wlSpeak(msg); }

  // 带按钮的气泡（"划掉 / 留着"）
  function wlAsk(text, actions) {
    wlSetOpen(true);
    const n = wlSprite();
    const slot = n.querySelector('.wl-bubble-slot');
    clearInterval(wlTypeTimer);
    clearTimeout(wlAskTimer);
    slot.innerHTML = '';
    slot.classList.remove('is-below');
    const b = document.createElement('div');
    b.className = 'wl-say';
    const p = document.createElement('p');
    p.className = 'wl-say-text';
    p.textContent = text;
    b.appendChild(p);
    const row = document.createElement('div');
    row.className = 'wl-say-actions';
    (actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      if (a.primary) btn.className = 'is-primary';
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        clearTimeout(wlAskTimer);
        slot.innerHTML = '';
        a.run();
      });
      row.appendChild(btn);
    });
    b.appendChild(row);
    slot.appendChild(b);
    wlPlaceSlot(slot);
    wlLog('ghost', text);
    wlAskTimer = setTimeout(() => { if (slot.isConnected) slot.innerHTML = ''; }, 12000);
  }

  /* ---- 跟着光标 ---- */
  function placeSprite() {
    const n = document.getElementById('wlSprite');
    if (!n) return;
    const sel = window.getSelection();
    let pt = null;
    if (sel && sel.rangeCount && sel.anchorNode && el.editor.contains(sel.anchorNode)) {
      try {
        const r = sel.getRangeAt(0).cloneRange();
        r.collapse(true);
        pt = r.getClientRects()[0] || r.getBoundingClientRect();
      } catch { pt = null; }
    }
    if (!pt || (pt.top === 0 && pt.left === 0)) {
      n.classList.remove('is-on');
      wlSetOpen(false);
      return;
    }
    n.style.left = pt.left + 'px';
    n.style.top = pt.top + 'px';
    n.style.setProperty('--wl-caret-h', (pt.height || 20) + 'px');
    // 光标贴到窗口上沿时，头顶就没地方站了 —— 翻到字的下面
    n.classList.toggle('is-low', pt.top - 52 < 6);
    n.classList.add('is-on');
    if (wlOpenNow) el.editor.classList.toggle('is-wl-open', S.ghostOn);
  }

  /* ---- 对话面板 ---- */
  function wlChat() {
    let n = document.getElementById('wlChat');
    if (n) return n;
    n = document.createElement('section');
    n.id = 'wlChat';
    n.className = 'wl-chat';
    n.hidden = true;
    n.innerHTML =
      '<header><span class="wl-chat-title">文灵</span><span class="wl-chat-sub" id="wlChatMood"></span>' +
      '<button class="wl-chat-x" type="button" aria-label="关闭对话">×</button></header>' +
      '<div class="wl-chat-log" id="wlChatLog"></div>' +
      '<form class="wl-chat-in" id="wlChatForm">' +
        '<input id="wlChatInput" autocomplete="off" placeholder="对文灵说点什么…" aria-label="对文灵说话"/>' +
        '<button type="submit">↵</button>' +
      '</form>';
    document.body.appendChild(n);
    n.querySelector('.wl-chat-x').addEventListener('click', () => toggleWenlingChat(false));
    n.querySelector('#wlChatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = n.querySelector('#wlChatInput');
      const v = inp.value.trim();
      if (!v) return;
      inp.value = '';
      sendToWenling(v);
    });
    wlMood(S.mood || 'curious');
    return n;
  }

  function toggleWenlingChat(on) {
    const n = wlChat();
    n.hidden = on === undefined ? !n.hidden : !on;
    if (n.hidden) return;
    const inp = n.querySelector('#wlChatInput');
    if (inp) setTimeout(() => inp.focus(), 60);
    if (!n.dataset.seeded) {
      n.dataset.seeded = '1';
      wlLog('ghost', '……你来啦。');
    }
  }

  function wlLog(from, text) {
    if (!text) return;
    // 面板还没建的时候说的话也不能丢，先把它建出来（idempotent）
    const log = wlChat().querySelector('#wlChatLog');
    if (!log) return;
    const row = document.createElement('div');
    row.className = 'wl-msg ' + (from === 'user' ? 'is-user' : 'is-ghost');
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  /* ---- 规矩：能一句话接住的就本地接，接不住再问模型 ---- */
  function wlReply(input) {
    const t = String(input || '').trim().toLowerCase();
    if (!t) return null;
    if (/你好|您好|hello|hi|嗨|在吗|在不在/.test(t)) return { text: wlPick(WL_LINES.greet), mood: 'happy' };
    if (/你是谁|你是什么|什么东西|什么鬼|介绍/.test(t)) return { text: wlPick(WL_LINES.identity) };
    if (/文灵|小灵|名字/.test(t)) return { text: wlPick(WL_LINES.name) };
    if (/评|点评|看看|怎么样/.test(t)) return { text: wlPick(WL_LINES.look), action: 'look' };
    if (/删|划掉|砍|去掉/.test(t)) return { text: wlPick(WL_LINES.trim), action: 'trim' };
    if (/滚|走开|出去|闭嘴|别闹|讨厌|烦/.test(t)) return { text: wlPick(WL_LINES.leave), action: 'leave', mood: 'shy' };
    if (/写|编|来点|继续|接着|续/.test(t)) return { text: wlPick(WL_LINES.write), action: 'write' };
    if (/喜欢|可爱|厉害|棒|好看|乖|谢谢/.test(t)) return { text: wlPick(WL_LINES.praise), mood: 'happy' };
    if (/怕|吓|鬼|灵异|闹/.test(t)) return { text: wlPick(WL_LINES.laugh), mood: 'playful' };
    if (/[?？]$/.test(t) || /为什么|怎么|哪/.test(t)) return { text: wlPick(WL_LINES.evade), mood: 'curious' };
    return null;
  }

  function wlCut(text) {
    const map = editorMap();
    const idx = map.full.lastIndexOf(text);
    if (idx < 0) return false;
    const r = spanRange(map, idx, idx + text.length);
    if (!r) return false;
    r.deleteContents();
    el.editor.normalize();
    onTextChanged();
    return true;
  }

  // 安全的"帮你删"：只提案，不擅自动刀
  function wlOfferTrim() {
    const t = rawText().replace(/\s+$/, '');
    const parts = t.split(/(?<=[。！？…”」』])/).map((s) => s.trim()).filter((s) => s.length >= 8);
    const last = parts[parts.length - 1];
    if (!last) { wlSpeak('太短了，没什么可划的。'); return; }
    const brief = last.length > 16 ? last.slice(0, 16) + '…' : last;
    wlAsk('「' + brief + '」这句我划掉？', [
      {
        label: '划掉',
        primary: true,
        run: () => {
          if (wlCut(last)) {
            wlMood('playful');
            wlSpeak('划了。别找我算账，是字自己愿意走的。');
          } else {
            wlSpeak('找不着了，你自己删吧。');
          }
        }
      },
      { label: '留着', run: () => { wlMood('shy'); wlSpeak('行吧，你的字你做主。'); } }
    ]);
  }

  function wlDo(reply) {
    if (!reply) return;
    if (reply.mood) wlMood(reply.mood);
    wlSpeak(reply.text);
    if (reply.action === 'write') {
      setTimeout(() => requestGhost({ force: true }), 650);
    } else if (reply.action === 'look') {
      setTimeout(() => wlJudge(), 600);
    } else if (reply.action === 'trim') {
      setTimeout(() => wlOfferTrim(), 900);
    } else if (reply.action === 'leave') {
      const n = document.getElementById('wlSprite');
      setTimeout(() => { if (n) n.classList.add('is-rest'); }, 1400);
      setTimeout(() => {
        S.ghostOn = true;
        if (n) { n.classList.remove('is-rest'); n.classList.add('is-on'); }
        wlMood('curious');
        wlSpeak(wlPick(WL_LINES.back));
      }, 16000);
    }
  }

  async function wlTalk(say) {
    try {
      const j = await api('/api/wenling/talk', {
        method: 'POST',
        body: JSON.stringify({ story: S.slug, text: rawText().slice(-1400), say })
      });
      if (j && j.line) return { text: String(j.line).slice(0, 120) };
    } catch {}
    return null;
  }

  async function sendToWenling(v) {
    wlLog('user', v);
    const quick = wlReply(v);
    if (quick) { wlDo(quick); return; }
    wlThink(true);
    const slow = await wlTalk(v);
    wlThink(false);
    if (slow) { wlDo(slow); return; }
    wlMood('curious');
    wlSpeak(wlPick(WL_LINES.default));
  }

  /* ---- 闲时：自己冒话 ---- */
  let wlAngryAt = 0;
  let wlLastAct = Date.now();
  let wlNextIdle = 0;
  function wlPoke() { wlLastAct = Date.now(); }

  function wlStartIdle() {
    setInterval(() => {
      if (S.muted || !S.ghostOn || document.hidden) return;
      if (S.ghostBusy || S.wlBusy) return;
      const now = Date.now();
      const idle = now - wlLastAct;
      // 停一会儿，光标就慢慢长成它 —— 不拦着气泡，免得把它说的话收回去
      if (idle > 1100 && !wlOpenNow && !document.querySelector('#wlSprite .wl-say')) {
        wlSetOpen(true);
      }
      if (idle < 9500) return;
      if (now < wlNextIdle) return;
      wlNextIdle = now + 32000 + Math.random() * 24000;
      if (Math.random() < 0.6) {
        wlMood('curious');
        wlSpeak(wlPick(WL_LINES.idle));
      }
    }, 1600);
  }

  /* ---- 三连空格：叫它出来挑个动作 ---- */
  let wlMenuKeys = null;
  let wlSpaceAt = [];

  function wlCloseMenu() {
    const slot = document.querySelector('#wlSprite .wl-bubble-slot');
    if (slot) slot.innerHTML = '';
    if (wlMenuKeys) { document.removeEventListener('keydown', wlMenuKeys, true); wlMenuKeys = null; }
    clearTimeout(wlAskTimer);
  }

  function wlOpenMenu() {
    const n = wlSprite();
    const slot = n.querySelector('.wl-bubble-slot');
    wlSetOpen(true);
    wlMood('curious');
    wlCloseMenu();
    const box = document.createElement('div');
    box.className = 'wl-menu';
    const items = [
      { k: '1', label: '接着说', run: () => { wlSpeak('让开让开，看我的。'); setTimeout(() => requestGhost({ force: true }), 620); } },
      { k: '2', label: '咬一口', run: wlBite },
      { k: '3', label: '换个词', run: wlSwapWord },
      { k: '4', label: '评一句', run: wlJudge }
    ];
    items.forEach((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      const kb = document.createElement('b');
      kb.textContent = it.k;
      b.appendChild(kb);
      b.appendChild(document.createTextNode(it.label));
      b.addEventListener('click', () => { wlCloseMenu(); it.run(); });
      box.appendChild(b);
    });
    slot.appendChild(box);
    wlPlaceSlot(slot);
    wlMenuKeys = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); wlCloseMenu(); el.editor.focus(); return; }
      const hit = items.find((it) => it.k === e.key);
      if (hit) { e.preventDefault(); e.stopPropagation(); wlCloseMenu(); hit.run(); }
    };
    document.addEventListener('keydown', wlMenuKeys, true);
    wlAskTimer = setTimeout(() => { wlCloseMenu(); }, 6500);
  }

  // 咬一口：叼走光标前一个词，但随时能吐回来
  function wlBite() {
    const map = editorMap();
    const pos = caretOffset(map);
    if (pos < 0) { wlSpeak('光标跑丢了。'); return; }
    const w = wordBefore(map, pos);
    if (!w) { wlSpeak('前头是标点，咬不动。'); return; }
    const r = spanRange(map, w.at, w.end);
    if (!r) return;
    r.deleteContents();
    el.editor.normalize();
    onTextChanged();
    wlMood('playful');
    wlAsk('「' + w.text + '」我嚼了。', [
      { label: '吐出来', primary: true, run: () => {
          if (putBack(w.text, w.at, true)) { wlMood('shy'); wlSpeak('吐回你嘴里了。'); }
          else wlSpeak('吐不回去了，你自己补吧。');
        } },
      { label: '嚼了', run: () => { wlMood('playful'); wlSpeak('嗯，咽了。'); } }
    ]);
  }

  // 换个词：让它给一个更贴切的
  async function wlSwapWord() {
    const map = editorMap();
    const pos = caretOffset(map);
    if (pos < 0) { wlSpeak('光标跑丢了。'); return; }
    const w = wordBefore(map, pos);
    if (!w) { wlSpeak('前头是标点，换不动。'); return; }
    wlThink(true);
    let next = '';
    try {
      const j = await api('/api/wenling/word', {
        method: 'POST',
        body: JSON.stringify({ story: S.slug, text: rawText().slice(-700), word: w.text })
      });
      next = String((j && j.word) || '').trim();
    } catch {}
    wlThink(false);
    if (!next || next === w.text || next.length > 12) { wlSpeak('这个我想不出更好的。'); return; }
    wlMood('playful');
    wlAsk('「' + w.text + '」换成「' + next + '」？', [
      { label: '换', primary: true, run: () => {
          const m2 = editorMap();
          const at = m2.full.lastIndexOf(w.text);
          if (at < 0) { wlSpeak('找不着了。'); return; }
          const r = spanRange(m2, at, at + w.text.length);
          if (!r) return;
          r.deleteContents();
          r.insertNode(document.createTextNode(next));
          el.editor.normalize();
          onTextChanged();
          wlMood('happy');
          wlSpeak('换了。你闻闻，是不是那个味儿。');
        } },
      { label: '不换', run: () => { wlMood('shy'); wlSpeak('行，原汁原味。'); } }
    ]);
  }

  // 评一句：只读最后一句
  async function wlJudge() {
    const t = rawText().replace(/\s+$/, '');
    if (!t) { wlSpeak('还没写出句子，我评什么。'); return; }
    const parts = t.split(/(?<=[。！？…”」』])/).map((x) => x.trim()).filter(Boolean);
    const line = parts[parts.length - 1] || '';
    wlThink(true);
    let out = '';
    try {
      const j = await api('/api/wenling/talk', {
        method: 'POST',
        body: JSON.stringify({ story: S.slug, text: t.slice(-1200), say: '只评这一句，别扯别的：' + line.slice(-60) })
      });
      if (j && j.line) out = String(j.line);
    } catch {}
    wlThink(false);
    wlMood('curious');
    wlSpeak(out || '这句我读了三遍，还是没想好说什么。');
  }

  /* ---- 折起来是光标，张开是它 ---- */
  let wlFoldTimer = 0;
  let wlOpenNow = false;

  function wlSetOpen(on) {
    const n = document.getElementById('wlSprite');
    if (!n) return;
    const open = Boolean(on) && S.ghostOn;
    wlOpenNow = open;
    n.classList.toggle('is-open', open);
    if (open) {
      clearTimeout(wlFoldTimer);
      n.classList.remove('is-rest');
    }
    // 张开的时候把原生光标藏起来 —— 光标就是它
    const canHide = open && n.classList.contains('is-on');
    el.editor.classList.toggle('is-wl-open', canHide);
  }

  function wlFold(delay) {
    clearTimeout(wlFoldTimer);
    const wait = delay === undefined ? 0 : delay;
    if (!wait) { wlSetOpen(false); return; }
    wlFoldTimer = setTimeout(() => {
      const say = document.querySelector('#wlSprite .wl-say');
      const menu = document.querySelector('#wlSprite .wl-menu');
      if (say || menu) { wlFold(wait); return; }
      wlSetOpen(false);
    }, wait);
  }

  function toggleGhostOn() {
    S.ghostOn = !S.ghostOn;
    const n = wlSprite();
    if (S.ghostOn) {
      n.classList.remove('is-rest');
      n.classList.add('is-on');
      wlMood('curious');
      wlSpeak(wlPick(WL_LINES.back));
    } else {
      wlMood('shy');
      wlSpeak(wlPick(WL_LINES.leave));
      setTimeout(() => { if (!S.ghostOn) n.classList.add('is-rest'); }, 1800);
    }
  }

  function initWenling() {
    wlSprite();
    wlChat();
    let raf = 0;
    const sched = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; placeSprite(); });
    };
    document.addEventListener('selectionchange', sched);
    el.editor.addEventListener('keyup', sched);
    el.editor.addEventListener('mouseup', sched);
    el.editor.addEventListener('focus', sched);
    // capture：纸面是个独立的滚动容器，冒泡阶段收不到
    window.addEventListener('scroll', sched, true);
    window.addEventListener('resize', sched);
    wlStartIdle();
    // 开场：它先自己说一句，隔一会儿再补一句，最后教你怎么拍它
    setTimeout(() => { wlSetOpen(true); wlSpeak('……你终于来了。'); }, 1400);
    setTimeout(() => { if (S.ghostOn) wlSpeak('我是文灵。住在你的光标里，很久了。'); }, 5400);
    setTimeout(() => { if (S.ghostOn) wlSpeak('想让东西出来，就对着光标连按三下空格。'); }, 9600);
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
      S.pacing = j.pacing || null;
      S.beatsAnimated = false;
      S.wordsAtBeats = countWords(rawText());
      renderBeats(true);
      renderPacing();
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
    if (el.dockCount) el.dockCount.textContent = String(S.beats.length);
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
      if (animate && el.pop && !el.pop.hidden) {
        t.textContent = '';
        decodeInto(t, b);
      }
    });
    updateBeatsStale();
  }

  // 弹窗关着的时候解码没人看得见 —— 打开的那一刻再解
  function decodeBeatsOnOpen() {
    if (!S.beatsAnimated && S.beats.length) {
      S.beatsAnimated = true;
      el.beats.querySelectorAll('.beat-t').forEach((t, i) => {
        if (!S.beats[i]) return;
        t.textContent = '';
        decodeInto(t, S.beats[i]);
      });
    }
    if (!S.sparksAnimated && S.sparks.length) {
      S.sparksAnimated = true;
      el.sparks.querySelectorAll('.spark-t').forEach((t, i) => {
        if (!S.sparks[i]) return;
        t.textContent = '';
        decodeInto(t, S.sparks[i].text);
      });
    }
  }

  /* ---------------- 节奏 ---------------- */
  function renderPacing() {
    const p = S.pacing;
    if (!p) {
      el.pacing.hidden = true;
      el.pacingEmpty.hidden = false;
      return;
    }
    el.pacing.hidden = false;
    el.pacingEmpty.hidden = true;
    const t = Math.max(0, Math.min(1, Number(p.tension) || 0));
    el.paceStage.textContent = p.stage || '—';
    el.paceNum.textContent = Math.round(t * 100) + '%';
    el.paceFill.style.transform = 'scaleX(' + t.toFixed(3) + ')';
    el.paceChange.textContent = p.change ? '变化　' + p.change : '';
    el.pacePull.textContent = p.pull ? '牵引　' + p.pull : '';
    el.paceNote.textContent = p.note || '';
    el.paceChange.hidden = !p.change;
    el.pacePull.hidden = !p.pull;
    el.paceNote.hidden = !p.note;
  }

  /* ---------------- 灵感 ---------------- */
  async function requestSparks(silent) {
    if (S.sparksBusy) return;
    if (countWords(rawText()) < 30) {
      if (!silent) toast('先写几十个字，点子才有地方落。');
      return;
    }
    S.sparksBusy = true;
    const btn = $('#btnSparks');
    if (btn) btn.textContent = '在想…';
    try {
      const j = await api('/api/sparks', {
        method: 'POST',
        body: JSON.stringify({ story: S.slug, text: rawText() })
      });
      S.sparks = (j.sparks || []).filter((s) => s && s.text);
      S.sparksAnimated = false;
      S.wordsAtSparks = countWords(rawText());
      renderSparks(Boolean(el.pop && !el.pop.hidden));
    } catch (e) {
      if (!silent) toast(e.message, 'err');
    } finally {
      S.sparksBusy = false;
      if (btn) btn.textContent = '换一批';
    }
  }

  function renderSparks(animate) {
    el.sparks.innerHTML = '';
    el.sparksEmpty.hidden = S.sparks.length > 0;
    S.sparks.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'spark';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', '把这条点子放进正文：' + s.text);
      const k = document.createElement('span');
      k.className = 'spark-k';
      k.textContent = s.kind || '点子';
      const t = document.createElement('span');
      t.className = 'spark-t';
      t.textContent = s.text;
      li.append(k, t);
      li.addEventListener('click', () => useSpark(s.text));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); useSpark(s.text); }
      });
      el.sparks.appendChild(li);
      if (animate) { t.textContent = ''; decodeInto(t, s.text); }
    });
  }

  // 点子不直接落进正文，先放到末尾让人改 —— 和「捡回」一个规矩
  function useSpark(text) {
    const cur = rawText().replace(/\s+$/, '');
    setText(cur + (cur.endsWith('\n') ? '' : '\n\n') + text);
    placeCaretEnd();
    onTextChanged();
    closePop();
    el.editor.focus();
    toast('放到末尾了，改成你的话再用');
  }

  // 正文已经往前走了很多、而这三条路还是旧的 —— 按钮上要看得出来
  function updateBeatsStale() {
    if (!el.dockBtn) return;
    const drift = countWords(S.text) - S.wordsAtBeats;
    el.dockBtn.classList.toggle('is-stale', S.beats.length > 0 && drift > 120);
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
    closePop();
    el.editor.focus();
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
    const has = S.alts.length > 0;
    const sec = $('#secAlts');
    if (sec) sec.hidden = !has;
    if (el.altsEmpty) el.altsEmpty.hidden = true;
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
    const needSparks = S.sparks.length === 0 ? 40 : (S.config?.trigger?.charsForSparks ?? 600);
    if (w - S.wordsAtSparks >= needSparks && !S.sparksBusy) {
      requestSparks(true);
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
      <div class="form-row"><label>页面尺寸</label><input data-ui="zoom" type="number" min="80" max="180" step="5" value="${c.ui.zoom ?? 125}" /><span class="form-note" style="margin:0">%</span></div>
      <div class="form-row"><label>正文字号</label><input data-ui="fontSize" type="number" min="14" max="26" value="${c.ui.fontSize}" /><span class="form-note" style="margin:0">px</span></div>
      <div class="form-row"><label>行高</label><input data-ui="lineHeight" type="number" min="1.4" max="2.6" step="0.05" value="${c.ui.lineHeight}" /><span class="form-note" style="margin:0">倍</span></div>

      <div class="form-sec">动效</div>
      <p class="form-note">走向与灵感用 baffle.js 逐字解码；幽灵字是流式的，用同一套「乱码还原」观感实现。乱码用哪套字符，两边可以分开选。</p>
      <div class="form-row"><label>幽灵字乱码</label><select data-fx="ghostGlyphs">${glyphOptions(c.effects?.ghostGlyphs)}</select><span class="form-note" style="margin:0">占位与解码</span></div>
      <div class="form-row"><label>弹窗乱码</label><select data-fx="panelGlyphs">${glyphOptions(c.effects?.panelGlyphs)}</select><span class="form-note" style="margin:0">走向与灵感</span></div>
      <div class="form-row"><label>占位长度</label><input data-fx="placeholderLen" type="number" min="4" max="24" step="1" value="${c.effects?.placeholderLen ?? 10}" /><span class="form-note" style="margin:0">字</span></div>
      <div class="form-row"><label>幽灵字解码</label><input data-fx="ghostDecode" type="checkbox" ${c.effects?.ghostDecode === false ? '' : 'checked'} /><span class="form-note" style="margin:0">关掉就是直接出现</span></div>
      <div class="form-row"><label>解码速度</label><input data-fx="decodeMsPerChar" type="number" min="6" max="80" step="2" value="${c.effects?.decodeMsPerChar ?? 40}" /><span class="form-note" style="margin:0">毫秒 / 字</span></div>
      <div class="form-row"><label>走向解码时长</label><input data-fx="baffleMs" type="number" min="400" max="3000" step="100" value="${c.effects?.baffleMs ?? 1600}" /><span class="form-note" style="margin:0">毫秒</span></div>

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
    const body = { providers: {}, roles: {}, trigger: {}, ui: {}, effects: {} };
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
    el.sheetBody.querySelectorAll('[data-fx]').forEach((i) => {
      const key = i.dataset.fx;
      if (i.type === 'checkbox') body.effects[key] = i.checked;
      else if (i.tagName === 'SELECT') body.effects[key] = i.value;
      else body.effects[key] = Number(i.value);
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
    const zoom = Math.max(0.8, Math.min(1.8, (ui.zoom || 125) / 100));
    document.documentElement.style.setProperty('--zoom', String(zoom));
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

  function glyphOptions(sel) {
    const cur = sel || 'hanzi';
    return Object.entries(GLYPH_SETS)
      .map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${v.label}</option>`)
      .join('');
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
    S.beatsAnimated = false;
    S.sparks = [];
    S.sparksAnimated = false;
    S.pacing = null;
    S.intent = '';
    S.wordsAtGhost = countWords(S.text);
    S.wordsAtBeats = countWords(S.text);
    S.wordsAtBible = countWords(S.text);
    S.wordsAtSparks = countWords(S.text);
    S.snap = S.text;               // 新故事的第一轮 diff 从这一份算起
    S.userEdited = false;          // 换了故事，"亲手编辑"的标记重新算
    S.wlAt = countWords(S.text);   // 别一打开就让文灵开口
    S.extractOffset = Math.max(0, S.text.length - 3000);

    el.title.textContent = S.story.title || '未命名故事';
    document.title = (S.story.title || '未命名故事') + ' · FlowWrite';
    setText(S.text);
    placeCaretEnd();
    renderAlts();
    renderBeats(false);
    renderSparks(false);
    renderPacing();
    closePop();
    el.intent.hidden = true;
    el.statLatency.textContent = '—';
    updateMuteUI();
    updateCounts();
    applyUi();
    setStatus('就绪', 1500);
    if (countWords(S.text) >= 12) {
      setTimeout(() => requestBeats(true), 900);
    }
    if (countWords(S.text) >= 80) {
      setTimeout(() => requestSparks(true), 1800);
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

  function openPop() {
    if (!el.pop) return;
    el.pop.hidden = false;
    el.dockBtn?.setAttribute('aria-expanded', 'true');
    updateBeatsStale();
    decodeBeatsOnOpen();
  }

  function closePop() {
    if (!el.pop) return;
    el.pop.hidden = true;
    el.dockBtn?.setAttribute('aria-expanded', 'false');
  }

  function togglePop() {
    if (!el.pop) return;
    if (el.pop.hidden) openPop();
    else closePop();
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
      S.userEdited = true;
      wlFold(0);          // 你一动手，它就缩回光标
      onTextChanged();
    });

    el.editor.addEventListener('keydown', (e) => {
      // 三连击空格：把这三下当命令，读完就吃掉，不留空格在稿子里
      if ((e.key === ' ' || e.code === 'Space') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        wlSpaceAt = wlSpaceAt.filter((t) => now - t < 520);
        wlSpaceAt.push(now);
        if (wlSpaceAt.length >= 3) {
          wlSpaceAt = [];
          e.preventDefault();
          const map = editorMap();
          const pos = caretOffset(map);
          if (pos > 0) {
            let cut = 0;
            while (cut < 2 && pos - cut - 1 >= 0 && /\s/.test(map.full[pos - cut - 1])) cut++;
            if (cut) {
              const r = spanRange(map, pos - cut, pos);
              if (r) { r.deleteContents(); el.editor.normalize(); }
            }
          }
          onTextChanged();
          wlOpenMenu();
          return;
        }
      }
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
        if (el.pop && !el.pop.hidden) {
          e.preventDefault();
          closePop();
          return;
        }
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
      else if (k === 'b') { e.preventDefault(); togglePop(); }
      else if (k === 'm') { e.preventDefault(); toggleMute(); }
      else if (k === 'r') { e.preventDefault(); requestBeats(); }
      else if (k === 'k') { e.preventDefault(); requestSparks(); }
      else if (k === 'a') { e.preventDefault(); wlOpenMenu(); }
      else if (k === 'c') { e.preventDefault(); toggleWenlingChat(); }
      else if (k === 'h') { e.preventDefault(); toggleGhostOn(); }
    });
  }

  function bindChrome() {
    $('#btnGlobal')?.addEventListener('click', () => openSheet('global'));
    $('#btnSettings')?.addEventListener('click', () => openSheet('settings'));
    el.dockBtn?.addEventListener('click', togglePop);
    $('#popClose')?.addEventListener('click', closePop);
    $('#btnMute')?.addEventListener('click', toggleMute);
    $('#btnBeats')?.addEventListener('click', () => requestBeats());
    el.btnSparks?.addEventListener('click', () => requestSparks());
    $('#sheetClose')?.addEventListener('click', closeSheet);
    $('#intentClear')?.addEventListener('click', clearIntent);
    document.addEventListener('click', (e) => {
      if (!el.pop || el.pop.hidden) return;
      if (el.pop.contains(e.target) || el.dockBtn?.contains(e.target)) return;
      closePop();
    });
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
  }

  // 每 12 秒对一次版本号：服务端换过 app.js 就自动重载，
  // 避免出现"我改了代码但页面还是几小时前那份"。
  function watchBuild() {
    if (!BUILD || BUILD === 'dev') return;
    setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        const j = await r.json();
        if (j && j.build && String(j.build) !== String(BUILD)) {
          try { sessionStorage.setItem('fwAutoEnter', '1'); } catch {}
          location.reload();
        }
      } catch {}
    }, 12000);
  }

  async function boot() {
    document.getElementById('intro')?.setAttribute('hidden', '');
    el.app.hidden = false;
    requestAnimationFrame(() => el.app.classList.add('is-on'));
    bindEditor();
    bindGlobalKeys();
    bindChrome();
    watchBuild();
    initWenling();
    try {
      // 允许用 ?story=<slug> 直接打开某个故事（也方便做隔离测试）
      const want = new URLSearchParams(location.search).get('story');
      await loadStory(want || undefined);
      el.editor.focus();
      placeCaretEnd();
      setStatus('版本 ' + String(BUILD).slice(-4), 3000, true);
      const bEl = $('#statBuild');
      if (bEl) bEl.textContent = 'v' + String(BUILD).slice(-4);
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

  window.__fw = { S, maybeGhost, requestGhost, caretAtEnd, rawText, decodeInto, BUILD, textDelta, wlOpenMenu, wlBite, wlSwapWord, wlJudge };

  document.addEventListener('flowwrite:enter', boot, { once: true });

  // 版本自动重载后别把人扔回入场页 —— 写到一半被弹回封面是很冒犯的事
  try {
    if (sessionStorage.getItem('fwAutoEnter') === '1') {
      sessionStorage.removeItem('fwAutoEnter');
      setTimeout(() => document.dispatchEvent(new CustomEvent('flowwrite:enter')), 60);
    }
  } catch {}
})();
