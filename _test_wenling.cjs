/* 文灵 3.0 · 体检（jsdom）
   - 光标 ↔ 精灵的折叠/张开
   - 三连空格菜单的四个动作：接着说 / 咬一口 / 换个词 / 评一句
   - 文字定位（editorMap / spanRange / caretOffset）
   全部从 public/app.js 抠函数原文来跑，测的是真代码。 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = path.join(__dirname, 'public', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error('提取边界没对上：' + from);
  return src.slice(a, b);
}

// A: 文字定位工具；B: 文灵本体（含四个动作）
const tools = slice('  function editorMap() {', '  /* ---------------- 文灵本体 ----------------');
const body = slice('const WL_EYE = {', '  function initWenling() {');
const code = tools + '\n\n' + body;

const dom = new JSDOM('<!doctype html><html><body><div id="editor" contenteditable="true"></div></body></html>');
const document = dom.window.document;
const window = dom.window;
const NodeFilter = dom.window.NodeFilter;

let fails = 0;
const ok = (c, m, extra) => {
  if (c) console.log('  [OK] ' + m);
  else { fails++; console.log('  [FAIL] ' + m + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b, m) => ok(a === b, m, { got: a, want: b });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = { mood: 'curious', ghostOn: true, muted: false, ghostBusy: false, wlBusy: false, slug: 't' };
const el = { editor: document.getElementById('editor') };
const countWords = (t) => String(t || '').replace(/\s/g, '').length;
let savedText = '';
const onTextChanged = () => { savedText = rawText(); };
const requestGhost = () => { S.ghostAsked = true; };
const toast = () => {};
const setStatus = () => {};

let apiMode = 'word';
const api = async (url) => {
  if (url === '/api/wenling/word') return { word: apiMode === 'word' ? '摩挲' : '' };
  if (url === '/api/wenling/talk') return { line: '这句在偷懒，剁馅都比它用力。' };
  throw new Error('no ' + url);
};

function rawText() {
  const c = el.editor.cloneNode(true);
  c.querySelectorAll('.ghost').forEach((n) => n.remove());
  c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  return c.textContent || '';
}

const W = new Function(
  'document', 'window', 'NodeFilter', 'S', 'el', 'rawText', 'countWords',
  'onTextChanged', 'requestGhost', 'api', 'toast', 'setStatus',
  code + `
  return { editorMap, spanRange, caretOffset, wordBefore, putBack,
           wlSprite, wlMood, wlSetOpen, wlFold, wlSpeak, wlAsk, wlOpenMenu, wlCloseMenu,
           wlBite, wlSwapWord, wlJudge, wlReply, wlCut, wlDo, toggleGhostOn };`
)(document, window, NodeFilter, S, el, rawText, countWords,
  onTextChanged, requestGhost, api, toast, setStatus);

function setCaretEnd() {
  const last = el.editor.lastChild;
  const r = document.createRange();
  if (last && last.nodeType === 3) r.setStart(last, last.nodeValue.length);
  else { r.selectNodeContents(el.editor); r.collapse(false); }
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

async function main() {
  console.log('\n== 1. 折着是光标，张开是它 ==');
  const sp = W.wlSprite();
  eq(sp.querySelectorAll('.wl-bar').length, 1, '精灵里有一根光标条');
  eq(sp.classList.contains('is-open'), false, '默认是折着的（只有光标）');
  // placeSprite 在真实页面里会加上 is-on；这里手动补上
  sp.classList.add('is-on');
  W.wlSetOpen(true);
  ok(sp.classList.contains('is-open'), '张开后 is-open');
  ok(el.editor.classList.contains('is-wl-open'), '张开时原生光标让位（caret-color:transparent）');
  W.wlSetOpen(false);
  ok(!sp.classList.contains('is-open'), '折回去');
  ok(!el.editor.classList.contains('is-wl-open'), '原生光标还回来');
  W.wlMood('angry');
  eq(sp.querySelector('.wl-eyes ellipse').getAttribute('fill'), '#b5442e', '生气时眼睛朱红');

  console.log('\n== 2. 它说话会自己张开 ==');
  W.wlSpeak('你来啦？我刚在你上一句的句号里打了个盹。');
  ok(sp.classList.contains('is-open'), '开口就张开');
  await sleep(80);
  const txt = sp.querySelector('.wl-say-text').textContent;
  ok(txt.length > 0, '逐字吐字', txt);
  await sleep(24 * 42 + 300);
  ok(sp.querySelector('.wl-say-text').textContent.endsWith('打了个盹。'), '整句吐完');
  W.wlCloseMenu();

  console.log('\n== 3. 三连空格叫出来的菜单 ==');
  W.wlOpenMenu();
  const btns = [...document.querySelectorAll('#wlSprite .wl-menu button')];
  eq(btns.length, 4, '四个动作');
  eq(btns.map((b) => b.textContent.replace(/^\d/, '')).join('/'), '接着说/咬一口/换个词/评一句', '顺序与名字');
  eq(btns[0].querySelector('b').textContent, '1', '带数字键提示');
  W.wlCloseMenu();
  eq(document.querySelectorAll('#wlSprite .wl-menu').length, 0, '能收起');

  console.log('\n== 4. 咬一口：叼走一个词，能吐回来 ==');
  el.editor.textContent = '他推了推那台收音机，外壳边角磨得发亮。';
  setCaretEnd();
  const map0 = W.editorMap();
  const pos0 = W.caretOffset(map0);
  eq(pos0, map0.full.length, 'caretOffset 认得出光标在文末');
  const w0 = W.wordBefore(map0, pos0);
  ok(!!w0 && w0.text.length >= 2, '能往前叼出一个词', w0 && w0.text);
  W.wlBite();
  await sleep(30);
  ok(!el.editor.textContent.includes(w0.text), '这个词被它咬了', el.editor.textContent);
  const biteBtns = [...document.querySelectorAll('#wlSprite .wl-say-actions button')];
  eq(biteBtns.length, 2, '弹两个按钮（吐出来 / 嚼了）');
  ok(el.editor.textContent.endsWith('。'), '只咬了词，句号还在');
  biteBtns[0].click();
  await sleep(30);
  eq(el.editor.textContent, '他推了推那台收音机，外壳边角磨得发亮。', '点「吐出来」一字不差还回去');

  console.log('\n== 5. 换个词：先问，问了才改 ==');
  el.editor.textContent = '他推了推那台收音机。';
  setCaretEnd();
  await W.wlSwapWord();
  const swapBtns = [...document.querySelectorAll('#wlSprite .wl-say-actions button')];
  eq(swapBtns.length, 2, '弹两个按钮（换 / 不换）');
  eq(el.editor.textContent, '他推了推那台收音机。', '没点之前不动');
  swapBtns[1].click();
  await sleep(20);
  eq(el.editor.textContent, '他推了推那台收音机。', '点「不换」不动');
  await W.wlSwapWord();
  const swap2 = [...document.querySelectorAll('#wlSprite .wl-say-actions button')];
  swap2[0].click();
  await sleep(30);
  ok(el.editor.textContent.includes('摩挲'), '点「换」才替换', el.editor.textContent);

  console.log('\n== 6. 评一句 ==');
  el.editor.textContent = '我低头看着我的手表，然后陷入了沉思。';
  setCaretEnd();
  await W.wlJudge();
  await sleep(24 * 42 + 400); // 它是逐字吐的，得等说完
  const said = document.querySelector('#wlSprite .wl-say-text');
  ok(said && said.textContent.includes('偷懒'), '它给了一句点评', said && said.textContent);

  console.log('\n== 7. 本地规矩 ==');
  eq(W.wlReply('你好').mood, 'happy', '打招呼 -> 开心');
  eq(W.wlReply('帮我写点').action, 'write', '「帮我写」-> 续写');
  eq(W.wlReply('把这句删了').action, 'trim', '「删了」-> 提案划掉');
  eq(W.wlReply('评一下这句').action, 'look', '「评一下」-> 评一句');
  eq(W.wlReply('随便说点xyz'), null, '接不住 -> 交给模型');

  console.log('\n== 8. 文字定位还活着 ==');
  el.editor.innerHTML = '第一段：他在巷口站着。<br>第二段：有人在里面剁馅，声音很稳。';
  const m = W.editorMap();
  ok(m.full.includes('\n'), 'editorMap 把 <br> 算作换行', JSON.stringify(m.full));
  const at = m.full.indexOf('他在巷口');
  const r = W.spanRange(m, at, at + 4);
  eq(r.toString(), '他在巷口', 'spanRange 定位准确');
  el.editor.innerHTML = '正文。<span class="ghost">幽灵写的</span>';
  eq(W.editorMap().full, '正文。', 'editorMap 跳过 .ghost');

  console.log('\n' + (fails ? 'X 失败 ' + fails + ' 项' : 'OK 全部通过'));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
