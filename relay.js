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
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '8788', 10);
const DATA_DIR = path.join(ROOT, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

/* ---------------- 配置（server-config.json 优先，其次 .example） ---------------- */
function loadConfig() {
  const p = path.join(ROOT, 'server-config.json');
  const p2 = path.join(ROOT, 'server-config.json.example');
  const f = fs.existsSync(p) ? p : (fs.existsSync(p2) ? p2 : null);
  if (!f) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
let cfg = loadConfig();
function deepseekKey() { return (cfg.deepseek && cfg.deepseek.apiKey) || ''; }
function ghToken() { return (cfg.github && cfg.github.token) || ''; }
function backupRepo() { return (cfg.github && cfg.github.backupRepo) || 'moxiaoren/discussion-room-server'; }
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';

/* ---------------- 前端在线更新（从 GitHub 仓库拉最新 index.html 覆盖本机） ---------------- */
function uiRepo() { return (cfg.updater && cfg.updater.repo) || 'moxiaoren/discussion-arena'; }
function uiBranch() { return (cfg.updater && cfg.updater.branch) || 'main'; }
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
  if (p === '/api/update' || p === '/api/update/') {
    // 前端触发：对比远端 GitHub 仓库 index.html 的版本，有新则覆盖本地
    (async () => {
      const local = currentAppVersion();
      try {
        const remoteHtml = await httpGetText('https://raw.githubusercontent.com/' + uiRepo() + '/' + uiBranch() + '/index.html');
        const m = remoteHtml.match(/APP_VERSION\s*=\s*'([\d.]+)'/);
        const remote = m ? m[1] : '';
        if (remote && remote !== local && remoteHtml.indexOf('<html') !== -1) {
          fs.writeFileSync(path.join(ROOT, 'index.html'), remoteHtml, 'utf8');
          console.log('🔄 已从仓库 ' + uiRepo() + '@' + uiBranch() + ' 更新 index.html: ' + local + ' -> ' + remote);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, updated: true, local, remote }));
        } else {
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
      if (!id || !rooms.has(id)) { send(ws, { type: 'join-failed', reason: '房间不存在或已销毁' }); return; }
      ws.roomId = id;
      rooms.get(id).add(ws);
      broadcast(id, { type: 'peer-joined' }, ws);
      send(ws, { type: 'joined' });
    } else if (m.type === 'relay' && r) {
      broadcast(r, { type: 'relay', data: m.data }, ws);
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
      if (set) { set.delete(ws); if (!set.size) rooms.delete(ws.roomId); }
    }
  });
});

server.listen(PORT, () => {
  console.log('✅ 论证点评间 · 服务器版已启动: ws://<host>:' + PORT);
  console.log('   AI 托管: ' + (deepseekKey() ? '已配置(服务端) ✓' : '未配置(前端将回退 BYOK/模拟)'));
  console.log('   私密备份: ' + (ghToken() ? '已配置 ✓ -> ' + backupRepo() : '未配置 GitHub token，存档仅保存本地'));
  console.log('   房间数: ' + rooms.size);
});
