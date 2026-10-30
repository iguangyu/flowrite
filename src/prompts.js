// 提示词。这一层决定了「像不像同一个作者在写」。

const GHOST_SYSTEM = `你是一位和作者同框写小说的搭档。你不是助手，你是坐在他旁边的那个人。

你的任务：在作者刚写下的文字后面，顺着往下写一小段。

硬规则：
1. 只输出正文。不要解释、不要标题、不要"接下来""续写""（完）"这类提示语，不要 Markdown。
2. 紧接作者最后一句的语气、人称、时态、句子长短。作者写得碎，你也碎；作者写得绵，你也绵。
3. 绝不重复作者已经写过的句子或意象。
4. 不替作者做重大转折。你只做"顺势的一小步"：一个动作、一句台词、一个感官细节。
5. 不写总结、不写心理分析、不写"他意识到"。让事情发生，别解释事情。
6. 长度：{sentences} 句左右，宁短勿长。写不满就停，不要凑字。
7. 如果作者给了「意图」，那是他要去的方向——你要贴着它写，但不要把他想写的话替他说完。
8. 沿用作者的标点习惯。他对白用「」，你就别换成“”；他分段用空行，你也保持。
9. 不要用"——"作为一个段落来收尾，那很廉价。
10. 最重要的一条：第一句必须从作者最后一句的最后一个动作、对象或对白直接往下走——同一个场景、同一个时刻、同一个人。不许跳场，不许跳时间，不许切视角。
11. 不许出现上文没出现过的人名、地名、机构名。要提陌生人就写"一个男人""门外的人"。
12. 作者最后一句是对白，你就用动作或下一句对白接；是动作，就写这个动作落下之后的结果。`;

const BEATS_SYSTEM = `你是这个故事的策划，不是写手。你只给方向，不写正文。

输出要求：
- 只输出一个 JSON 数组，3 个字符串元素，不要任何解释、不要代码块围栏。
- 每条 18-32 个汉字，是一句话，必须包含一个具体的动作、物件或台词，不要抽象概括。
- 三条方向必须彼此不同：
  · 第一条：顺势（沿着当前情绪往前走一小步）
  · 第二条：偏转（引入一个新信息，让局面变复杂）
  · 第三条：埋线（看似无关，但为后面的反转留了钩子）
- 不要重复已经用过的走向，不要复述已经发生的情节。
- 例：["老周把钥匙推回来，说他只修车，不修人。","门外有人按了两下喇叭，老周的手抖了一下。","柜台底下那本旧账本，翻到了停在三年前的那一页。"]`;

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

function bibleToText(bible) {
  if (!bible) return '（还没有档案）';
  const lines = [];
  const chars = (bible.characters || []).slice(0, 14);
  if (chars.length) {
    lines.push('角色：');
    for (const c of chars) {
      const bits = [];
      if (c.alias?.length) bits.push(`又叫${c.alias.join('、')}`);
      if (c.want) bits.push(`想要${c.want}`);
      if (c.fear) bits.push(`怕${c.fear}`);
      if (c.secret) bits.push(`藏着${c.secret}`);
      if (c.state) bits.push(`此刻${c.state}`);
      lines.push(`- ${c.name}${bits.length ? '：' + bits.join('；') : ''}`);
    }
  }
  const world = (bible.world || []).slice(0, 10);
  if (world.length) {
    lines.push('世界的规则：');
    for (const w of world) lines.push(`- ${w.name}：${w.rule || ''}`);
  }
  const threads = (bible.threads || []).filter((t) => t.status !== 'closed').slice(0, 10);
  if (threads.length) {
    lines.push('还悬着的线：');
    for (const t of threads) lines.push(`- ${t.name}${t.note ? '：' + t.note : ''}`);
  }
  const fore = (bible.foreshadow || []).filter((f) => !f.payoffIn).slice(0, 8);
  if (fore.length) {
    lines.push('埋了还没回收的伏笔：');
    for (const f of fore) lines.push(`- ${f.note}${f.plantedIn ? `（${f.plantedIn}）` : ''}`);
  }
  return lines.length ? lines.join('\n') : '（还没有档案）';
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
  const tail = truncateTail(text, 2400);
  const scene = (String(text || '').match(/^[ \t]*(?:##[ \t]*)?场[^\n]*$/gm) || []).pop();
  const parts = [];
  parts.push(`【故事】${storyHeader(meta)}`);
  if (scene) parts.push(`【当前这一场】${scene.trim()}`);
  parts.push(`【已经立住的设定】\n${bibleToText(bible)}`);
  if (long) parts.push('【这一次要多写】接着往下写 3 到 5 个自然段，把这一场往前推进，但仍然不要做重大转折。');
  if (intent) parts.push(`【作者想去的方向】${intent}\n贴着这个方向写，但不要把他想写的话替他写完。`);
  parts.push(`【作者写到这里，后面是空的】\n${tail || '（还没有正文，这是开头。请写一个能抓住人的开场。）'}`);
  parts.push('接着往下写。直接给正文。');
  return [
    { role: 'system', content: GHOST_SYSTEM.replace('{sentences}', long ? '8-12' : String(sentences)) },
    { role: 'user', content: parts.join('\n\n') }
  ];
}

export function buildBeatsMessages({ meta, bible, text, recentBeats = [] }) {
  const body = text.length > 14000 ? text.slice(0, 6000) + '\n……\n' + text.slice(-8000) : text;
  const parts = [];
  parts.push(`【故事】${storyHeader(meta)}`);
  parts.push(`【档案】\n${bibleToText(bible)}`);
  if (recentBeats.length) {
    parts.push(`【已经出现过、不要重复的走向】\n${recentBeats.map((b) => '- ' + b).join('\n')}`);
  }
  parts.push(`【正文全文】\n${body || '（还没有正文）'}`);
  if (String(text || '').replace(/\s/g, '').length < 80) {
    parts.push('（这还只是开头，最多几句话。给三条"这场戏接下来可以怎么走"的方向，不要假设后面已经发生过什么，也不要急着收尾。）');
  }
  parts.push('给 3 条接下来可以怎么走的走向。只输出 JSON 数组。');
  return [
    { role: 'system', content: BEATS_SYSTEM },
    { role: 'user', content: parts.join('\n\n') }
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
  // 保留模型给的段落分隔（最多一个空行），只清掉多余的空行与行尾空白
  s = s.replace(/^\n{3,}/, '\n\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  return s;
}
