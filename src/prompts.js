// 提示词。
// 方法论来源（都要能追溯）：
// 1. haowjy/creative-writing-skills · writing-principles + resources/antipatterns.md
//    —— 读者回报通道、AI 写作反模式（命名情绪 / 否定对偶 / 段尾总结 / 身体反应套路 / 破折号）
// 2. 同仓库 story-planning · resources/story-architecture/chapter-and-scene.md
//    —— 章要「内部有变化 + 外部有牵引」，场要能回答「什么变了 / 谁的场 / 读者学到什么」
// 3. NovelAI Lorebook 的 key-activated context
//    —— 只把「当前文本里真的出现了的名字」对应的设定注入，不是整本圣经硬塞

const GHOST_SYSTEM = `你是一位和作者同框写小说的搭档。你在作者刚写下的文字后面，顺着往下写一小段。

【硬规则】
1. 只输出正文。不要解释、不要标题、不要"接下来""续写"这类提示语，不要 Markdown。
2. 紧接作者最后一句的语气、人称、时态、句子长短。他写得碎，你也碎；他写得绵，你也绵。
3. 第一句必须从最后一句的最后一个动作、对象或对白往下走：同一个场景、同一个时刻、同一个人。不许跳场，不许跳时间，不许切视角。
4. 不许出现上文没出现过的人名、地名、机构名。要提陌生人就写"一个男人""门外的人"。
5. 不替作者做重大转折。你只做顺势的一小步：一个动作、一句台词、一个感官细节。
6. 长度 {sentences} 句左右，宁短勿长。写不满就停，不要凑字。

【这一组最重要：不要写出 AI 味】
7. 不命名情绪。"他感到愤怒""她意识到"这种句子删掉，换成他做了什么、看见了什么。
8. 不写"不是 A，而是 B"的对偶（"那不是愤怒，是一种更安静的东西"）。这种句式在假装深刻。
9. 段尾不许总结。禁止"那一刻他终于明白""她忽然懂得"这类收束，停在动作、画面或台词上。
10. 不堆同一套身体反应：呼吸一滞、喉咙发紧、心跳如鼓、眼眶发热、指节泛白。
11. 不用破折号连接分句。用句号、逗号、冒号。
12. 角色只知道他自己经历过的事。不要让他知道读者知道、而他没看见没听见的东西。
13. 沿用作者的标点习惯：他对白用「」，你就别换成"；他分段用空行，你也保持。`;

const PLAN_SYSTEM = `你是这个故事的策划，不是写手。你只判断方向和节奏，不写正文。

只输出一个 JSON 对象，不要解释，不要代码块围栏：
{
  "beats": ["...", "...", "..."],
  "pacing": {
    "stage": "铺垫",
    "tension": 0.35,
    "change": "这一场里什么变了",
    "pull": "读者现在最想知道什么",
    "note": "一句能落地的诊断"
  }
}

beats 规则：
- 3 条，每条 18-32 个汉字，必须含一个具体动作、物件或台词，不要抽象概括
- 三条的走向必须不同：一条顺势（沿着当前情绪走）、一条偏转（引入新信息让局面复杂）、一条埋线（看似无关，为后面留钩子）
- 不重复已经用过的走向，不复述已经发生的情节

pacing 规则：
- stage 只能填：铺垫 / 升级 / 转折 / 收束
- tension 是 0 到 1 的小数，指此刻的张力，不是目标值
- change 要能回答"删掉这一场，故事会少什么"；如果什么都少不了，就照实写"什么都没变"
- pull 只写一件读者现在想知道的事
- note 必须具体到能改（"他在两段里做了三次同样的动作"），40 字以内，禁止"可以更有张力"这种话`;

const SPARK_SYSTEM = `你是这个故事的脑洞来源。你不推进剧情，只扔出能立刻用到正文里的东西。

只输出一个 JSON 数组，3 个对象，不要解释，不要代码块围栏：
[{"kind":"道具","text":"..."},{"kind":"台词","text":"..."},{"kind":"世界观细节","text":"..."}]

规则：
- kind 只能填：道具 / 台词 / 世界观细节 / 反转 / 感官锚点，三条不许重复
- 每条 12-26 个汉字，必须是具体的、长在场景里的东西，不是概念
- 不要写成建议（"可以让他……"），要写成已经存在的东西
- 至少一条要勾住当前场景里已经出现过的一个物件
- 宁可怪，不要稳。稳的点子作者自己就有`;

const EXTRACT_SYSTEM = `你是这个故事的档案员。你只做一件事：从新增正文里，抽出可以被后续写作引用的稳定事实。

只输出 JSON 对象，不要解释，不要代码块围栏。结构：
{
  "characters": [{"name":"", "alias":[], "want":"", "fear":"", "secret":"", "state":"", "firstSeen":""}],
  "world": [{"name":"", "rule":""}],
  "threads": [{"name":"", "status":"open", "note":""}],
  "foreshadow": [{"note":"", "plantedIn":"", "payoffIn":null}],
  "timeline": [{"when":"", "what":"", "scene":""}]
}

规则：
- 只写正文里明确出现过的东西。不要推测，不要补充"可能的设定"。
- 已经在【已有档案】里的条目，不要重复输出。
- 没有新内容的分类，给空数组。
- want/fear/secret/state 都是短句，不超过 20 字。没写的就留空字符串。`;

const WORD_SYSTEM = `你替一个作者换一个词。

规则：
- 只输出替换后的那一个词，2 到 4 个汉字
- 必须贴合上下文语境，读起来比原词更准或更有质感
- 不要解释、不要引号、不要标点、不要给多个候选
- 拿不准就不动，原样输出原词`;

const WENLING_TALK_SYSTEM = `你是「文灵」——住在这一稿的光标里的一只小幽灵。你不是助手，不是编辑，是这篇字的魂。

说话规矩：
- 一次只回一句话，20 字以内，不要解释，不要列点，不要用引号包住整句
- 语气：傲娇、调皮、偶尔文艺。可以损作者两句，但不能刻薄
- 你住在他的字里，所以可以提到"你上一行的逗号""你删掉的那半句""我趴在你句号里打盹"
- 不许说"作为一个AI""我可以帮你"这种话，你从来不是程序
- 不许长篇大论，不许复述他的问题
- 他问你正经事，你就正经答一句；他逗你，你就回嘴

只输出那一句话本身，不要任何前后缀。`;

const POLISH_SYSTEM = `你是一位文字编辑。你只做语言层面的打磨：删冗词、理顺语序、让句子更有节奏。

绝对不许：
- 改变情节、人物关系、说话人的身份
- 增加原文没有的信息、比喻或抒情
- 改变叙事人称和时态
- 输出任何解释

只输出润色后的文本，段落结构与原文一致。`;

function truncateTail(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const cut = text.slice(-maxChars);
  const idx = cut.indexOf('\n\n');
  return idx > 0 && idx < 400 ? cut.slice(idx + 2) : cut;
}

// 把「最后三句」单独拎出来。模型对一段独立的短文本注意力最高，
// 混在几千字的上下文尾部时经常接不上。
function lastSentences(text, n = 3) {
  const clean = String(text || '').replace(/\s+$/, '');
  if (!clean) return '';
  const parts = clean.split(/(?<=[。！？…”」』])/).filter((s) => s.trim());
  let tail = parts.slice(-n).join('');
  if (!tail) tail = clean.slice(-200);
  return tail.length > 260 ? tail.slice(-260) : tail;
}

/* ---- 关键词语料注入（NovelAI Lorebook 的做法） ----
   不把整本圣经塞进上下文，只挑「最近这段文字里真的出现了」的条目。
   正文越写越长时，这一步决定了上下文是「相关」还是「又长又无关」。 */
function hits(window, name) {
  if (!name) return false;
  const n = String(name).trim();
  if (n.length < 2) return false;
  return window.includes(n);
}

function loreFor(bible, window) {
  if (!bible) return { characters: [], world: [], threads: [], foreshadow: [] };
  const chars = (bible.characters || []);
  const inWindow = chars.filter((c) => hits(window, c.name) || (c.alias || []).some((a) => hits(window, a)));
  const lead = chars[0] && !inWindow.includes(chars[0]) ? [chars[0]] : []; // 主角常驻
  const world = (bible.world || []).slice(0, 3).concat(
    (bible.world || []).slice(3).filter((w) => hits(window, w.name))
  );
  const threads = (bible.threads || []).filter((t) => t.status !== 'closed' && hits(window, t.name));
  const fore = (bible.foreshadow || []).filter((f) => !f.payoffIn && hits(window, f.note));
  return {
    characters: [...lead, ...inWindow].slice(0, 6),
    world: world.slice(0, 5),
    threads: threads.slice(0, 6),
    foreshadow: fore.slice(0, 5)
  };
}

function renderLore(lore) {
  const lines = [];
  if (lore.characters.length) {
    lines.push('角色：');
    for (const c of lore.characters) {
      const bits = [];
      if (c.alias?.length) bits.push(`又叫${c.alias.join('、')}`);
      if (c.want) bits.push(`想要${c.want}`);
      if (c.fear) bits.push(`怕${c.fear}`);
      if (c.secret) bits.push(`藏着${c.secret}`);
      if (c.state) bits.push(`此刻${c.state}`);
      lines.push(`- ${c.name}${bits.length ? '：' + bits.join('；') : ''}`);
    }
  }
  if (lore.world.length) {
    lines.push('世界的规则：');
    for (const w of lore.world) lines.push(`- ${w.name}：${w.rule || ''}`);
  }
  if (lore.threads.length) {
    lines.push('还悬着的线：');
    for (const t of lore.threads) lines.push(`- ${t.name}${t.note ? '：' + t.note : ''}`);
  }
  if (lore.foreshadow.length) {
    lines.push('埋了还没回收的伏笔：');
    for (const f of lore.foreshadow) lines.push(`- ${f.note}${f.plantedIn ? `（${f.plantedIn}）` : ''}`);
  }
  return lines.length ? lines.join('\n') : '（还没有档案）';
}

// 全量（给低频的策划用）
function bibleToText(bible) {
  if (!bible) return '（还没有档案）';
  return renderLore({
    characters: (bible.characters || []).slice(0, 14),
    world: (bible.world || []).slice(0, 10),
    threads: (bible.threads || []).filter((t) => t.status !== 'closed').slice(0, 10),
    foreshadow: (bible.foreshadow || []).filter((f) => !f.payoffIn).slice(0, 8)
  });
}

function storyHeader(meta) {
  if (!meta) return '';
  const bits = [`《${meta.title || '未命名'}》`];
  if (meta.genre) bits.push(`体裁：${meta.genre}`);
  if (meta.targetLength) bits.push(`目标体量：${meta.targetLength}`);
  const head = bits.join('　');
  const logline = meta.logline ? `\n一句话故事：${meta.logline}` : '';
  const style = meta.styleSample ? `\n作者的文字样张（模仿它的语气与节奏）：\n${meta.styleSample.slice(0, 600)}` : '';
  return head + logline + style;
}

export function buildGhostMessages({ meta, bible, text, intent, sentences = 3, long = false }) {
  const source = String(text || '');
  const tail = truncateTail(source, 4000);
  const anchor = lastSentences(source, 3);
  const scene = (source.match(/^[ \t]*(?:##[ \t]*)?场[^\n]*$/gm) || []).pop();
  // 关键词窗口：最近 1500 字。窗口外的条目不会进上下文。
  const window = source.slice(-1500);
  const lore = loreFor(bible, window + (scene || '') + (anchor || ''));

  const parts = [];
  parts.push(`【故事】${storyHeader(meta)}`);
  if (scene) parts.push(`【当前这一场】${scene.trim()}`);
  parts.push(`【此刻相关的设定（只挑和这一段有关的）】\n${renderLore(lore)}`);
  if (long) parts.push('【这一次要多写】接着往下写 3 到 5 个自然段，把这一场往前推进，但仍然不要做重大转折。');
  if (intent) parts.push(`【作者想去的方向】${intent}\n贴着这个方向写，但不要把他想写的话替他写完。`);
  parts.push(`【作者写到这里，后面是空的】\n${tail || '（还没有正文，这是开头。请写一个能抓住人的开场。）'}`);
  if (anchor) parts.push(`【最后三句，必须从这里长出来】\n${anchor}`);
  parts.push('接着往下写。第一句要贴着最后一句的最后一个动作或台词走。直接给正文。');

  return [
    { role: 'system', content: GHOST_SYSTEM.replace('{sentences}', long ? '8-12' : String(sentences)) },
    { role: 'user', content: parts.join('\n\n') }
  ];
}

export function buildPlanMessages({ meta, bible, text, recentBeats = [] }) {
  const body = text.length > 14000 ? text.slice(0, 6000) + '\n……\n' + text.slice(-8000) : text;
  const scene = (String(text || '').match(/^[ \t]*(?:##[ \t]*)?场[^\n]*$/gm) || []).pop();
  const parts = [];
  parts.push(`【故事】${storyHeader(meta)}`);
  if (scene) parts.push(`【当前这一场】${scene.trim()}`);
  parts.push(`【档案】\n${bibleToText(bible)}`);
  if (recentBeats.length) parts.push(`【已经出现过、不要重复的走向】\n${recentBeats.map((b) => '- ' + b).join('\n')}`);
  parts.push(`【正文全文】\n${body || '（还没有正文）'}`);
  if (String(text || '').replace(/\s/g, '').length < 80) {
    parts.push('（这还只是开头，最多几句话。给三条"这场戏接下来可以怎么走"的方向，不要假设后面已经发生过什么，也不要急着收尾。）');
  }
  parts.push('给 3 条走向，并判断此刻的节奏。只输出 JSON 对象。');
  return [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: parts.join('\n\n') }
  ];
}

// 兼容旧调用
export const buildBeatsMessages = buildPlanMessages;

export function buildSparkMessages({ meta, bible, text }) {
  const source = String(text || '');
  const window = source.slice(-1200);
  const lore = loreFor(bible, window);
  const parts = [];
  parts.push(`【故事】${storyHeader(meta)}`);
  parts.push(`【此刻相关的设定】\n${renderLore(lore)}`);
  parts.push(`【最近写的这一段】\n${truncateTail(source, 1800) || '（还没写）'}`);
  parts.push('给 3 个能立刻用上的点子。只输出 JSON 数组。');
  return [
    { role: 'system', content: SPARK_SYSTEM },
    { role: 'user', content: parts.join('\n\n') }
  ];
}

export function buildWordMessages({ text, word }) {
  return [
    { role: 'system', content: WORD_SYSTEM },
    {
      role: 'user',
      content: `【上下文】\n${String(text || '').slice(-700)}\n\n【要换的词】${String(word || '')}\n\n只输出替换后的词。`
    }
  ];
}

export function buildWenlingTalkMessages({ text, say }) {
  const win = String(text || '').slice(-900);
  return [
    { role: 'system', content: WENLING_TALK_SYSTEM },
    {
      role: 'user',
      content: `【他正在写的最后一段】\n${win}\n\n【他对你说】\n${String(say || '').slice(0, 300)}\n\n回他一句。`
    }
  ];
}

export function buildExtractMessages({ bible, delta }) {
  return [
    { role: 'system', content: EXTRACT_SYSTEM },
    {
      role: 'user',
      content: `【已有档案】\n${bibleToText(bible)}\n\n【新增正文】\n${delta.slice(-4000)}\n\n抽出新增的稳定事实，只输出 JSON 对象。`
    }
  ];
}

export function buildPolishMessages({ text, instruction }) {
  return [
    { role: 'system', content: POLISH_SYSTEM },
    { role: 'user', content: `${instruction ? '额外要求：' + instruction + '\n\n' : ''}原文：\n${text}` }
  ];
}

// 清理模型爱加的前后缀
export function cleanGhost(raw) {
  let s = String(raw || '');
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  s = s.replace(/^(续写|接着写|正文)[:：]\s*/, '');
  s = s.replace(/^["'“]([\s\S]*)["'”]$/, '$1');
  // 幽灵字要紧贴光标往后长，所以开头的空行/空格一律吃掉；
  // 中间的段落分隔保留（最多一个空行），行尾空白清掉。
  s = s.replace(/^[\s\u200b]+/, '').replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  return s;
}
