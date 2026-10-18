'use strict';

// Статический сервер без зависимостей: приложение в корне, админка в /xxx/.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- .env (локальный запуск). На Railway значения задаются в Variables. ----------
(function loadEnv() {
  let txt;
  try { txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch (e) { return; }
  txt.split('\n').forEach(line => {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  });
})();

// ---------- iiko ----------
// Логин и пароль живут только на сервере, в браузер не попадают.
const IIKO_URL = (process.env.IIKO_URL || 'https://neon-takshkent-co.iiko.it/resto').replace(/\/+$/, '');
const IIKO_LOGIN = process.env.IIKO_LOGIN || '';
const IIKO_PASS = process.env.IIKO_PASS || '';
const IIKO_TTL = 5 * 60 * 1000; // кэш списка сотрудников

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8081; // Railway передаёт PORT через env
const HOST = '0.0.0.0';

const ROOT_FILE = 'Зарплаты_и_авансы.html'; // главная страница приложения

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// '/' -> приложение, '/xxx/' -> xxx/index.html. Выход за пределы папки запрещён.
function resolveFile(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return null; }
  if (!rel || rel === '/') rel = '/' + ROOT_FILE;
  else if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  return file;
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end('<!DOCTYPE html><meta charset="utf-8"><title>404</title><p style="font:16px -apple-system,sans-serif;padding:24px">Страница не найдена</p>');
}

// ---------- iiko: список сотрудников ----------
const xmlTag = (block, name) => {
  const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1] : '';
};
const xmlUnesc = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

let iikoToken = null;
let staffCache = { at: 0, staff: [] };

// iiko принимает пароль и открытым текстом, и SHA-1 хешем — отправляем хеш.
async function iikoAuth() {
  const pass = /^[0-9a-f]{40}$/i.test(IIKO_PASS) ? IIKO_PASS : crypto.createHash('sha1').update(IIKO_PASS).digest('hex');
  const r = await fetch(IIKO_URL + '/api/auth?login=' + encodeURIComponent(IIKO_LOGIN) + '&pass=' + pass);
  const txt = (await r.text()).trim();
  if (!r.ok || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(txt)) {
    throw new Error(txt || ('iiko auth: HTTP ' + r.status));
  }
  iikoToken = txt;
  return iikoToken;
}

async function iikoGet(apiPath, retry) {
  const key = iikoToken || (await iikoAuth());
  const sep = apiPath.includes('?') ? '&' : '?';
  const r = await fetch(IIKO_URL + apiPath + sep + 'key=' + encodeURIComponent(key));
  if ((r.status === 401 || r.status === 403) && retry !== false) {
    iikoToken = null; // токен протух — берём новый и повторяем один раз
    return iikoGet(apiPath, false);
  }
  if (!r.ok) throw new Error('iiko ' + apiPath + ': HTTP ' + r.status);
  return r.text();
}

async function iikoStaff() {
  if (staffCache.staff.length && Date.now() - staffCache.at < IIKO_TTL) return staffCache;
  const [empXml, roleXml] = await Promise.all([iikoGet('/api/employees'), iikoGet('/api/employees/roles')]);
  const roles = {};
  (roleXml.match(/<role>[\s\S]*?<\/role>/g) || []).forEach(b => {
    if (xmlTag(b, 'deleted') === 'true') return;
    roles[xmlTag(b, 'id')] = xmlUnesc(xmlTag(b, 'name') || xmlTag(b, 'code'));
  });
  const staff = (empXml.match(/<employee>[\s\S]*?<\/employee>/g) || [])
    .filter(b => xmlTag(b, 'deleted') !== 'true')
    .map(b => ({
      id: xmlTag(b, 'id'),
      code: xmlTag(b, 'code'),
      name: xmlUnesc(xmlTag(b, 'name')).trim(),
      role: roles[xmlTag(b, 'mainRoleId')] || xmlUnesc(xmlTag(b, 'mainRoleCode')),
    }))
    .filter(e => e.id && e.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  staffCache = { at: Date.now(), staff };
  return staffCache;
}

function serveStaff(res) {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!IIKO_LOGIN || !IIKO_PASS) return json(500, { ok: false, error: 'Не заданы IIKO_LOGIN / IIKO_PASS' });
  iikoStaff()
    .then(c => json(200, { ok: true, syncedAt: c.at, staff: c.staff }))
    .catch(e => {
      console.error('iiko:', e.message);
      json(502, { ok: false, error: e.message });
    });
}

// Явки: кто открыл смену, когда закрыл. dateFrom/dateTo в iiko приходят с таймзоной сервера.
let attCache = { key: '', at: 0, items: [] };

async function iikoAttendance(from, to) {
  const key = from + '..' + to;
  if (attCache.key === key && Date.now() - attCache.at < IIKO_TTL) return attCache;
  const [xml, staffRes] = await Promise.all([
    iikoGet('/api/employees/attendance?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)),
    iikoStaff(),
  ]);
  const byId = {};
  staffRes.staff.forEach(e => { byId[e.id] = e; });
  const items = (xml.match(/<attendance>[\s\S]*?<\/attendance>/g) || []).map(b => {
    const emp = byId[xmlTag(b, 'employeeId')] || {};
    return {
      id: xmlTag(b, 'id'),
      employeeId: xmlTag(b, 'employeeId'),
      code: emp.code || '',
      name: emp.name || '',
      role: emp.role || '',
      // Личная отметка сотрудника; если её нет — учётное время смены.
      from: xmlTag(b, 'personalDateFrom') || xmlTag(b, 'dateFrom') || null,
      to: xmlTag(b, 'personalDateTo') || xmlTag(b, 'dateTo') || null,
      type: xmlUnesc(xmlTag(b, 'attendanceType')),
      comment: xmlUnesc(xmlTag(b, 'comment')).trim(),
      department: xmlUnesc(xmlTag(b, 'departmentName')),
    };
  });
  attCache = { key, at: Date.now(), items };
  return attCache;
}

function serveAttendance(res, sp) {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const from = sp.get('from') || '', to = sp.get('to') || '';
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!IIKO_LOGIN || !IIKO_PASS) return json(500, { ok: false, error: 'Не заданы IIKO_LOGIN / IIKO_PASS' });
  if (!iso.test(from) || !iso.test(to)) return json(400, { ok: false, error: 'Нужны from и to в формате YYYY-MM-DD' });
  if (to < from) return json(400, { ok: false, error: 'to раньше from' });
  iikoAttendance(from, to)
    .then(c => json(200, { ok: true, from, to, syncedAt: c.at, items: c.items }))
    .catch(e => {
      console.error('iiko attendance:', e.message);
      json(502, { ok: false, error: e.message });
    });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (pathname === '/api/iiko/staff') return serveStaff(res);
  if (pathname === '/api/iiko/attendance') return serveAttendance(res, url.searchParams);
  const file = resolveFile(pathname);
  if (!file) return notFound(res);

  fs.stat(file, (stErr, st) => {
    // '/xxx' -> '/xxx/', иначе браузер получит 404 вместо админки.
    if (!stErr && st.isDirectory()) {
      res.writeHead(301, { Location: encodeURI(decodeURIComponent(pathname)) + '/' });
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) return notFound(res);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        // Отдаём свежую версию: приложение и админка обновляются часто.
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('payroll: listening on http://' + HOST + ':' + PORT);
});
