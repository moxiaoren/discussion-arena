#!/usr/bin/env node
/* ============================================================
   论证点评间 · 异地版 · 全能入口（Windows / 通用）
   ------------------------------------------------------------
   所有易错逻辑（依赖安装 / cloudflared 下载 / 邮箱配置 / 启动 /
   抓网址 / 发邮件 / 开机自启 / 菜单）全部用 node 实现，
   bat 只负责调用本文件 —— 彻底避开 cmd 批处理的
   编码 / 换行 / 多行 if 等脆弱问题。
   用法：
     node launch.js                 正常启动
     node launch.js --menu          交互菜单（初始化 / 自启 / 测试邮件…）
     node launch.js --send-test     只发测试邮件
     node launch.js --dryrun        抓网址不真发邮件（调试）
   ============================================================ */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = __dirname;
const PORT = 8788;

const args = process.argv.slice(2);
const SEND_TEST = args.includes('--send-test');
const DRY = args.includes('--dryrun');
const MENU = args.includes('--menu');
const USER_CF = process.env.CLOUDFLARED_PATH;

let CF_BIN = USER_CF || 'cloudflared';
const localCfWin = path.join(ROOT, 'cloudflared.exe');
const localCfNix = path.join(ROOT, 'cloudflared');
if (fs.existsSync(localCfWin)) CF_BIN = localCfWin;
else if (fs.existsSync(localCfNix)) CF_BIN = localCfNix;

function log(m) { console.log(m); }
function loadJson(f) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { console.error('✗ 配置解析失败 ' + f + ': ' + e.message); return null; }
}
// 兼容：若只填了 server-config.json.example（未建 server-config.json），则自动采用它
if (!fs.existsSync(path.join(ROOT, 'server-config.json')) && fs.existsSync(path.join(ROOT, 'server-config.json.example'))) {
  try { fs.copyFileSync(path.join(ROOT, 'server-config.json.example'), path.join(ROOT, 'server-config.json')); log('📎 检测到 server-config.json.example，已自动采用为 server-config.json'); }
  catch (e) { log('⚠ 无法复制 server-config.json.example: ' + e.message); }
}
let mailCfg = loadJson('push-config.json');
const serverCfg = loadJson('server-config.json');
// 若没有 push-config.json，则复用 server-config.json 里的 mail 配置
if (!mailCfg && serverCfg && serverCfg.mail) {
  mailCfg = { smtp: serverCfg.mail, to: Array.isArray(serverCfg.mail.to) ? serverCfg.mail.to : [serverCfg.mail.to].filter(Boolean) };
}
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

/* ---------------- 依赖安装 ---------------- */
function runInstall(dir) {
  return new Promise((r) => {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const a = spawn(cmd, ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    a.on('close', () => r()); a.on('error', () => r());
  });
}
async function ensureDeps() {
  const needWs = !fs.existsSync(path.join(ROOT, 'node_modules', 'ws'));
  const needMail = !fs.existsSync(path.join(ROOT, 'node_modules', 'nodemailer'));
  if (!needWs && !needMail) { try { nodemailer = require('nodemailer'); } catch (e) {} return; }
  log('⚠ 依赖未就绪，正在安装（首次约需 1-2 分钟）...');
  await runInstall(ROOT);
  try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
}

/* ---------------- cloudflared 自动下载（国内镜像 > GitHub 官方） ---------------- */
function downloadFile(url, out) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) { res.resume(); return downloadFile(res.headers.location, out).then(resolve); }
      if (code !== 200) { res.resume(); return resolve(false); }
      const ws = fs.createWriteStream(out);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(true); });
      ws.on('error', () => { try { fs.unlinkSync(out); } catch (e) {} resolve(false); });
    }).on('error', () => resolve(false));
  });
}
async function ensureCloudflared() {
  const IS_WIN = process.platform === 'win32';
  const exe = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
  const local = path.join(ROOT, exe);
  if (USER_CF) { if (fs.existsSync(USER_CF)) { CF_BIN = USER_CF; return true; } }
  if (fs.existsSync(local)) { CF_BIN = local; return true; }
  const base = IS_WIN
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  const mirror = 'https://ghfast.top/' + base;
  log('⏳ 未找到 ' + exe + '，正在下载（国内镜像，约 15MB）...');
  let ok = await downloadFile(mirror, local);
  if (!ok) {
    log('  镜像失败，改用 GitHub 官方源...');
    ok = await downloadFile(base, local);
  }
  if (!ok) {
    log('✗ cloudflared 下载失败。请手动下载后放到本文件夹，并改名 ' + exe + ':');
    log('  ' + base);
    return false;
  }
  // 非 Windows 下补执行权限
  if (!IS_WIN) { try { fs.chmodSync(local, 0o755); } catch (e) {} }
  log('✅ ' + exe + ' 下载完成');
  CF_BIN = local;
  return true;
}

/* ---------------- 邮箱模板 ---------------- */
function ensurePushConfig() {
  const p = path.join(ROOT, 'push-config.json');
  if (fs.existsSync(p)) return;
  const e = path.join(ROOT, 'push-config.json.example');
  if (fs.existsSync(e)) {
    fs.copyFileSync(e, p);
    log('📝 已生成 push-config.json（用菜单 5 编辑填邮箱）');
  } else {
    fs.writeFileSync(p, JSON.stringify({
      smtp: { host: 'smtp.qq.com', port: 465, user: 'yourQQ@qq.com', pass: 'your-auth-code', from: 'yourQQ@qq.com' },
      to: ['receiver@example.com']
    }, null, 2));
    log('📝 已生成 push-config.json（请编辑填邮箱）');
  }
  mailCfg = loadJson('push-config.json');
}

/* ---------------- 邮件发送 ---------------- */
async function sendMail(cfg, subject, text) {
  if (!nodemailer) throw new Error('nodemailer 未装好');
  const s = cfg.smtp, tos = Array.isArray(cfg.to) ? cfg.to : [];
  if (!s || !s.host || !s.user || !s.pass || !tos.length) throw new Error('push-config.json 未完整配置 smtp/host/user/pass/to');
  const port = s.port || 465;
  const secure = !s.secure ? (port === 465) : !!s.secure;
  const tr = nodemailer.createTransport({ host: s.host, port, secure, auth: { user: s.user, pass: s.pass }, tls: { rejectUnauthorized: false } });
  try { await tr.sendMail({ from: s.from || s.user, to: tos.join(','), subject, text }); }
  finally { tr.close(); }
}

/* ---------------- 在线更新（从私有仓库拉最新 index.html） ---------------- */
let srv = null;
function spawnRelay() {
  const s = spawn(process.execPath, ['relay.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => process.stdout.write('  后端| ' + d));
  s.stderr.on('data', (d) => process.stdout.write('  后端! ' + d));
  s.on('exit', (c) => { if (c !== null) log('⚠ 后端已退出 (code=' + c + ')，将由自动守护恢复'); });
  return s;
}
const UPDATE_INTERVAL = 8 * 60 * 1000; // 自动更新守护：每 8 分钟检查一次远程更新
async function checkUpdate(silent) {
  const gh = serverCfg && serverCfg.github;
  const repo = gh && gh.updateRepo;
  const token = gh && gh.token;
  if (!repo || !token) { if (!silent) log('（未配置 server-config.json 的 github.token，跳过在线更新）'); return false; }
  const files = ['index.html', 'relay.js', 'launch.js', 'server-config.json.example'];
  let changed = false, needRestart = false, launchChanged = false;
  for (const f of files) {
    try {
      const url = 'https://api.github.com/repos/' + repo + '/contents/' + f;
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'openclaw-note', 'Accept': 'application/vnd.github+json' } });
      if (res.status === 404) continue;
      if (!res.ok) { if (!silent) log('⚠ ' + f + ' 更新检查失败(' + res.status + ')'); continue; }
      const j = await res.json();
      const remote = Buffer.from(j.content, 'base64').toString('utf8');
      const lp = path.join(ROOT, f);
      const local = fs.existsSync(lp) ? fs.readFileSync(lp, 'utf8') : '';
      if (remote !== local) {
        fs.writeFileSync(lp, remote);
        log('⬇️ ' + (silent ? '[自动] ' : '') + '已更新: ' + f);
        changed = true;
        if (f === 'index.html' || f === 'relay.js') needRestart = true;
        if (f === 'launch.js') launchChanged = true;
      }
    } catch (e) { if (!silent) log('⚠ ' + f + ' 更新失败: ' + e.message); }
  }
  if (!silent && !changed) log('✔ 服务器文件已是最新');
  if (launchChanged && !silent) log('  （launch.js 已更新，请重启一次 start.bat 使其生效）');
  return needRestart;
}
async function autoUpdateLoop() {
  try {
    if (!srv || srv.exitCode !== null) { log('  （检测到后端未运行，自动拉起）'); srv = spawnRelay(); }
    const nd = await checkUpdate(true);
    if (nd) {
      log('♻️ 检测到新版，自动重启后端使更新生效（约 2 秒）…');
      const old = srv; srv = null;
      try { if (old) old.kill('SIGKILL'); } catch (e) {}
      await new Promise((r) => setTimeout(r, 1000));
      srv = spawnRelay();
    }
  } catch (e) { /* 静默 */ }
}

/* ---------------- 菜单（node 交互，替代 cmd 菜单） ---------------- */
function openPushConfig() {
  if (process.platform === 'win32') { spawn('notepad', [path.join(ROOT, 'push-config.json')], { stdio: 'ignore' }); }
  else { log('请用编辑器打开 ' + path.join(ROOT, 'push-config.json')); }
}
async function doAutostart(enable) {
  if (process.platform !== 'win32') { log('仅 Windows 支持开机自启'); return; }
  const runBat = path.join(ROOT, 'run-autostart.bat');
  const cmd = enable ? '/create' : '/delete';
  const extra = enable ? ['/tr', '"' + runBat + '"', '/sc', 'onlogon', '/rl', 'highest', '/f'] : ['/tn', 'DiscussionRoomServer', '/f'];
  const tn = enable ? ['/tn', 'DiscussionRoomServer'] : [];
  const r = spawnSync('schtasks', [cmd, ...tn, ...extra], { shell: true });
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status === 0) log(enable ? '✅ 开机自启已注册（登录自动启动，日志见 autostart.log）' : '✅ 已移除开机自启');
  else { log('✗ ' + (enable ? '注册' : '移除') + '失败: ' + (out.trim() || r.error && r.error.message || '权限不足')); log('  （注册自启需右键本文件以管理员身份运行）'); }
}
function runMenu() {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const loop = () => {
    log('');
    log('  1) 一键初始化（装依赖 + 下载 cloudflared + 生成邮箱模板）');
    log('  2) 注册开机自启（需管理员）');
    log('  3) 移除开机自启');
    log('  4) 发送测试邮件');
    log('  5) 打开 push-config.json 填邮箱');
    log('  0) 退出');
    rl.question('请选择数字后回车: ', (ans) => {
      const a = (ans || '').trim();
      if (a === '1') return initThen(rl, loop);
      if (a === '2') { ensureDeps().then(() => doAutostart(true)).then(() => waitThen(rl, loop)); return; }
      if (a === '3') { doAutostart(false).then(() => waitThen(rl, loop)); return; }
      if (a === '4') { sendTest().then(() => waitThen(rl, loop)); return; }
      if (a === '5') { ensurePushConfig(); openPushConfig(); waitThen(rl, loop); return; }
      if (a === '0') { log('再见'); rl.close(); return; }
      log('无效输入'); loop();
    });
  };
  loop();
}
function waitThen(rl, fn) { rl.question('按回车返回菜单...', () => fn()); }
async function initThen(rl, fn) {
  await ensureDeps();
  await ensureCloudflared();
  ensurePushConfig();
  log('✅ 初始化完成。接下来：填邮箱(5)→测试邮件(4)→运行 start.bat 启动');
  waitThen(rl, fn);
}

/* ---------------- 测试邮件 ---------------- */
async function sendTest() {
  log('== 测试邮件发送 ==');
  if (!mailCfg) { log('✗ 未找到 push-config.json，请先在菜单选 5 配置邮箱'); return 1; }
  try { await sendMail(mailCfg, '论证点评间 · SMTP 配置测试', '收到这封邮件说明邮箱推送配置正确。'); log('✅ 测试邮件发送成功，请查收邮箱。'); return 0; }
  catch (e) { log('✗ 发送失败: ' + e.message); return 1; }
}

/* ---------------- 主流程（启动） ---------------- */
const CF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
async function main() {
  log('============================================');
  log('   论证点评间 · 异地版 · 一键启动');
  log('============================================');
  await checkUpdate();
  await ensureDeps();
  const cfOk = await ensureCloudflared();
  if (!cfOk) { log('没有 cloudflared.exe，无法启动隧道。请运行 install-menu.bat 选 1'); process.exitCode = 1; return; }

  log('\n[1/3] 启动中继服务器 (ws://localhost:' + PORT + ') ...');
  srv = spawnRelay();
  // 自动更新守护：每 8 分钟检查远程，有新版自动覆盖 + 自动重启后端；后端崩溃自动拉起
  setInterval(autoUpdateLoop, UPDATE_INTERVAL);

  await new Promise((r) => setTimeout(r, 2000));

  log('[2/3] 启动 Cloudflare 隧道 ...');
  const cf = spawn(CF_BIN, ['tunnel', '--url', 'http://localhost:' + PORT + '/', '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  cf.stdout.on('data', (d) => tryPush(String(d)));
  cf.stderr.on('data', (d) => tryPush(String(d)));
  cf.on('exit', (c) => log('⚠ 隧道已退出 (code=' + c + ')，后端仍在运行'));

  let pushed = false;
  function tryPush(text) {
    if (pushed) return;
    const m = text.match(CF_URL_RE);
    if (!m) return;
    const url = m[0]; pushed = true;
    log('\n\n🎉 你的聊天室新网址：' + url);
    try { fs.writeFileSync(path.join(ROOT, 'last-url.txt'), url + '\n'); } catch (e) {}
    log('（已保存到 last-url.txt）');
    if (DRY) { log('（--dryrun：不发送邮件）'); return; }
    if (!mailCfg) { log('⚠ 未配置 push-config.json，跳过推送。\n   （用 install-menu 选 5 填邮箱后会自动推送）'); return; }
    log('[3/3] 正在把新网址发往邮箱 ' + (mailCfg.to || []).join(',') + ' ...');
    sendMail(mailCfg, '论证点评间 · 新地址',
      '你的聊天室已启动，新网址：\n\n' + url + '\n\n把这个发给好友即可开始异地聊天。\n（隧道或电脑重启后地址会变化，届时会再次收到新地址）')
      .then(() => log('✅ 已推送成功'))
      .catch((e) => log('✗ 邮件推送失败: ' + e.message + '\n  （不影响聊天，地址在上方 / last-url.txt）'));
  }

  log('\n等待生成网址（首次约 5-15 秒）...\n');
}

async function sendTestEntry() {
  log('== 测试邮件发送（--send-test）==');
  if (!mailCfg) { log('✗ 未找到 push-config.json'); process.exitCode = 1; return; }
  try { await sendMail(mailCfg, '论证点评间 · SMTP 配置测试', '如果你收到这封邮件，说明邮箱推送配置正确。'); log('✅ 测试邮件发送成功，请去邮箱确认。'); }
  catch (e) { log('✗ 发送失败: ' + e.message); process.exitCode = 1; }
}

if (MENU) runMenu();
else if (SEND_TEST) sendTestEntry();
else main();
