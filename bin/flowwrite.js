#!/usr/bin/env node
// flowwrite / flow —— 一条命令开写。
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';
import { loadConfig, saveConfig, CONFIG_FILE } from '../src/config.js';

const argv = process.argv.slice(2);

function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return fallback;
}
const has = (name) => argv.includes(`--${name}`);

if (has('help') || has('h')) {
  console.log(`
  flowwrite —— 心流式 AI 创意写作终端

  用法
    npx flowwrite              起服务并打开浏览器
    flow                       同上（装过之后可用短命令）
    flow --port 5000           指定端口
    flow --root D:\\写作         指定故事存放目录
    flow --no-open             不自动打开浏览器
    flow --config              打印配置文件位置

  快捷键（页面内）
    Tab 接受幽灵字 · Ctrl+→ 逐句 · Esc 丢弃
    Alt+1/2/3 采用走向 · Ctrl+Enter 让 AI 多写一段
    Alt+G 总览 · Alt+B 折叠侧栏 · Alt+M 静音 · Alt+S 设置
`);
  process.exit(0);
}

if (has('config')) {
  const cfg = loadConfig();
  if (has('reset')) {
    saveConfig(cfg);
    console.log('配置已重写：' + CONFIG_FILE);
  } else {
    console.log('配置文件：' + CONFIG_FILE);
    console.log('故事目录：' + cfg.root);
    console.log('写作模型：' + cfg.roles.writer.provider + ' / ' + cfg.roles.writer.model);
  }
  process.exit(0);
}

const port = Number(arg('port', process.env.FLOWWRITE_PORT || 4780));
const rootArg = arg('root');
const noOpen = has('no-open');

if (rootArg) {
  const cfg = loadConfig();
  cfg.root = rootArg;
  saveConfig(cfg);
}

const { url, port: actualPort } = await startServer({ port });
if (actualPort !== port) {
  console.log(`\n  ! 端口 ${port} 被占用（可能有另一个 FlowWrite 还在跑），已改用 ${actualPort}。`);
}

const line = '─'.repeat(Math.min(52, url.length + 22));
console.log('');
console.log('  ┌' + line + '┐');
console.log('  │  FlowWrite · 心流写作终端' + ' '.repeat(Math.max(0, line.length - 27)) + '│');
console.log('  ├' + line + '┤');
console.log('  │  ' + url + ' '.repeat(Math.max(0, line.length - url.length - 2)) + '│');
console.log('  │  故事目录：' + loadConfig().root);
console.log('  └' + line + '┘');
console.log('   Ctrl+C 退出\n');

if (!noOpen) openBrowser(url);

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开就算了，地址已经打印出来了 */
  }
}
