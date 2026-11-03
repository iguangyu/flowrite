// 配置：存在 ~/.flowwrite/config.json，权限 0600。
// 环境变量 FLOWWRITE_BASE_URL / FLOWWRITE_API_KEY / FLOWWRITE_WRITER 等可覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.flowwrite');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro']
  },
  glm: {
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5-air']
  },
  anthropic: {
    label: 'Claude（走 OpenAI 兼容中转）',
    baseURL: '',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5']
  },
  openai: {
    label: 'OpenAI（走中转）',
    baseURL: '',
    models: ['gpt-5', 'gpt-5-mini']
  },
  custom: {
    label: '自定义端点',
    baseURL: '',
    models: []
  }
};

export function defaultConfig() {
  return {
    version: 1,
    root: path.join(os.homedir(), 'FlowWrite'),
    providers: {
      deepseek: { baseURL: PRESETS.deepseek.baseURL, apiKey: '' },
      glm: { baseURL: PRESETS.glm.baseURL, apiKey: '' },
      anthropic: { baseURL: '', apiKey: '' },
      openai: { baseURL: '', apiKey: '' },
      custom: { baseURL: '', apiKey: '' }
    },
    roles: {
      // effort 是 DeepSeek 的推理档位：low / high / max。
      // 实测 low 首字 1.4s，max 要 3.7s —— 心流场景只能用 low。
      // deepseek-v4-pro 会把 token 全烧在推理上、正文返回空，默认不用。
      writer: { provider: 'deepseek', model: 'deepseek-flash', temperature: 0.8, maxTokens: 900, effort: 'high' },
      planner: { provider: 'deepseek', model: 'deepseek-flash', temperature: 0.9, maxTokens: 1400, effort: 'low' },
      archivist: { provider: 'deepseek', model: 'deepseek-flash', temperature: 0.2, maxTokens: 2200, effort: 'low' },
      // 灵感要野，温度给高
      sparker: { provider: 'deepseek', model: 'deepseek-flash', temperature: 1.0, maxTokens: 800, effort: 'low' }
    },
    trigger: {
      idleMs: 650,
      minCharsForGhost: 4,
      charsForBeats: 180,
      charsForBible: 800,
      charsForSparks: 600,
      ghostSentences: 3
    },
    ui: {
      fontSize: 16,
      lineHeight: 1.85,
      zoom: 125,
      font: 'serif'
    },
    effects: {
      // 走向/灵感用 baffle.js 逐字解码，这是它的总时长
      baffleMs: 1600,
      // 幽灵字是流式的，用同一套「乱码还原」观感，这是每个字落定的间隔
      ghostDecode: true,
      decodeMsPerChar: 40,
      // 乱码用哪套字符：hanzi / rare / kana / latin / binary / symbol / morse / block
      ghostGlyphs: 'hanzi',
      panelGlyphs: 'latin',
      // 等首字时占位几个字
      placeholderLen: 10
    }
  };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

export function loadConfig() {
  const base = defaultConfig();
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    disk = {};
  }
  const cfg = deepMerge(base, disk);

  // 环境变量覆盖（优先于文件）
  const env = process.env;
  if (env.FLOWWRITE_BASE_URL) cfg.providers.deepseek.baseURL = env.FLOWWRITE_BASE_URL;
  if (env.FLOWWRITE_API_KEY) cfg.providers.deepseek.apiKey = env.FLOWWRITE_API_KEY;
  if (env.FLOWWRITE_WRITER) cfg.roles.writer.model = env.FLOWWRITE_WRITER;
  if (env.FLOWWRITE_PLANNER) cfg.roles.planner.model = env.FLOWWRITE_PLANNER;
  if (env.FLOWWRITE_ARCHIVIST) cfg.roles.archivist.model = env.FLOWWRITE_ARCHIVIST;
  if (env.FLOWWRITE_ROOT) cfg.root = env.FLOWWRITE_ROOT;

  return cfg;
}

// 只把「和默认值不一样」的部分落盘。
// 否则一次保存就把当时的全部默认值冻进文件，以后改默认值老用户永远收不到。
function diffFromDefault(value, base) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!(k in base)) {
        out[k] = v;
        continue;
      }
      const d = diffFromDefault(v, base[k]);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === base ? undefined : value;
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const slim = diffFromDefault(cfg, defaultConfig()) || {};
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(slim, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  return cfg;
}

// 把某个角色解析成一次请求真正需要的四个字段
export function resolveRole(cfg, roleName) {
  const role = cfg.roles[roleName] || cfg.roles.writer;
  const provider = cfg.providers[role.provider] || {};
  const apiKey = provider.apiKey || '';
  const baseURL = (provider.baseURL || '').trim();
  if (!baseURL) {
    throw new Error(`角色 ${roleName} 使用的 provider「${role.provider}」还没填 baseURL，去设置里填一下。`);
  }
  if (!apiKey) {
    throw new Error(`角色 ${roleName} 使用的 provider「${role.provider}」没有 API Key。`);
  }
  return {
    baseURL,
    apiKey,
    model: role.model,
    temperature: role.temperature ?? 0.9,
    maxTokens: role.maxTokens ?? 600,
    effort: role.effort || '',
    provider: role.provider
  };
}

// 给前端展示用：绝不返回 apiKey
export function publicConfig(cfg) {
  const providers = {};
  for (const [k, v] of Object.entries(cfg.providers)) {
    providers[k] = { baseURL: v.baseURL, hasKey: Boolean(v.apiKey), label: PRESETS[k]?.label || k };
  }
  return {
    root: cfg.root,
    providers,
    presets: PRESETS,
    roles: cfg.roles,
    trigger: cfg.trigger,
    ui: cfg.ui,
    effects: cfg.effects
  };
}
