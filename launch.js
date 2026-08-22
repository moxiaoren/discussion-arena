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
// 邮箱配置统一从 settings.json（网页「设置」写入）读取；无则兼容旧 push-config.json / server-config.json
function loadMailCfg() {
  const s = loadJson('settings.json');
  if (s && s.mail && s.mail.host && s.mail.user) {
    return { smtp: s.mail, to: Array.isArray(s.mail.to) ? s.mail.to : [s.mail.to].filter(Boolean) };
  }
  const push = loadJson('push-config.json');
  if (push && push.smtp) return { smtp: push.smtp, to: Array.isArray(push.to) ? push.to : [push.to].filter(Boolean) };
  const sc = loadJson('server-config.json');
  if (sc && sc.mail) return { smtp: sc.mail, to: Array.isArray(sc.mail.to) ? sc.mail.to : [sc.mail.to].filter(Boolean) };
  return null;
}
/* ---------------- 版本与功能介绍 / 更新说明（用于邮件推送正文） ---------------- */
const APP_INTRO = [
  '论证点评间 · 你和好友的专属异地在线讨论页：',
  '· 账号登录(小张/小周)，登录后直接进入当前讨论房间(房号仅作标识，无需输入)',
  '· 整理/点评双模式：AI 中立整理 + 多维度论证点评(逻辑/语言/体系/价值/漏洞) + 反方质询',
  '· 切换新话题时自动三层存档(本地 + 服务器 + GitHub 兜底)，可只读回看复盘',
  '· AI 由服务器托管，无需填 Key；配置见网页右上角「⚙️ 设置」(密码保护)'
].join('\n');
const RELEASE_NOTES = [
  { version: 'v1.0.14', notes: [
    '回到主页后新增「⏪ 回到进行中的讨论」恢复按钮（点击直接恢复会话）',
    '复盘回放控件精简为仅保留 播放/暂停、上一个、下一个、倍速',
    '房间栏（房号/点评整理/主页/新话题/结束）压缩为单行，适配窄屏与手机',
    '移除过期提示「等待好友加入...(另开标签页输入口令)」；复盘回放已含 AI 论证点评卡片节点'
  ] },
  { version: 'v1.0.13', notes: [
    '「论证点评」设为默认模式；修复点评模式下结束复盘看不到/不生成 AI 点评（复盘回放与评估面板已纳入论证点评卡）',
    '对话式回放改为固定间隔逐条展现（每条留足时间看消息和 AI 点评，不再受真实时间间隔影响）',
    '结束讨论后刷新回到主页（自动清除活跃房间，可新建新讨论）',
    '讨论间新增「🏠 主页」按钮可回到大厅；历史存档支持删除'
  ] },
  { version: 'v1.0.12', notes: [
    '结束逻辑优化：当房间只有你一个人在线（好友不在或已离开）时，点「结束讨论」可直接单方面结束并进入复盘，无需等待对方确认；双方都在线时仍按双方确认流程'
  ] },
  { version: 'v1.0.11', notes: [
    '修复版本徽标误报“发现新版本 v1.0.5”——前端版本自检改为语义比较并禁止降级（本地 version.json 落后于 index 时不再误报）；同时把 version.json 纳入在线更新范围，下次自动对齐'
  ] },
  { version: 'v1.0.10', notes: [
    '修复撤回的消息刷新后又出现——撤回现在同步从服务端删除，并本地持久化“已删集合”，刷新/重连不再回放已撤回的消息',
    '「怎么玩」提示条右上角新增 ✕，一键关闭并记住（不再反复占对话框空间）；顺带压缩顶栏/对话流/房间栏内边距，给对话让出更多空间'
  ] },
  { version: 'v1.0.9', notes: [
    '修复版本更新推送问题：①不再把仓库旧版本(如缓存返回的低版本号)当成新版本提示升级或回退，只有远端版本确实高于本地才更新；②修正更新守护对行尾差异误判导致高频覆盖、反复重启刷新；③限制前端自动更新检查频率，避免页面反复刷新'
  ] },
  { version: 'v1.0.8', notes: [
    '手机/窄屏适配优化：修复整体页面出现滚动条的问题——body 改用动态视口高度(100dvh)并禁止横向溢出；登录/大厅容器(lobby)改为可收缩 + 内容超高时内部滚动，不再把整个页面撑出滚动条'
  ] },
  { version: 'v1.0.7', notes: [
    '阶段「论证点评」改为简短版：只突出 1-2 个亮点与 1-2 个主要不足 + 一个总分与一句总评，不再逐维度长篇展开（深入分析保留给结束后的复盘）',
    '刷新/重进页面自动保持登录（记住上次身份，直到清理浏览器缓存）；个人资料弹层新增「退出登录」可切换账号'
  ] },
  { version: 'v1.0.6', notes: [
    '修复：后来者登录进入房间时，自动回放该房间此前已发送的消息（讨论+弹幕），不再只看到自己之后的发言',
    '改进：在线更新日志分别提示缺失项（更新仓库 / Token），不再笼统报“未配置 token”误导排查'
  ] },
  { version: 'v1.0.5', notes: [
    '新增 GitHub 在线更新配置入口（⚙️设置）：填好更新仓库+Token 后，后端(relay/launch)改动自动在线更新并重启，不再需要手动整包安装',
    '修复：登录成功后收齐「选择身份/输密码」表单，避免误以为未登录'
  ] },
  { version: 'v1.0.4', notes: [
    '新增账号体系：登录(小张/小周)、修改昵称/头像/密码',
    '进入方式改为账号登录后直达当前房间，口令仅作房间号展示',
    '切换话题强制三层存档(本地+服务器+GitHub 自动兜底)，支持只读回看',
    '重写使用说明与页面文案(账号制+服务器版)'
  ] },
  { version: 'v1.0.3', notes: ['剔除遗留的公开高级设置区块，配置统一收进密码保护的 ⚙️ 设置'] }
];
function releaseSummary() {
  return RELEASE_NOTES.slice(0, 2).map((r) => '【' + r.version + '】' + r.notes.map((n) => '\n  · ' + n).join('')).join('\n\n');
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
// 校验 cloudflared 可执行文件有效性：Windows 下必须是 PE 格式（前两字节 'MZ'）且大小足够；否则视为损坏
function validCloudflared(p) {
  try {
    const s = fs.statSync(p);
    if (!s.isFile() || s.size < 2 * 1024 * 1024) return false; // 至少 2MB（真实约 15~50MB）
    if (process.platform === 'win32') {
      const b = fs.readFileSync(p).subarray(0, 2);
      return b.length >= 2 && b[0] === 0x4D && b[1] === 0x5A; // 'MZ'
    }
    return s.size > 1024 * 1024;
  } catch (e) { return false; }
}
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
  // 存在但可能是坏文件（下载中断/镜像返回错误内容/被杀软改坏）→ 校验有效性，无效则删除重下
  if (fs.existsSync(local)) {
    if (validCloudflared(local)) { CF_BIN = local; return true; }
    log('⚠ 检测到 ' + exe + ' 损坏（文件头/大小校验失败），自动删除并重新下载...');
    try { fs.unlinkSync(local); } catch (e) {}
  }
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
  // 现在统一用 settings.json（网页「⚙️设置」写）。无则生成模板，优先从旧配置迁移
  const sp = path.join(ROOT, 'settings.json');
  if (fs.existsSync(sp)) return;
  let s = {};
  const push = loadJson('push-config.json');
  const sc = loadJson('server-config.json');
  if (push && push.smtp) s.mail = Object.assign({}, push.smtp, { to: Array.isArray(push.to) ? push.to : [push.to].filter(Boolean) });
  else if (sc && sc.mail) s.mail = sc.mail;
  else {
    s.mail = { host: 'smtp.qq.com', port: 465, user: 'yourQQ@qq.com', pass: 'your-auth-code', from: 'yourQQ@qq.com', to: ['receiver@example.com'] };
  }
  try { fs.writeFileSync(sp, JSON.stringify(s, null, 2), 'utf8'); log('📝 已生成 settings.json（API Key / 邮箱请在网页「⚙️ 设置」里填，密码保护；不再需要手动编辑本文件）'); }
  catch (e) { log('⚠ 无法写 settings.json: ' + e.message); }
}

function openSettingsFile() {
  if (process.platform === 'win32') { spawn('notepad', [path.join(ROOT, 'settings.json')], { stdio: 'ignore' }); }
  else { log('settings.json 路径: ' + path.join(ROOT, 'settings.json')); }
  log('（推荐：直接在网页右上角「⚙️ 设置」里配置邮箱与 API Key，密码保护更安全）');
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
  const s = loadJson('settings.json') || {};
  const gh = s.github || {};
  const upd = s.updater || {};
  const repo = (gh && gh.updateRepo) || (upd && upd.repo);
  const token = gh && gh.token;
  if (!repo) {
    if (!silent) log('（未配置 github.updateRepo 更新仓库，跳过在线更新；请在网页 ⚙️设置 →「GitHub 在线更新」填写更新仓库）');
    return false;
  }
  if (!token) { if (!silent) log('（未配置 github.token，跳过在线更新；请在 ⚙️设置 →「GitHub 在线更新」填写 Token）'); return false; }
  const files = ['index.html', 'relay.js', 'launch.js', 'version.json', 'server-config.json.example'];
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
      const norm = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (norm(remote) !== norm(local)) {
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
      if (a === '5') { ensurePushConfig(); openSettingsFile(); waitThen(rl, loop); return; }
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
  const mailCfg = loadMailCfg();
  if (!mailCfg) { log('✗ 未配置邮箱，请在网页「⚙️设置」里填写发信邮箱'); return 1; }
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
  cf.on('error', (e) => { log('⚠ 启动 Cloudflare 隧道失败: ' + ((e && e.code) || (e && e.message)) + '（cloudflared.exe 可能损坏或被杀软拦截。请删除后重跑 install-menu 选 1 重新下载，或手动放置新版）'); });
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
    const mailCfg = loadMailCfg();
    if (!mailCfg) { log('⚠ 未配置邮箱，跳过推送。\n   （在网页「⚙️ 设置」里填写发信邮箱后会自动推送）'); return; }
    log('[3/3] 正在把新网址发往邮箱 ' + (mailCfg.to || []).join(',') + ' ...');
    sendMail(mailCfg, '论证点评间 · 新地址',
      '你的「论证点评间」新网址：\n\n' + url + '\n\n【功能简介】\n' + APP_INTRO + '\n\n【更新说明】\n' + releaseSummary() + '\n\n把这个网址发给好友即可开始异地讨论。\n（隧道或电脑重启后地址会变化，届时会再次收到新地址）')
      .then(() => log('✅ 已推送成功'))
      .catch((e) => log('✗ 邮件推送失败: ' + e.message + '\n  （不影响聊天，地址在上方 / last-url.txt）'));
  }

  log('\n等待生成网址（首次约 5-15 秒）...\n');
}

async function sendTestEntry() {
  log('== 测试邮件发送（--send-test）==');
  const mailCfg = loadMailCfg();
  if (!mailCfg) { log('✗ 未配置邮箱，请在网页「⚙️设置」里填写发信邮箱'); process.exitCode = 1; return; }
  try { await sendMail(mailCfg, '论证点评间 · SMTP 配置测试', '如果你收到这封邮件，说明邮箱推送配置正确。'); log('✅ 测试邮件发送成功，请去邮箱确认。'); }
  catch (e) { log('✗ 发送失败: ' + e.message); process.exitCode = 1; }
}

if (MENU) runMenu();
else if (SEND_TEST) sendTestEntry();
else main();
