#!/usr/bin/env node
/* ============================================================
   论证点评间 · 服务器版 · 中继 + 服务端能力
   ------------------------------------------------------------
   在极简中继(create/join/relay)基础上，新增服务端能力：
     - 静态页面(index.html)
     - 房间: create / join / rejoin，6 位口令
     - 转发: relay（同房间客户端互传）
     - AI 托管: ai 请求 → 服务器调 DeepSeek → ai-result 返回前端
               （key 在 server-config.json，前端免填；无 key 返回 ai-error，前端回退）
     - 存档: save 把房间存档存到 data/ 并(可选)push 到私有 GitHub 仓库做私密备份
     - 读取: load 返回本机存档
   ============================================================ */
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '8788', 10);
const APP_VERSION = '1.0.12';
const DATA_DIR = path.join(ROOT, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

/* ---------------- 配置（统一 settings.json 优先，旧配置自动迁移） ---------------- */
const SETTINGS_PATH = path.join(ROOT, 'settings.json');
function loadSettings() {
  if (fs.existsSync(SETTINGS_PATH)) { try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (e) {} }
  // 迁移：首次从旧配置文件合并生成 settings.json
  let s = {};
  try {
    const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-config.json'), 'utf8'));
    s.deepseek = old.deepseek || {}; s.github = old.github || {}; if (old.mail) s.mail = old.mail;
    if (old.updater) s.updater = old.updater;
  } catch (e) {}
  try {
    const push = JSON.parse(fs.readFileSync(path.join(ROOT, 'push-config.json'), 'utf8'));
    if (push.smtp) s.mail = Object.assign({}, push.smtp, { to: Array.isArray(push.to) ? push.to : [push.to].filter(Boolean) });
  } catch (e) {}
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8'); console.log('📎 已生成 settings.json（网页「设置」的新配置源，旧配置已迁移）'); } catch (e) {}
  return s;
}
function writeSettings(s) { try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8'); return true; } catch (e) { return false; } }
function deepseekKey() { const c = loadSettings(); return (c.deepseek && c.deepseek.apiKey) || ''; }
function deepseekModel() { const c = loadSettings(); return (c.deepseek && c.deepseek.model) || 'deepseek-chat'; }
function ghToken() { const c = loadSettings(); return (c.github && c.github.token) || ''; }
function backupRepo() { const c = loadSettings(); return (c.github && c.github.backupRepo) || 'moxiaoren/discussion-room-server'; }
function uiRepo() { const c = loadSettings(); return (c.updater && c.updater.repo) || 'moxiaoren/discussion-arena'; }
function uiBranch() { const c = loadSettings(); return (c.updater && c.updater.branch) || 'main'; }
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';

/* ---------------- 账号体系（data/accounts.json，固定两个成员账号） ---------------- */
const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json');
const ROOMSTATE_PATH = path.join(DATA_DIR, 'roomstate.json');
const DEFAULT_ACCOUNTS = [
  { account: 'xiaozhang', name: '小张', nick: '小张', avatar: '🟣' },
  { account: 'xiaozhou', name: '小周', nick: '小周', avatar: '🔵' }
];
const AVATARS = ['🟣', '🔵', '🟢', '🟡', '🟠', '🔴', '⚫️', '⚪️'];
function loadAccounts() {
  if (fs.existsSync(ACCOUNTS_PATH)) {
    try { const a = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')); if (a && Array.isArray(a.accounts) && a.accounts.length) return a.accounts; } catch (e) {}
  }
  // 首次创建两个账号，默认密码 000000
  const accounts = DEFAULT_ACCOUNTS.map((acc) => { const salt = crypto.randomBytes(8).toString('hex'); return Object.assign({}, acc, { salt, pwdHash: hashPwd('000000', salt) }); });
  try { fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify({ accounts }, null, 2), 'utf8'); console.log('👥 已创建账号体系(小张/小周，默认密码 000000)'); } catch (e) {}
  return accounts;
}
function writeAccounts(list) { try { fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify({ accounts: list }, null, 2), 'utf8'); return true; } catch (e) { return false; } }
function findAccount(acc) { return (loadAccounts().find((x) => x.account === acc)) || null; }
function publicUser(u) { return { account: u.account, name: u.name, nick: u.nick, avatar: u.avatar }; }
function checkAccount(acc, pwd) { const u = findAccount(acc); return !!(u && u.salt && u.pwdHash && hashPwd(String(pwd || ''), u.salt) === u.pwdHash); }
/* ---------------- 房间状态（当前活跃房间，服务端共享） ---------------- */
function loadRoomState() { if (fs.existsSync(ROOMSTATE_PATH)) { try { return JSON.parse(fs.readFileSync(ROOMSTATE_PATH, 'utf8')); } catch (e) {} } return null; }
function writeRoomState(s) { try { fs.writeFileSync(ROOMSTATE_PATH, JSON.stringify(s, null, 2), 'utf8'); return true; } catch (e) { return false; } }
/* 存档元信息列表：data/*.json 排除 accounts/roomstate */
function roomArchiveList() {
  let out = [];
  try {
    const files = fs.readdirSync(DATA_DIR).filter((f) => /\.json$/i.test(f) && f !== 'accounts.json' && f !== 'roomstate.json');
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        out.push({ roomId: j.roomId || path.basename(f, '.json'), title: j.title || '', endTs: j.endTs || j.exportedAt || 0, msgCount: (j.messages && j.messages.length) || 0 });
      } catch (e) {}
    }
  } catch (e) {}
  out.sort((a, b) => (b.endTs || 0) - (a.endTs || 0));
  return out;
}

/* ---------------- 前端在线更新（从 GitHub 仓库拉最新 index.html 覆盖本机） ---------------- */
function currentAppVersion() {
  const f = path.join(ROOT, 'index.html');
  try { const s = fs.readFileSync(f, 'utf8'); const m = s.match(/APP_VERSION\s*=\s*'([\d.]+)'/); return m ? m[1] : ''; } catch (e) { return ''; }
}
function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
  });
}

/* ---------------- 网页「设置」：管理密码 + 配置读写（密码保护） ---------------- */
function hashPwd(pwd, salt) { return crypto.createHash('sha256').update(String(salt) + '__arena__' + String(pwd)).digest('hex'); }
function verGt(a, b){ const pa=String(a||'').split('.').map(x=>parseInt(x,10)||0), pb=String(b||'').split('.').map(x=>parseInt(x,10)||0); const n=Math.max(pa.length,pb.length); for(let i=0;i<n;i++){ const x=pa[i]||0,y=pb[i]||0; if(x!==y) return x>y; } return false; }
function b64d(b){ try{ return Buffer.from(b,'base64').toString('utf8'); }catch(e){ return ''; } }
function mask(v) { if (v == null || v === '') return ''; v = String(v); if (v.length <= 4) return '••••'; return v.slice(0, 2) + '…' + v.slice(-4); }
function authInfo() { const c = loadSettings(); return (c.auth) || {}; }
function jsonRes(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function maskedSettings() {
  const c = loadSettings();
  return {
    managePwdSet: !!authInfo().pwdHash,
    deepseek: { apiKey: mask(c.deepseek && c.deepseek.apiKey), model: (c.deepseek && c.deepseek.model) || 'deepseek-chat' },
    github: { token: mask(c.github && c.github.token), updateRepo: (c.github && c.github.updateRepo) || '', backupRepo: (c.github && c.github.backupRepo) || 'moxiaoren/discussion-room-server' },
    mail: {
      host: (c.mail && c.mail.host) || '', port: (c.mail && c.mail.port) || 465,
      user: (c.mail && c.mail.user) || '', pass: mask(c.mail && c.mail.pass), from: (c.mail && c.mail.from) || '',
      to: Array.isArray(c.mail && c.mail.to) ? c.mail.to : []
    }
  };
}
function checkPwd(pwd) { const a = authInfo(); return !!(a.pwdHash && a.salt && hashPwd(String(pwd || ''), a.salt) === a.pwdHash); }
function handleAdmin(path, data, res) {
  if (path === '/api/admin/password') {
    const newPwd = String(data.pwd || '');
    if (newPwd.length < 4) { jsonRes(res, { ok: false, message: '管理密码至少 4 位' }); return; }
    const has = !!authInfo().pwdHash;
    if (has && !checkPwd(data.oldPwd)) { jsonRes(res, { ok: false, message: '原密码错误' }); return; }
    const salt = crypto.randomBytes(8).toString('hex');
    const c = loadSettings(); c.auth = { salt, pwdHash: hashPwd(newPwd, salt) };
    if (writeSettings(c)) jsonRes(res, { ok: true, message: has ? '管理密码已修改' : '管理密码已设置' });
    else jsonRes(res, { ok: false, message: '写入配置失败' });
    return;
  }
  // /api/admin/settings —— 需密码；敏感字段留空=不修改
  if (!authInfo().pwdHash) { jsonRes(res, { ok: false, needPassword: true, message: '请先在「设置」中设置管理密码' }); return; }
  if (!checkPwd(data.pwd)) { jsonRes(res, { ok: false, message: '管理密码错误' }); return; }
  const c = loadSettings();
  const d = data.data || {};
  if (d.deepseek) {
    c.deepseek = c.deepseek || {};
    if (d.deepseek.apiKey != null && String(d.deepseek.apiKey).trim()) c.deepseek.apiKey = String(d.deepseek.apiKey).trim();
    if (d.deepseek.model != null && String(d.deepseek.model).trim()) c.deepseek.model = String(d.deepseek.model).trim();
  }
  if (d.github) {
    c.github = c.github || {};
    if (d.github.token != null && String(d.github.token).trim()) c.github.token = String(d.github.token).trim();
    if (d.github.backupRepo != null && String(d.github.backupRepo).trim()) c.github.backupRepo = String(d.github.backupRepo).trim();
    if (d.github.updateRepo != null && String(d.github.updateRepo).trim()) c.github.updateRepo = String(d.github.updateRepo).trim();
  }
  if (d.mail) {
    const m = c.mail || {};
    const nm = {
      host: (d.mail.host != null ? String(d.mail.host).trim() : (m.host || '')),
      port: d.mail.port != null ? (parseInt(d.mail.port, 10) || 465) : (m.port || 465),
      user: (d.mail.user != null ? String(d.mail.user).trim() : (m.user || '')),
      from: (d.mail.from != null ? String(d.mail.from).trim() : (m.from || '')),
      to: Array.isArray(d.mail.to) ? d.mail.to.map(x => String(x).trim()).filter(Boolean) : (Array.isArray(m.to) ? m.to : [])
    };
    // pass 留空 = 不修改
    if (d.mail.pass != null && String(d.mail.pass).trim()) nm.pass = String(d.mail.pass).trim();
    else if (m.pass) nm.pass = m.pass;
    c.mail = nm;
  }
  if (writeSettings(c)) jsonRes(res, { ok: true, message: '已保存（SMTP/DeepSeek 改动即时生效；如不推送可稍后重启）', settings: maskedSettings() });
  else jsonRes(res, { ok: false, message: '写入配置失败' });
}

/* ---------------- DeepSeek 调用（服务端 AI 托管） ---------------- */
function callDeepSeek(messages, model) {
  return new Promise((resolve, reject) => {
    const key = deepseekKey();
    if (!key) { reject(new Error('服务器未配置 deepseek.apiKey')); return; }
    const body = JSON.stringify({ model: model || 'deepseek-chat', messages, stream: false });
    const u = new URL('/chat/completions', DEEPSEEK_BASE);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/* ---------------- GitHub 私密备份（push 到私有仓库） ---------------- */
function ghPush(gitPath, content, commitMsg) {
  return new Promise((resolve) => {
    const token = ghToken();
    if (!token) { resolve(false); return; }
    const base = 'https://api.github.com/repos/' + backupRepo() + '/contents/' + gitPath;
    const getSha = () => new Promise((r) => {
      const req = https.get(base, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'discussion-room-server', 'Accept': 'application/vnd.github+json' } }, (res) => {
        let d = ''; res.on('data', (c) => d += c);
        res.on('end', () => { try { const j = JSON.parse(d); r(j && j.sha ? j.sha : null); } catch (e) { r(null); } });
      });
      req.on('error', () => r(null));
    });
    (async () => {
      const sha = await getSha();
      const payload = { message: commitMsg || 'backup', content: Buffer.from(content).toString('base64') };
      if (sha) payload.sha = sha;
      const req = https.request(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'User-Agent': 'discussion-room-server', 'Accept': 'application/vnd.github+json' }
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200 || res.statusCode === 201)); });
      req.on('error', () => resolve(false));
      req.write(JSON.stringify(payload)); req.end();
    })();
  });
}

/* ---------------- 房间表 ---------------- */
const rooms = new Map();
/* 房间进行中的消息(供后来者登录后回放)：落盘 data/live/{roomId}.json，启动加载 */
const LIVE_DIR = path.join(DATA_DIR, 'live');
const liveMsgs = new Map();
try { if (fs.existsSync(LIVE_DIR)) { for (const f of fs.readdirSync(LIVE_DIR)) { if (/\.json$/i.test(f)) { try { const d = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, f), 'utf8')); if (d && d.roomId && Array.isArray(d.msgs)) liveMsgs.set(d.roomId, d.msgs); } catch (e) {} } } } } catch (e) {}
function recordLive(roomId, data){
  if (!data || data.type !== 'msg' || !data.m || !data.m.id) return;
  if (!/^\d{6}$/.test(roomId)) return;
  let arr = liveMsgs.get(roomId);
  if (!arr) { arr = []; liveMsgs.set(roomId, arr); }
  if (arr.find(x => x.id === data.m.id)) return;
  arr.push(data.m);
  try { fs.mkdirSync(LIVE_DIR, { recursive: true }); fs.writeFile(path.join(LIVE_DIR, roomId + '.json'), JSON.stringify({ roomId, msgs: arr }), 'utf8', () => {}); } catch (e) {}
}
function delLive(roomId, id){
  if (!roomId || !id || !/^\d{6}$/.test(roomId)) return;
  let arr = liveMsgs.get(roomId);
  if (!Array.isArray(arr)) return;
  const next = arr.filter(x => x.id !== id);
  if (next.length !== arr.length) {
    liveMsgs.set(roomId, next);
    try { fs.mkdirSync(LIVE_DIR, { recursive: true }); fs.writeFile(path.join(LIVE_DIR, roomId + '.json'), JSON.stringify({ roomId, msgs: next }), 'utf8', () => {}); } catch (e) {}
  }
}
function genId() { return String(Math.floor(100000 + Math.random() * 900000)); }
function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(roomId, obj, except) {
  const set = rooms.get(roomId);
  if (!set) return;
  set.forEach((ws) => { if (ws !== except) send(ws, obj); });
}

/* ---------------- 静态文件 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0];
  // ===== 网页「设置」管理接口（密码保护）=====
  // ===== 账号体系（登录 / 资料 / 房间状态 / 存档列表 / 只读拉取）=====
  if (p === '/api/auth/status') {
    jsonRes(res, { ok: true, accounts: loadAccounts().map(publicUser) }); return;
  }
  if (p === '/api/auth/login') {
    if (req.method !== 'POST') { jsonRes(res, { ok: false, message: '请用 POST' }); return; }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body); } catch (e) {}
      const acc = String(d.account || '').trim();
      if (!checkAccount(acc, d.pwd)) { jsonRes(res, { ok: false, message: '账号或密码错误' }); return; }
      jsonRes(res, { ok: true, user: publicUser(findAccount(acc)) });
    });
    return;
  }
  if (p === '/api/account/update') {
    if (req.method !== 'POST') { jsonRes(res, { ok: false, message: '请用 POST' }); return; }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body); } catch (e) {}
      const acc = String(d.account || '').trim();
      if (!findAccount(acc)) { jsonRes(res, { ok: false, message: '账号不存在' }); return; }
      if (!checkAccount(acc, d.oldPwd)) { jsonRes(res, { ok: false, message: '原密码错误' }); return; }
      const list = loadAccounts();
      const target = list.find((x) => x.account === acc);
      if (!target) { jsonRes(res, { ok: false, message: '账号不存在' }); return; }
      if (d.nick != null && String(d.nick).trim()) target.nick = String(d.nick).trim().slice(0, 20);
      if (d.avatar != null && AVATARS.includes(String(d.avatar))) target.avatar = String(d.avatar);
      if (d.newPwd != null && String(d.newPwd).trim()) {
        if (String(d.newPwd).trim().length < 4) { jsonRes(res, { ok: false, message: '新密码至少 4 位' }); return; }
        target.salt = crypto.randomBytes(8).toString('hex');
        target.pwdHash = hashPwd(String(d.newPwd).trim(), target.salt);
      }
      if (writeAccounts(list)) jsonRes(res, { ok: true, user: publicUser(target), message: '保存成功' });
      else jsonRes(res, { ok: false, message: '写入失败' });
    });
    return;
  }
  if (p === '/api/room/active') {
    if (req.method === 'GET') { jsonRes(res, { ok: true, room: loadRoomState() }); return; }
    // POST 创建/设置当前活跃房间（指定 roomId 或由服务器生成 6 位房号）
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body); } catch (e) {}
      let id;
      if (d.roomId && /^\d{6}$/.test(d.roomId)) id = d.roomId;
      else { do { id = genId(); } while (fs.existsSync(path.join(DATA_DIR, id + '.json'))); }
      const rs = { roomId: id, title: String(d.title || '').slice(0, 40), creator: String(d.creator || ''), createdAt: Date.now(), updatedAt: Date.now() };
      writeRoomState(rs);
      jsonRes(res, { ok: true, room: rs });
    });
    return;
  }
  if (p === '/api/room/list') {
    jsonRes(res, { ok: true, archives: roomArchiveList() }); return;
  }
  if (p === '/api/archive') {
    // 切话题/结束时的完整存档:写 data/{roomId}.json + 自动推 GitHub 兜底
    if (req.method !== 'POST') { jsonRes(res, { ok: false, message: '请用 POST' }); return; }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body); } catch (e) {}
      const id = d.roomId, data = d.data;
      if (!id || !/^\d{6}$/.test(id) || !data) { jsonRes(res, { ok: false, message: '缺少 roomId/data' }); return; }
      const fp = path.join(DATA_DIR, id + '.json');
      try { fs.writeFileSync(fp, JSON.stringify(data), 'utf8'); } catch (e) { jsonRes(res, { ok: false, message: '写入失败' }); return; }
      ghPush('history/' + id + '.json', JSON.stringify(data), '备份房间 ' + id).catch(() => {});
      jsonRes(res, { ok: true, message: '已存档(含 GitHub 备份)' });
    });
    return;
  }
  if (p === '/api/room/load') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const id = qs.get('id') || '';
    const fp = path.join(DATA_DIR, id + '.json');
    if (/^\d{6}$/.test(id) && fs.existsSync(fp)) {
      try { jsonRes(res, { ok: true, data: JSON.parse(fs.readFileSync(fp, 'utf8')) }); return; } catch (e) {}
    }
    jsonRes(res, { ok: false, message: '存档不存在' }); return;
  }
  if (p === '/api/admin/needpwd') {
    jsonRes(res, { ok: true, managePwdSet: !!authInfo().pwdHash }); return;
  }
  if (p === '/api/admin/settings' && req.method === 'GET') {
    const qs = new URL(req.url, 'http://x').searchParams;
    if (!authInfo().pwdHash) { jsonRes(res, { ok: false, needPassword: true, message: '请先设置管理密码' }); return; }
    if (!checkPwd(qs.get('pwd'))) { jsonRes(res, { ok: false, message: '管理密码错误' }); return; }
    jsonRes(res, { ok: true, settings: maskedSettings() }); return;
  }
  if (p === '/api/admin/password' || p === '/api/admin/settings') {
    if (req.method !== 'POST') { jsonRes(res, { ok: false, message: '请用 POST' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => { let data = {}; try { data = JSON.parse(body); } catch (e) {} handleAdmin(p, data, res); });
    return;
  }
  if (p === '/api/update' || p === '/api/update/') {
    // 前端触发：对比远端 GitHub 仓库 index.html 版本，仅当远端版本 > 本地才覆盖；不高于本地一律跳过（禁止回退）
    (async () => {
      const local = currentAppVersion();
      try {
        let remoteHtml = '';
        const tk = ghToken();
        if (tk) {
          const rres = await fetch('https://api.github.com/repos/' + uiRepo() + '/contents/index.html?ref=' + uiBranch(), { headers: { Authorization: 'Bearer ' + tk, 'User-Agent': 'openclaw-note', 'Accept': 'application/vnd.github+json' } });
          if (rres.ok) { const rj = await rres.json(); remoteHtml = b64d(rj.content || ''); }
        }
        if (!remoteHtml) remoteHtml = await httpGetText('https://raw.githubusercontent.com/' + uiRepo() + '/' + uiBranch() + '/index.html');
        const m = remoteHtml.match(/APP_VERSION\s*=\s*'([\d.]+)'/);
        const remote = m ? m[1] : '';
        // 同步本地 version.json,避免其落后于 index 导致前端版本自检误报
        try{
          let vjson='';
          if(tk){ const vres=await fetch('https://api.github.com/repos/' + uiRepo() + '/contents/version.json?ref=' + uiBranch(), { headers: { Authorization: '***' + tk, 'User-Agent': 'openclaw-note', 'Accept': 'application/vnd.github+json' } }); if(vres.ok){ const vj=await vres.json(); vjson=b64d(vj.content || ''); } }
          if(!vjson) vjson = await httpGetText('https://raw.githubusercontent.com/' + uiRepo() + '/' + uiBranch() + '/version.json');
          if(vjson){ let vr=''; try{ vr=JSON.parse(vjson).version||''; }catch(e){} let vl=''; try{ vl=(JSON.parse(fs.readFileSync(path.join(ROOT,'version.json'),'utf8')||'{}').version)||''; }catch(e){} if(vr && verGt(vr, vl||'0.0.0')){ fs.writeFileSync(path.join(ROOT,'version.json'), vjson, 'utf8'); } }
        }catch(e){}
        const newer = !!remote && verGt(remote, local);
        if (newer && remoteHtml.indexOf('<html') !== -1) {
          fs.writeFileSync(path.join(ROOT, 'index.html'), remoteHtml, 'utf8');
          console.log('🔄 已从仓库 ' + uiRepo() + '@' + uiBranch() + ' 更新 index.html: ' + local + ' -> ' + remote);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, updated: true, local, remote }));
        } else {
          if (remote && local && remote !== local) console.log('（仓库 index 版本 ' + remote + ' 不高于本地 ' + local + '，跳过更新，避免回退）');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, updated: false, local, remote }));
        }
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, updated: false, message: String((e && e.message) || e) }));
      }
    })();
    return;
  }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  const ext = path.extname(file).toLowerCase();
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.roomId = null;
  // 告知前端服务器能力（AI 托管 / GitHub 备份 是否已配置）
  send(ws, { type: 'server-info', ai: !!deepseekKey(), github: !!ghToken() });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const r = ws.roomId;
    if (m.type === 'create') {
      let id; do { id = genId(); } while (rooms.has(id));
      rooms.set(id, new Set());
      rooms.get(id).add(ws);
      ws.roomId = id;
      send(ws, { type: 'created', roomId: id });
    } else if (m.type === 'join' || m.type === 'rejoin') {
      const id = m.roomId;
      if (!id || !/^\d{6}$/.test(id)) { send(ws, { type: 'join-failed', reason: '房间号不正确' }); return; }
      if (!rooms.has(id)) rooms.set(id, new Set()); // 账号制:房号来自服务器 roomstate,缺失时自动建转发组
      ws.roomId = id;
      rooms.get(id).add(ws);
      broadcast(id, { type: 'peer-joined' }, ws);
      send(ws, { type: 'joined' });
      broadcast(id, { type: 'room-size', count: rooms.get(id).size }); // 通知全体当前人数(仅自己在线时可单方面结束)
      const hist = liveMsgs.get(id);
      if (hist && hist.length) send(ws, { type: 'room-history', roomId: id, msgs: hist.slice() });
    } else if (m.type === 'relay' && r) {
      broadcast(r, { type: 'relay', data: m.data }, ws);
      if (m.data && m.data.type === 'rmmsg') delLive(r, m.data.id); // 撤回:同步从服务端 live 删除,防止刷新回放旧消息
      else recordLive(r, m.data); // 记录消息供后来者登录后回放
    } else if (m.type === 'ping') {
      send(ws, { type: 'pong' });
    } else if (m.type === 'ai') {
      // 前端请求 AI：服务器调 DeepSeek 并返回
      const d = m.data || {};
      callDeepSeek(d.messages || [], d.model)
        .then((content) => send(ws, { type: 'ai-result', data: { reqId: d.reqId, content } }))
        .catch((e) => send(ws, { type: 'ai-error', data: { reqId: d.reqId, message: e.message } }));
    } else if (m.type === 'save') {
      // 前端存当前房间存档：写 data/<roomId>.json + 私密备份
      const id = m.roomId || r;
      const data = m.data;
      if (id && data) {
        const fp = path.join(DATA_DIR, id + '.json');
        try {
          fs.writeFileSync(fp, JSON.stringify(data), 'utf8');
          send(ws, { type: 'saved', roomId: id });
          // 私密备份（异步，不阻塞）
          ghPush('history/' + id + '.json', JSON.stringify(data), 'backup room ' + id)
            .then((ok) => { if (ok) console.log('☁️ 已备份房间 ' + id + ' 到私有仓库'); })
            .catch(() => {});
        } catch (e) { send(ws, { type: 'saved', roomId: id, local: true }); }
      } else { send(ws, { type: 'save-failed', reason: '缺少 roomId/data' }); }
    } else if (m.type === 'load') {
      // 读取本机存档
      const id = m.roomId;
      const fp = path.join(DATA_DIR, id + '.json');
      if (id && fs.existsSync(fp)) {
        try { send(ws, { type: 'load-result', roomId: id, data: JSON.parse(fs.readFileSync(fp, 'utf8')) }); }
        catch (e) { send(ws, { type: 'load-result', roomId: id, data: null }); }
      } else { send(ws, { type: 'load-result', roomId: id, data: null }); }
    }
  });
  ws.on('close', () => {
    if (ws.roomId) {
      const set = rooms.get(ws.roomId);
      if (set) { set.delete(ws); if (!set.size) rooms.delete(ws.roomId); else broadcast(ws.roomId, { type: 'room-size', count: set.size }); }
    }
  });
});

server.listen(PORT, () => {
  console.log('✅ 论证点评间 · 服务器版已启动: ws://<host>:' + PORT);
  console.log('   AI 托管: ' + (deepseekKey() ? '已配置(服务端) ✓' : '未配置(前端将回退 BYOK/模拟)'));
  console.log('   私密备份: ' + (ghToken() ? '已配置 ✓ -> ' + backupRepo() : '未配置 GitHub token，存档仅保存本地'));
  console.log('   房间数: ' + rooms.size);
});
