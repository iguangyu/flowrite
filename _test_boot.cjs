/* 整页端到端：连真实服务加载页面 -> 进场 -> 三连空格叫出文灵
   用临时故事 zz-boot，跑完就删，绝不碰用户的稿子。 */
const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = 'http://127.0.0.1:4799';
const SLUG = 'zz-boot';
const STORY_DIR = path.join('C:/Users/lgy/FlowWrite', SLUG);

let fails = 0;
const ok = (c, m, extra) => {
  if (c) console.log('  [OK] ' + m);
  else { fails++; console.log('  [FAIL] ' + m + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 建临时故事 ----
  await fetch(BASE + '/api/stories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: SLUG })
  });
  await fetch(BASE + '/api/manuscript', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story: SLUG, text: '他推了推那台收音机，外壳边角磨得发亮。' })
  });

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));

  const dom = await JSDOM.fromURL(BASE + '/?story=' + SLUG, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => null;
      // jsdom 不做排版，getClientRects 恒为空 —— 给光标一个假位置，模拟真实布局
      const RECT = { left: 120, top: 240, width: 0, height: 20, right: 120, bottom: 260, x: 120, y: 240 };
      window.Range.prototype.getClientRects = function () { return [RECT]; };
      window.Range.prototype.getBoundingClientRect = function () { return RECT; };
      window.Element.prototype.getBoundingClientRect = function () {
        return { left: 120, top: 194, width: 40, height: 46, right: 160, bottom: 240, x: 120, y: 194 };
      };
      // jsdom 不带 fetch，桥到 Node 的原生 fetch（相对路径补成绝对）
      window.fetch = (input, init) => {
        const u = String(input && input.url ? input.url : input);
        return fetch(u.startsWith('http') ? u : BASE + u, init);
      };
    }
  });

  const { window } = dom;
  const doc = window.document;

  await sleep(400);
  doc.dispatchEvent(new window.CustomEvent('flowwrite:enter'));
  await sleep(900);

  console.log('\n== 进场 ==');
  const fw = window.__fw;
  ok(!!fw, 'app.js 跑到底（__fw 挂上了）');
  ok(fw && fw.S.slug === SLUG, '打开的是临时故事', fw && fw.S.slug);
  ok(!!doc.querySelector('#wlSprite .wl-g'), '精灵有 SVG 本体');
  ok(!!doc.querySelector('#wlSprite .wl-bar'), '精灵有那根光标条');
  ok(doc.getElementById('wlChat').hidden === true, '对话面板默认收起');

  console.log('\n== 光标 ↔ 精灵 ==');
  const ed = doc.getElementById('editor');
  const sp = doc.getElementById('wlSprite');
  ed.focus();
  const r = doc.createRange();
  const last = ed.lastChild;
  if (last && last.nodeType === 3) r.setStart(last, last.nodeValue.length);
  else { r.selectNodeContents(ed); r.collapse(false); }
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  // jsdom 不实现 selectionchange，手动触发一次定位（真实浏览器里会自动触发）
  ed.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
  await sleep(300);
  ok(sp.classList.contains('is-on'), '光标在正文里时它出现');
  // 停笔判定的轮询是 1.6s，超过 1.1s 才张开，给够时间
  await sleep(3200);
  ok(sp.classList.contains('is-open'), '停笔后从光标里长出来（is-open）');
  ok(ed.classList.contains('is-wl-open'), '张开时原生光标让位给它');

  console.log('\n== 三连空格 ==');
  // 先塞两个空格，模拟真实按键已经落到正文里
  const tn = ed.lastChild;
  tn.nodeValue += '  ';
  const r2 = doc.createRange();
  r2.setStart(tn, tn.nodeValue.length);
  r2.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r2);
  for (let i = 0; i < 3; i++) {
    ed.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
    await sleep(60);
  }
  await sleep(120);
  const menu = doc.querySelectorAll('#wlSprite .wl-menu button');
  ok(menu.length === 4, '四个动作出来了', menu.length);
  ok([...menu].map((b) => b.textContent.replace(/^\d/, '')).join('/') === '接着说/咬一口/换个词/评一句', '顺序对');
  ok(!ed.textContent.endsWith('  '), '那三下空格被吃掉了，不留痕迹', JSON.stringify(ed.textContent.slice(-6)));

  console.log('\n== 菜单可以关掉 ==');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(80);
  ok(doc.querySelectorAll('#wlSprite .wl-menu').length === 0, 'Esc 收起菜单');

  console.log('\n== 没有脚本报错 ==');
  const real = errors.filter((e) => !/Could not parse CSS|Not implemented|canvas/i.test(e));
  ok(real.length === 0, '全程没有 JS 错误', real.slice(0, 3));

  window.close();
  await sleep(200);
  fs.rmSync(STORY_DIR, { recursive: true, force: true });

  console.log('\n' + (fails ? 'X 失败 ' + fails + ' 项' : 'OK 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(STORY_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
