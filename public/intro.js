/* 入场：量化线场
   把一个字形拆成 60x60 的亮度表，再用四档竖线重新画出来。
   噪声按 seed 7319 流动，不调用 Math.random。 */
(function () {
  const intro = document.getElementById('intro');
  const canvas = document.getElementById('introCanvas');
  const copy = document.querySelector('.intro-copy');
  const bar = document.getElementById('introBar');
  const enterBtn = document.getElementById('enterBtn');
  if (!intro || !canvas) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) {
    intro.querySelector('.intro-copy')?.classList.add('is-on');
    return;
  }

  const COLS = 60;
  const ROWS = 60;
  const SEGS = 30;
  const W4 = [0.38, 1.12, 2.28, 3.8];
  const A4 = [0.15, 0.64, 0.93, 1];
  const INK = '#202220';
  const SEED = 3;
  const ASSEMBLE = 1500;

  let luma = null;
  let startedAt = 0;
  let leaving = false;
  let leaveAt = 0;
  let raf = 0;
  let dprCache = 0;
  let W = 0;
  let H = 0;

  /* ---- 共享噪声表：xorshift，seed 7319 ---- */
  const N = 128;
  const table = new Float32Array(N * N);
  (function seedTable() {
    let s = 7319 | 0;
    for (let i = 0; i < N * N; i++) {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      table[i] = ((s >>> 0) / 4294967295) * 2 - 1;
    }
  })();

  const smooth = (t) => t * t * (3 - 2 * t);

  function noise2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = smooth(x - xi);
    const v = smooth(y - yi);
    const x0 = ((xi % N) + N) % N;
    const x1 = (x0 + 1) % N;
    const y0 = ((yi % N) + N) % N;
    const y1 = (y0 + 1) % N;
    const a = table[y0 * N + x0];
    const b = table[y0 * N + x1];
    const c = table[y1 * N + x0];
    const d = table[y1 * N + x1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  /* ---- 只采样一次 ---- */
  function buildLuma(text) {
    const cellPx = 5;
    const w = COLS * cellPx;
    const h = ROWS * cellPx;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    const family = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';
    let size = h * 0.74;
    g.font = `800 ${size}px ${family}`;
    const m = g.measureText(text);
    if (m.width > w * 0.9) {
      size = (size * w * 0.9) / m.width;
      g.font = `800 ${size}px ${family}`;
    }
    g.fillText(text, w / 2, h / 2);

    const data = g.getImageData(0, 0, w, h).data;
    const out = new Float32Array(COLS * ROWS);
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        let sum = 0;
        for (let y = 0; y < cellPx; y++) {
          for (let x = 0; x < cellPx; x++) {
            const p = ((cy * cellPx + y) * w + (cx * cellPx + x)) * 4;
            sum += (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
          }
        }
        out[cy * COLS + cx] = sum / (cellPx * cellPx);
      }
    }
    off.width = 0;
    off.height = 0;
    return out;
  }

  function measure() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    dprCache = dpr;
  }

  function draw(time, now) {
    if (dprCache !== Math.min(window.devicePixelRatio || 1, 2.5)) measure();
    const dpr = dprCache;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const copyH = copy ? copy.offsetHeight : 200;
    const padBottom = H * 0.09;
    const areaH = Math.max(120, H - padBottom - copyH - 56);
    const fieldSize = Math.min(W * 0.46, areaH);
    const cell = fieldSize / COLS;
    const ox = (W - fieldSize) / 2;
    const oy = 32 + (areaH - fieldSize) * 0.42;
    const segH = cell * 2 - 1.1;

    const elapsed = (now - startedAt) / 1000;
    const assemble = reduced ? 1 : Math.min(1, (now - startedAt) / ASSEMBLE);
    const cutoff = assemble * (SEGS + 2);

    let fade = 1;
    if (leaving) {
      const p = Math.min(1, (now - leaveAt) / 420);
      fade = 1 - p;
      ctx.save();
      ctx.translate(W / 2, oy + fieldSize / 2);
      ctx.scale(1, 1 - p * 0.92);
      ctx.translate(-W / 2, -(oy + fieldSize / 2));
    }

    const buckets = [[], [], [], []];
    for (let col = 0; col < COLS; col++) {
      for (let r = 0; r < SEGS; r++) {
        if (r > cutoff) continue;
        const b0 = luma[(r * 2) * COLS + col];
        const b1 = luma[(r * 2 + 1) * COLS + col];
        let b = (b0 + b1) / 2;
        const n = noise2(col * 0.15 + SEED, r * 0.16 - elapsed * 0.17);
        b = b * 0.94 + n * 0.12 * (0.25 + b * 0.75);
        b = Math.pow(Math.max(0, Math.min(1, b)), 1.2);
        const lv = b < 0.12 ? 0 : b < 0.42 ? 1 : b < 0.89 ? 2 : 3;
        const x = ox + col * cell + cell / 2;
        const y = oy + r * cell * 2;
        buckets[lv].push(x, y);
      }
    }

    for (let lv = 0; lv < 4; lv++) {
      const arr = buckets[lv];
      if (!arr.length) continue;
      ctx.globalAlpha = A4[lv] * fade * (0.25 + 0.75 * assemble);
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(
        0.4,
        Math.min(W4[lv] * (cell / 5.25) * 0.84, cell * 0.66) * (0.35 + 0.65 * assemble)
      );
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 2) {
        ctx.moveTo(arr[i], arr[i + 1] + 0.55);
        ctx.lineTo(arr[i], arr[i + 1] + segH);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (leaving) ctx.restore();

    if (bar) bar.style.transform = `scaleX(${Math.min(1, assemble).toFixed(3)})`;
  }

  function frame(now) {
    draw(now, now);
    if (!leaving) raf = requestAnimationFrame(frame);
    else if (now - leaveAt < 460) raf = requestAnimationFrame(frame);
    else raf = 0;
  }

  let done = false;
  function enter() {
    if (done) return;
    done = true;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onDocClick, true);
    if (reduced) {
      intro.hidden = true;
      boot();
      return;
    }
    leaving = true;
    leaveAt = performance.now();
    intro.classList.add('is-leaving');
    setTimeout(() => {
      intro.hidden = true;
      boot();
    }, 430);
  }

  function onKey(e) {
    if (e.key === 'Tab') return;
    e.preventDefault();
    enter();
  }
  function onDocClick(e) {
    if (e.target.closest('a')) return;
    if (e.target === enterBtn || enterBtn.contains(e.target)) return;
    enter();
  }

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    document.dispatchEvent(new CustomEvent('flowwrite:enter'));
  }

  function init() {
    luma = buildLuma('写');
    if (!luma) {
      copy?.classList.add('is-on');
      return;
    }
    measure();
    startedAt = performance.now();
    raf = requestAnimationFrame(frame);

    setTimeout(() => copy?.classList.add('is-on'), reduced ? 0 : 620);
    setTimeout(() => {
      if (bar) bar.style.transform = 'scaleX(1)';
    }, ASSEMBLE);

    enterBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      enter();
    });
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('resize', () => {
      measure();
      if (!raf) draw(0, performance.now());
    });

    if (reduced) {
      draw(0, performance.now());
      copy?.classList.add('is-on');
    }
  }

  // 字体可能还没就绪，等一轮再采样
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(init).catch(init);
  } else {
    init();
  }
})();
