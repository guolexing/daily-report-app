// 极造数字 · 日报工具 内置服务（桌面版主进程启动：静态页面 + AI 汇总代理 + MySQL 数据持久化）
// 用法：由 Electron 主进程（main.js）以 runtime\node.exe 启动
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ================= MySQL 数据持久化 =================
// 配置保存在 db_config.json；未配置/未安装驱动时优雅降级为 localStorage-only。
// 数据目录：桌面版由 Electron 主进程注入 userData；Web 版默认当前目录（db_config.json 可写）
const DATA_DIR = process.env.JZD_DATA_DIR || __dirname;
const DB_CONFIG_FILE = path.join(DATA_DIR, 'db_config.json');
// 首次运行（userData 无配置时）继承随包分发的 db_config.json（Web 版同目录则跳过）
if (DATA_DIR !== __dirname && !fs.existsSync(DB_CONFIG_FILE)) {
  const seed = path.join(__dirname, 'db_config.json');
  try { if (fs.existsSync(seed)) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.copyFileSync(seed, DB_CONFIG_FILE); } } catch (e) {}
}
let mysql = null;
let dbPool = null;
let dbCfg = null;

function readDbConfig() {
  try { return JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch (e) { return null; }
}
function writeDbConfig(cfg) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(DB_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
function loadMysql() {
  if (mysql) return mysql;
  try { mysql = require('mysql2/promise'); } catch (e) { mysql = null; }
  return mysql;
}

// 连接 + 自动建库建表（幂等）
async function ensureDb(cfg) {
  const m = loadMysql();
  if (!m) throw new Error('未安装 mysql2 驱动');
  if (!cfg || !cfg.user) throw new Error('请先在「数据存储」设置里填写 MySQL 连接信息');
  const base = {
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port) || 3306,
    user: cfg.user,
    password: cfg.password || '',
    connectTimeout: 5000
  };
  // 先连服务器（不带库），库不存在则创建
  const conn = await m.createConnection(base);
  const dbName = (cfg.database || 'jzd_daily').replace(/[^\w]/g, '');
  await conn.query('CREATE DATABASE IF NOT EXISTS \x60' + dbName + '\x60 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await conn.end();
  // 再连目标库
  dbPool = m.createPool(Object.assign({}, base, { database: dbName, connectionLimit: 5 }));
  await dbPool.query('CREATE TABLE IF NOT EXISTS jzd_state (k VARCHAR(64) PRIMARY KEY, v LONGTEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  dbCfg = Object.assign({}, cfg, { database: dbName });
  writeDbConfig(dbCfg);
  return { ok: true, database: dbName };
}

async function getState() {
  if (!dbPool) return null;
  const [rows] = await dbPool.query('SELECT k, v FROM jzd_state');
  const items = {};
  rows.forEach(r => { items[r.k] = r.v; });
  return items;
}

async function setState(items) {
  if (!dbPool) return { ok: false };
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    const keys = Object.keys(items || {});
    for (const k of keys) {
      await conn.query('INSERT INTO jzd_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, String(items[k])]);
    }
    await conn.commit();
    return { ok: true, count: keys.length };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}
function sqlEscape(v) {
  if (v === null || v === undefined) return 'NULL';
  // 标准 MySQL 字符串转义：反斜杠→\\，单引号→''，换行→\n（兼容 mysqldump/phpMyAdmin 等任意工具）
  let s = String(v);
  s = s.replace(/\\/g, '\\\\');
  s = s.replace(/'/g, "''");
  s = s.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n');
  s = s.replace(/\x00/g, '');
  return "'" + s + "'";
}
async function exportSql() {
  if (!dbPool) throw new Error('MySQL 未连接，无法导出');
  const dbName = dbCfg && dbCfg.database ? dbCfg.database : 'jzd_daily';
  const [rows] = await dbPool.query('SELECT k, v FROM jzd_state ORDER BY k');
  const L2 = [];
  L2.push('-- ============================================');
  L2.push('-- 极造数字 · 日报工具 全库备份');
  L2.push('-- 导出时间: ' + new Date().toLocaleString('zh-CN'));
  L2.push('-- 数据库: ' + dbName);
  L2.push('-- 说明: 标准 SQL 格式，可用任意 MySQL 工具导入恢复');
  L2.push('-- ============================================');
  L2.push('SET NAMES utf8mb4;');
  L2.push('');
  L2.push('CREATE DATABASE IF NOT EXISTS `' + dbName + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
  L2.push('USE `' + dbName + '`;');
  L2.push('');
  L2.push('DROP TABLE IF EXISTS `jzd_state`;');
  L2.push('CREATE TABLE `jzd_state` (');
  L2.push('  `k` VARCHAR(64) NOT NULL,');
  L2.push('  `v` LONGTEXT,');
  L2.push('  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,');
  L2.push('  PRIMARY KEY (`k`)');
  L2.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');
  L2.push('');
  if (!rows.length) {
    L2.push('-- (空库，无数据)');
  } else {
    L2.push('INSERT INTO `jzd_state` (`k`, `v`) VALUES');
    rows.forEach((r, i) => {
      const comma = i === rows.length - 1 ? ';' : ',';
      L2.push('  (' + sqlEscape(r.k) + ', ' + sqlEscape(r.v) + ')' + comma);
    });
    L2.push('');
  }
  L2.push('-- 导出完成，共 ' + rows.length + ' 项');
  return L2.join('\n');
}

// 导入 SQL：先自动备份当前库到备份目录，再执行导入（覆盖）
async function importSql(sqlText) {
  if (!dbPool) throw new Error('MySQL 未连接，无法导入');
  if (!sqlText || !sqlText.trim()) throw new Error('SQL 内容为空');
  // 仅接受本工具导出的备份（防误导入任意 SQL）
  if (sqlText.indexOf('极造数字') < 0 || sqlText.indexOf('jzd_state') < 0) {
    throw new Error('文件不是本工具的 SQL 备份格式，已拒绝导入');
  }
  // 1. 自动备份当前库
  const current = await exportSql();
  const backupDir = path.join(DATA_DIR, 'backups');
  try { fs.mkdirSync(backupDir, { recursive: true }); } catch (e) {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = path.join(backupDir, 'before_import_' + ts + '.sql');
  fs.writeFileSync(backupFile, current, 'utf8');
  // 2. 解析并执行导入（逐条执行，避免 multipleStatements 注入面）
  const conn = await dbPool.getConnection();
  let count = 0;
  try {
    await conn.beginTransaction();
    // 去掉注释行与 SET 行，按 ; 拆分为可执行语句
    const statements = sqlText.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('--') && !l.startsWith('#'))
      .join(' ')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      const [r] = await conn.query(stmt);
      if (r && typeof r.affectedRows === 'number' && /^INSERT/i.test(stmt)) count += r.affectedRows;
    }
    await conn.commit();
    return { ok: true, count: count, backup: path.basename(backupFile) };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// 启动时尝试用已保存配置连接（失败不阻塞服务）
try {
  const saved = readDbConfig();
  if (saved && saved.user) {
    ensureDb(saved).catch(() => {});
  }
} catch (e) {}

// ================= Windows 原生通知（任务计划开始时间提醒） =================
const { execFile } = require('child_process');
let notifyCfg = { enabled: true, advanceMin: 5, sound: true }; // 默认：启用、提前5分钟
let notifiedMap = {}; // 已通知记录 {taskId_start: 1}，重启后重置（跨重启防重靠 DB 表）

// 从 MySQL 读取通知配置
async function loadNotifyConfig() {
  try {
    if (!dbPool) return;
    const [rows] = await dbPool.query("SELECT v FROM jzd_state WHERE k = 'jzd_notify_config_v1'");
    if (rows && rows[0] && rows[0].v) {
      const c = JSON.parse(rows[0].v);
      if (c && typeof c === 'object') notifyCfg = Object.assign({ enabled: true, advanceMin: 5, sound: true }, c);
    }
  } catch (e) {}
}

// 保存通知配置到 MySQL
async function saveNotifyConfig(cfg) {
  if (!dbPool) throw new Error('MySQL 未连接');
  await dbPool.query('INSERT INTO jzd_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['jzd_notify_config_v1', JSON.stringify(cfg)]);
  notifyCfg = Object.assign({ enabled: true, advanceMin: 5, sound: true }, cfg);
  return notifyCfg;
}

// 发送 Windows Toast 通知（PowerShell + WinRT）
function sendToast(title, message) {
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$textNodes = $template.GetElementsByTagName("text")',
    '$textNodes.Item(0).AppendChild($template.CreateTextNode($args[0])) | Out-Null',
    '$textNodes.Item(1).AppendChild($template.CreateTextNode($args[1])) | Out-Null',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("工作日报APP").Show($toast)'
  ].join('\n');
  const tmp = path.join(os.tmpdir(), 'jzd_toast_' + Date.now() + '.ps1');
  // UTF-8 BOM 确保中文不乱码
  fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8');
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp, title, message], { timeout: 15000 }, (err) => {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    const logLine = new Date().toISOString() + ' | ' + (err ? 'ERR ' + err.message : 'OK ' + title) + '\n';
    try { fs.appendFileSync(path.join(DATA_DIR, 'remind.log'), logLine, 'utf8'); } catch (e3) {}
    if (err) console.error('  [toast] ' + err.message);
    else console.log('  [toast] 已发送通知: ' + title);
  });
}

// 轮询任务计划开始时间，到点发通知
async function checkTaskReminders() {
  try {
    if (!dbPool || !notifyCfg.enabled) return;
    const [rows] = await dbPool.query("SELECT v FROM jzd_state WHERE k = 'jzd_tasks_v1'");
    if (!rows || !rows[0] || !rows[0].v) return;
    let tasks = [];
    try { tasks = JSON.parse(rows[0].v); } catch (e) { return; }
    if (!Array.isArray(tasks)) return;
    const now = Date.now();
    const advance = (Number(notifyCfg.advanceMin) || 0) * 60000;
    const nowStr = new Date(now).toISOString(); // 调试用
    for (const t of tasks) {
      if (!t || !t.start || t.done || t.cancelled) continue; // 已完成/已取消/无开始时间跳过
      // start 格式：YYYY-MM-DDTHH:mm（datetime-local）或 YYYY-MM-DD HH:mm
      const s = String(t.start).replace('T', ' ');
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) continue;
      const [datePart, timePart] = s.split(' ');
      // 用本地时间解析（避免 ISO 字符串被当 UTC，中国时区差 8 小时）
      const dparts = datePart.split('-').map(Number);
      const tparts = (timePart || '00:00').split(':').map(Number);
      const st = new Date(dparts[0], (dparts[1] || 1) - 1, dparts[2] || 1, tparts[0] || 0, tparts[1] || 0, 0).getTime();
      if (isNaN(st)) continue;
      // 到点或已过点（在提前窗口内）→ 通知（一次性）
      if (now >= st - advance) {
        const key = t.id + '_' + t.start;
        if (notifiedMap[key]) continue;
        notifiedMap[key] = 1;
        // 只通知当次；如果 start 已过很久（比如超过2小时）就不再补发
        if (now - st > 2 * 60 * 60000) { delete notifiedMap[key]; continue; }
        const project = t.project || '';
        const timeTxt = timePart || '';
        sendToast('⏰ 任务开始提醒：' + t.name, '项目：' + project + '\n计划开始：' + datePart + ' ' + timeTxt + '\n请开始处理该任务');
        console.log('  [remind] ' + datePart + ' ' + timePart + ' -> ' + t.name);
      }
    }
  } catch (e) {
    console.error('  [remind] ' + (e && e.message ? e.message : e));
  }
}

// 启动通知轮询（30 秒一次）
loadNotifyConfig().then(() => {
  setInterval(checkTaskReminders, 30000);
  checkTaskReminders();
  console.log('  Windows 通知: 已启用（每30秒检查任务计划开始时间）');
}).catch(() => {
  setInterval(checkTaskReminders, 30000);
});

const PORT = parseInt(process.env.PORT || '8080', 10) || 8080;
const PORT_AUTO = process.env.PORT_AUTO === '1'; // Electron 模式：端口被占用时自动换端口
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// AI 汇总代理：把浏览器的请求转发到 OpenAI 兼容接口（如 DeepSeek）
async function handleAI(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let cfg;
  try { cfg = JSON.parse(body); } catch (e) {
    json(res, 400, { error: '请求体不是合法JSON' });
    return;
  }
  const base = (cfg.base || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const model = cfg.model || 'deepseek-chat';
  const messages = Array.isArray(cfg.messages) ? cfg.messages : [];
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.key || '') },
      body: JSON.stringify({ model: model, messages: messages, temperature: 0.4 })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      json(res, 502, { error: '上游接口 ' + r.status + ' ' + JSON.stringify(j).slice(0, 300) });
      return;
    }
    const content = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    json(res, 200, { content: content });
  } catch (e) {
    json(res, 502, { error: String(e && e.message ? e.message : e) });
  }
}

// 读取 CC Switch 配置（~/.cc-switch/cc-switch.db 的 providers 表）
async function handleCCSwitchImport(req, res) {
  const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT id, app_type, name, is_current, settings_config FROM providers').all();
    db.close();
    const out = [];
    const seen = {};
    const push = (p) => {
      if (!p || !p.key) return;
      const k = (p.base || '') + '|' + p.key;
      if (seen[k]) return;
      seen[k] = 1;
      out.push(p);
    };
    rows.forEach((r) => {
      let cfg = null;
      try { cfg = JSON.parse(r.settings_config || '{}'); } catch (e) { cfg = null; }
      if (!cfg) return;
      const app = String(r.app_type || '');
      const name = String(r.name || '');
      const isCur = r.is_current ? true : false;
      const env = cfg.env || {};
      if (app.indexOf('claude') >= 0) {
        const key = env.ANTHROPIC_AUTH_TOKEN || '';
        const base = (env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
        let model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '';
        model = String(model).replace(/\[.*?\]/g, '').trim();
        push({ name: name, app_type: 'claude', base: base, key: key, model: model, current: isCur });
      } else if (app.indexOf('codex') >= 0) {
        const key = (cfg.auth || {}).OPENAI_API_KEY || '';
        const toml = String(cfg.config || '');
        let base = '', model = '';
        const mb = toml.match(/base_url\s*=\s*"([^"]+)"/);
        if (mb) base = mb[1].replace(/\/+$/, '');
        const mm = toml.match(/^model\s*=\s*"([^"]+)"/m);
        if (mm) model = mm[1];
        push({ name: name, app_type: 'codex', base: base, key: key, model: model, current: isCur });
      }
    });
    out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.name.localeCompare(b.name));
    json(res, 200, { ok: true, source: dbPath, providers: out });
  } catch (e) {
    json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
  }
}

const server = http.createServer((req, res) => {
  cors(res);   // 所有响应统一加 CORS 头，兼容 file:// 直开页面与局域网/手机访问
  const method = req.method || 'GET';
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (urlPath === '/api/ai/chat' && method === 'POST') {
    handleAI(req, res);
    return;
  }

  if (urlPath === '/api/import/cc-switch' && method === 'GET') {
    handleCCSwitchImport(req, res);
    return;
  }

  // ===== MySQL 数据持久化 API =====
  if (urlPath === '/api/db/config' && method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const cfg = JSON.parse(body);
        const r = await ensureDb(cfg);
        json(res, 200, Object.assign({ ok: true }, r, { password: '' }));
      } catch (e) {
        json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    }).catch(e => json(res, 400, { error: String(e && e.message ? e.message : e) }));
    return;
  }

  if (urlPath === '/api/db/status' && method === 'GET') {
    const active = dbPool ? true : false;
    const cfg = dbCfg || readDbConfig() || null;
    json(res, 200, {
      ok: true,
      active: active,
      host: cfg ? cfg.host : null,
      port: cfg ? cfg.port : null,
      user: cfg ? cfg.user : null,
      database: cfg ? cfg.database : null,
      hasConfig: cfg ? true : false
    });
    return;
  }

  // ===== 全库 SQL 导出 / 导入（数据可移植） =====
  if (urlPath === '/api/db/export-sql' && method === 'GET') {
    exportSql().then(sqlText => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(sqlText);
    }).catch(e => {
      json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    });
    return;
  }

  if (urlPath === '/api/db/import-sql' && method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const data = JSON.parse(body);
        const sqlText = data.sql || '';
        const r = await importSql(sqlText);
        json(res, 200, Object.assign({ ok: true }, r));
      } catch (e) {
        json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    }).catch(e => json(res, 400, { error: String(e && e.message ? e.message : e) }));
    return;
  }

  if (urlPath === '/api/state' && method === 'GET') {
    getState().then(items => {
      json(res, 200, { ok: true, available: !!items, items: items || {} });
    }).catch(e => {
      json(res, 200, { ok: false, available: false, error: String(e && e.message ? e.message : e) });
    });
    return;
  }

  if (urlPath === '/api/state' && method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const data = JSON.parse(body);
        const r = await setState(data.items || {});
        json(res, 200, Object.assign({ ok: true, available: true }, r));
      } catch (e) {
        json(res, 200, { ok: false, available: false, error: String(e && e.message ? e.message : e) });
      }
    }).catch(e => json(res, 400, { error: String(e && e.message ? e.message : e) }));
    return;
  }

  // ===== Windows 通知 API =====
  if (urlPath === '/api/notify/test' && method === 'POST') {
    sendToast('⏰ 测试通知', '这是「工作日报APP」的 Windows 通知测试。\n如果能看到此消息，说明通知功能正常！');
    json(res, 200, { ok: true, msg: '已发送测试通知（若未弹出，请检查 Windows 通知设置）' });
    return;
  }

  if (urlPath === '/api/notify/config' && method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const cfg = JSON.parse(body);
        const saved = await saveNotifyConfig(cfg);
        json(res, 200, { ok: true, config: saved });
      } catch (e) {
        json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    }).catch(e => json(res, 400, { error: String(e && e.message ? e.message : e) }));
    return;
  }

  if (urlPath === '/api/notify/status' && method === 'GET') {
    json(res, 200, {
      ok: true,
      enabled: notifyCfg ? notifyCfg.enabled : false,
      advanceMin: notifyCfg ? notifyCfg.advanceMin : 5,
      sound: notifyCfg ? notifyCfg.sound : true,
      dbConnected: dbPool ? true : false
    });
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const file = path.join(ROOT, path.normalize(urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});
let LISTEN_PORT = PORT;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    if (PORT_AUTO) {
      // 端口被占用：换一个空闲端口继续
      LISTEN_PORT = 8080 + Math.floor(Math.random() * 2000) + 1;
      console.log('  端口 ' + PORT + ' 被占用，自动改用端口 ' + LISTEN_PORT);
      server.close();
      server.listen(LISTEN_PORT, '0.0.0.0');
      return;
    }
    console.error('');
    console.error('==============================================');
    console.error('  端口 ' + PORT + ' 已被占用！');
    console.error('  可能已有本工具在运行，请先关闭旧窗口。');
    console.error('==============================================');
    process.exit(2);
  } else {
    throw err;
  }
});
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log('PORT_STARTED:' + LISTEN_PORT); // Electron 主进程捕获实际端口
  console.log('  工作日报 · 周报月报生成器 已启动（端口 ' + LISTEN_PORT + '）');
  console.log('  MySQL 存储: ' + (dbPool ? '已连接（' + (dbCfg ? dbCfg.database : '') + '）' : '未配置（数据仅存本地）'));
});