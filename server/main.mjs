// monolit proxy — админка подписок Xray (Vision, Hysteria2, XHTTP) поверх уже установленного Xray
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { openDb, now, token, newUuid, getSetting, setSetting, hashPassword, checkPassword, userState } from './db.mjs';
import { Xray } from './xray.mjs';
import { AUTOXRAY_URL, parseAutoXray, hashOf, renderAll, links } from './template.mjs';
import { createManager, PRESETS } from './manage.mjs';

const env = (k, d) => process.env[k] ?? d;
const DATA = env('MP_DATA', '/data');
const UI = env('MP_UI', new URL('../ui/dist', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const [HOST, PORT] = env('MP_LISTEN', '127.0.0.1:7380').split(':');
const ADMIN = '/' + env('MP_ADMIN_PATH', 'admin').replace(/^\/|\/$/g, '');
const db = openDb(join(DATA, 'monolit.db'));
const xray = new Xray({ bin: env('MP_XRAY_BIN', '/usr/local/bin/xray'), config: env('MP_XRAY_CONFIG', '/usr/local/etc/xray/config.json'), api: env('MP_XRAY_API', '127.0.0.1:10085') });
const BUNDLED = new URL('./autoXRAY2.sh', import.meta.url);

// ---------- первичная настройка ----------
if (!getSetting(db, 'admin_hash')) setSetting(db, 'admin_hash', hashPassword(env('MP_ADMIN_PASSWORD', token(9))));
if (!getSetting(db, 'admin_login')) setSetting(db, 'admin_login', env('MP_ADMIN_LOGIN', 'admin'));
for (const [k, v] of Object.entries({ server_name: env('MP_SERVER_NAME', 'monolit'), domain: env('MP_DOMAIN', ''), fp: 'firefox', kinds: env('MP_KINDS', 'vision,hy2'), autoupdate: '1', support_url: '', update_hours: '12' }))
  if (!getSetting(db, k) && v !== '') setSetting(db, k, v);
// Домен сменили переустановкой (--reconfigure --domain): берём новый. Сменённый в настройках админки — не трогаем
if (env('MP_DOMAIN', '') && getSetting(db, 'domain_env') !== env('MP_DOMAIN', '')) {
  if (getSetting(db, 'domain_env')) setSetting(db, 'domain', env('MP_DOMAIN', ''));
  setSetting(db, 'domain_env', env('MP_DOMAIN', ''));
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const kindsOn = () => { const d = xray.detect(); return getSetting(db, 'kinds', 'vision,hy2').split(',').filter(k => d[k]); };
const serverCtx = () => {
  const d = xray.detect();
  return { name: getSetting(db, 'server_name'), domain: getSetting(db, 'domain'), fp: getSetting(db, 'fp', 'firefox'), xhttpPath: d.xhttp?.path || '', ports: { vision: d.vision?.port, hy2: d.hy2?.port, xhttp: 443 } };
};
const users = () => db.prepare('SELECT * FROM users ORDER BY id').all();
const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// ---------- шаблон autoXRAY ----------
const activeTpl = () => { const r = db.prepare("SELECT * FROM templates WHERE status = 'active' ORDER BY id DESC LIMIT 1").get(); return r ? { ...r, parsed: JSON.parse(r.body) } : null; };

async function validate(parsed) {
  const ctx = { user: { uuid: '00000000-0000-4000-8000-000000000000', hy2: 'test' }, server: { ...serverCtx(), domain: serverCtx().domain || 'example.com' } };
  for (const c of renderAll(parsed, ctx, ['vision', 'hy2', 'xhttp'])) { const err = await xray.test(c); if (err) return `${c.remarks}: ${err}`; }
  return '';
}

async function checkTemplate(force = false) {
  let sh, source = 'github';
  try {
    const r = await fetch(AUTOXRAY_URL, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status); sh = await r.text();
  } catch (e) {
    log('autoXRAY не скачался:', e.message);
    if (activeTpl()) return { ok: false, error: 'GitHub недоступен: ' + e.message };
    sh = readFileSync(BUNDLED, 'utf8'); source = 'bundled';
  }
  let parsed; try { parsed = parseAutoXray(sh); } catch (e) { return { ok: false, error: 'Не разобрался шаблон: ' + e.message }; }
  const hash = hashOf(parsed), cur = activeTpl();
  if (cur?.hash === hash) { setSetting(db, 'tpl_checked', now()); return { ok: true, changed: false }; }
  const known = db.prepare('SELECT * FROM templates WHERE hash = ?').get(hash);
  if (known && !force) return { ok: known.status !== 'rejected', changed: false, error: known.error };
  const error = await validate(parsed);
  const body = JSON.stringify(parsed);
  if (error) {
    db.prepare("INSERT INTO templates (hash, source, body, status, error, fetched_at) VALUES (?, ?, ?, 'rejected', ?, ?) ON CONFLICT(hash) DO UPDATE SET error = excluded.error").run(hash, source, body, error, now());
    log('новый шаблон не прошёл проверку:', error); return { ok: false, error };
  }
  if (cur && getSetting(db, 'autoupdate') !== '1' && !force) {
    db.prepare("INSERT OR IGNORE INTO templates (hash, source, body, status, fetched_at) VALUES (?, ?, ?, 'pending', ?)").run(hash, source, body, now());
    return { ok: true, changed: false, pending: true };
  }
  db.exec("UPDATE templates SET status = 'previous' WHERE status IN ('active')");
  db.prepare("INSERT INTO templates (hash, source, body, status, fetched_at) VALUES (?, ?, ?, 'active', ?) ON CONFLICT(hash) DO UPDATE SET status = 'active', error = ''").run(hash, source, body, now());
  setSetting(db, 'tpl_checked', now());
  log('шаблон autoXRAY применён, версия', parsed.version, hash);
  return { ok: true, changed: true };
}

function rollbackTemplate() {
  const cur = activeTpl(), prev = db.prepare("SELECT id FROM templates WHERE status = 'previous' ORDER BY id DESC LIMIT 1").get();
  if (!cur || !prev) return false;
  db.prepare("UPDATE templates SET status = 'rolledback' WHERE id = ?").run(cur.id);
  db.prepare("UPDATE templates SET status = 'active' WHERE id = ?").run(prev.id);
  return true;
}

// ---------- синхронизация с Xray и лимиты ----------
let applied = null;           // id пользователей, которые сейчас есть в Xray
let xrayOk = false, lastSync = 0, syncError = '';

async function sync({ full = false } = {}) {
  try {
    xrayOk = await xray.apiAlive();
    if (!xrayOk) { syncError = 'API Xray не отвечает'; return; }
    const t = now(), traffic = await xray.takeTraffic();
    const add = db.prepare('UPDATE users SET up = up + ?, down = down + ?, last_active = ? WHERE id = ?');
    for (const [id, v] of Object.entries(traffic)) if (v.up || v.down) add.run(v.up, v.down, t, Number(id));
    const kinds = kindsOn(), all = users(), want = new Set(all.filter(u => userState(u, t) === 'active').map(u => u.id));
    const was = applied || new Set();
    if (full || !applied) {
      for (const u of all) if (want.has(u.id)) await xray.addUser(u, kinds).catch(() => {});   // уже есть — Xray ответит ошибкой, это нормально
      for (const u of all) if (!want.has(u.id)) await xray.removeUser(u.id, ['vision', 'hy2', 'xhttp']);
    } else {
      for (const id of want) if (!was.has(id)) await xray.addUser(userById(id), kinds).catch(e => log('adu', id, e.message));
      for (const id of was) if (!want.has(id)) await xray.removeUser(id, ['vision', 'hy2', 'xhttp']);
    }
    const changed = full || !applied || want.size !== was.size || [...want].some(id => !was.has(id));
    if (changed) xray.writeUsers(all.filter(u => want.has(u.id)), ['vision', 'hy2', 'xhttp'].filter(k => xray.detect()[k]));
    applied = want; lastSync = t; syncError = '';
  } catch (e) { syncError = e.message; log('sync:', e.message); }
}

// Всё, что пишет config.json Xray (синхронизация и правки из админки), идёт по очереди
let syncing = Promise.resolve();
const queue = fn => { const p = syncing.then(fn); syncing = p.catch(() => {}); return p; };
const queueSync = opts => queue(() => sync(opts));
const mgr = createManager({ db, xray, queue, log, activeUsers: () => users().filter(u => userState(u) === 'active'), onRestart: () => { queueSync({ full: true }); } });

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'cache-control': 'no-store', ...headers }); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
const readBody = req => new Promise((ok, bad) => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('bad json')); } }); });
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]));
// Перед monolit всегда nginx на 127.0.0.1: он кладёт адрес посетителя в X-Real-IP (сам заголовок клиента затирает)
const ipOf = req => req.headers['x-real-ip'] || req.socket.remoteAddress;

function staticFile(res, rel) {
  const p = normalize(join(UI, rel));
  if (!p.startsWith(normalize(UI)) || !existsSync(p) || !statSync(p).isFile()) return send(res, 404, 'not found');
  send(res, 200, readFileSync(p), { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': rel.endsWith('.html') ? 'no-store' : 'public, max-age=86400' });
}

function authed(req) {
  const t = cookie(req).mp_s; if (!t) return false;
  const s = db.prepare('SELECT expires FROM sessions WHERE token = ?').get(t);
  return !!s && s.expires > now();
}

const fails = new Map();   // защита входа от перебора
function publicUser(u) {
  const st = userState(u);
  return { id: u.id, name: u.name, note: u.note, token: u.token, limit: u.limit_bytes, expire: u.expire_at, enabled: !!u.enabled, up: u.up, down: u.down, used: u.up + u.down, state: st, last_active: u.last_active, last_sub: u.last_sub, created: u.created_at };
}
const subUrl = u => `https://${getSetting(db, 'domain')}/s/${u.token}`;

function stateForAdmin() {
  const tpl = activeTpl(), d = xray.detect();
  return {
    users: users().map(u => ({ ...publicUser(u), url: subUrl(u) })),
    settings: { server_name: getSetting(db, 'server_name'), domain: getSetting(db, 'domain'), fp: getSetting(db, 'fp'), kinds: getSetting(db, 'kinds'), autoupdate: getSetting(db, 'autoupdate') === '1', support_url: getSetting(db, 'support_url'), update_hours: Number(getSetting(db, 'update_hours', '12')), login: getSetting(db, 'admin_login') },
    xray: { ok: xrayOk, error: syncError, last_sync: lastSync, inbounds: { vision: d.vision, hy2: d.hy2, xhttp: d.xhttp } },
    template: tpl ? { version: tpl.parsed.version, hash: tpl.hash, source: tpl.source, since: tpl.fetched_at, checked: Number(getSetting(db, 'tpl_checked', '0')),
      rollback: !!db.prepare("SELECT 1 FROM templates WHERE status = 'previous'").get(),
      pending: db.prepare("SELECT hash, fetched_at FROM templates WHERE status = 'pending' ORDER BY id DESC LIMIT 1").get() || null,
      rejected: db.prepare("SELECT hash, error, fetched_at FROM templates WHERE status = 'rejected' ORDER BY id DESC LIMIT 1").get() || null } : null,
  };
}

async function adminApi(req, res, path) {
  if (path === '/api/login' && req.method === 'POST') {
    const ip = ipOf(req), f = fails.get(ip) || { n: 0, t: 0 };
    if (f.n >= 5 && now() - f.t < 600) return json(res, 429, { error: 'Слишком много попыток, подождите 10 минут' });
    const { login, password } = await readBody(req);
    const okLogin = String(login || '').trim().toLowerCase() === getSetting(db, 'admin_login').toLowerCase();
    if (!checkPassword(String(password || ''), getSetting(db, 'admin_hash')) || !okLogin) { fails.set(ip, { n: f.n + 1, t: now() }); return json(res, 401, { error: 'Неверный логин или пароль' }); }
    fails.delete(ip);
    const t = token(24); db.prepare('INSERT INTO sessions (token, expires) VALUES (?, ?)').run(t, now() + 30 * 86400);
    return send(res, 200, '{}', { 'content-type': 'application/json', 'set-cookie': `mp_s=${t}; Path=${ADMIN}; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}` });
  }
  if (!authed(req)) return json(res, 401, { error: 'Нужно войти' });
  const m = /^\/api\/users\/(\d+)(\/[a-z-]+)?$/.exec(path);

  if (path === '/api/logout' && req.method === 'POST') { db.prepare('DELETE FROM sessions WHERE token = ?').run(cookie(req).mp_s); return send(res, 200, '{}', { 'set-cookie': `mp_s=; Path=${ADMIN}; Max-Age=0` }); }
  if (path === '/api/state' && req.method === 'GET') return json(res, 200, stateForAdmin());

  if (path === '/api/users' && req.method === 'POST') {
    const b = await readBody(req), name = String(b.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'Нужно имя' });
    const r = db.prepare('INSERT INTO users (name, note, token, uuid, hy2, limit_bytes, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, String(b.note || '').slice(0, 200), token(16), newUuid(), token(12), Math.max(0, Math.round(Number(b.limit) || 0)), Math.max(0, Math.round(Number(b.expire) || 0)), now());
    await queueSync(); return json(res, 200, { user: { ...publicUser(userById(r.lastInsertRowid)), url: subUrl(userById(r.lastInsertRowid)) } });
  }
  if (m && !m[2] && req.method === 'PATCH') {
    const u = userById(Number(m[1])); if (!u) return json(res, 404, { error: 'Нет такого пользователя' });
    const b = await readBody(req);
    const f = { name: b.name !== undefined ? String(b.name).trim().slice(0, 40) || u.name : u.name, note: b.note !== undefined ? String(b.note).slice(0, 200) : u.note,
      limit_bytes: b.limit !== undefined ? Math.max(0, Math.round(Number(b.limit) || 0)) : u.limit_bytes, expire_at: b.expire !== undefined ? Math.max(0, Math.round(Number(b.expire) || 0)) : u.expire_at,
      enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : u.enabled };
    db.prepare('UPDATE users SET name = ?, note = ?, limit_bytes = ?, expire_at = ?, enabled = ? WHERE id = ?').run(f.name, f.note, f.limit_bytes, f.expire_at, f.enabled, u.id);
    await queueSync(); return json(res, 200, { user: { ...publicUser(userById(u.id)), url: subUrl(userById(u.id)) } });
  }
  if (m && m[2] === '/reset' && req.method === 'POST') { db.prepare('UPDATE users SET up = 0, down = 0 WHERE id = ?').run(Number(m[1])); await queueSync(); return json(res, 200, {}); }
  if (m && m[2] === '/regen' && req.method === 'POST') {
    // новая ссылка и новые ключи: старая ссылка и старые конфиги перестают работать
    const id = Number(m[1]); await xray.removeUser(id, ['vision', 'hy2', 'xhttp']);
    db.prepare('UPDATE users SET token = ?, uuid = ?, hy2 = ? WHERE id = ?').run(token(16), newUuid(), token(12), id);
    applied?.delete(id); await queueSync(); return json(res, 200, { user: { ...publicUser(userById(id)), url: subUrl(userById(id)) } });
  }
  if (m && !m[2] && req.method === 'DELETE') {
    const id = Number(m[1]); await xray.removeUser(id, ['vision', 'hy2', 'xhttp']);
    db.prepare('DELETE FROM users WHERE id = ?').run(id); applied?.delete(id); await queueSync({ full: false }); return json(res, 200, {});
  }
  if (path === '/api/settings' && req.method === 'PATCH') {
    const b = await readBody(req);
    if (b.server_name !== undefined) setSetting(db, 'server_name', String(b.server_name).trim().slice(0, 24) || 'monolit');
    if (b.domain !== undefined) setSetting(db, 'domain', String(b.domain).trim().toLowerCase());
    if (b.fp !== undefined && /^[a-z0-9]+$/.test(b.fp)) setSetting(db, 'fp', b.fp);
    if (b.kinds !== undefined) setSetting(db, 'kinds', [].concat(b.kinds).filter(k => ['vision', 'hy2', 'xhttp'].includes(k)).join(',') || 'vision');
    if (b.autoupdate !== undefined) setSetting(db, 'autoupdate', b.autoupdate ? '1' : '0');
    if (b.support_url !== undefined) setSetting(db, 'support_url', String(b.support_url).trim().slice(0, 200));
    if (b.update_hours !== undefined) setSetting(db, 'update_hours', String(Math.min(48, Math.max(1, Math.round(Number(b.update_hours) || 12)))));
    if (b.login !== undefined) {
      const l = String(b.login).trim();
      if (!/^[\p{L}\p{N}_.@-]{3,32}$/u.test(l)) return json(res, 400, { error: 'Логин: от 3 до 32 букв, цифр и знаков . _ - @' });
      if (l !== getSetting(db, 'admin_login')) { setSetting(db, 'admin_login', l); db.exec('DELETE FROM sessions'); }
    }
    if (b.password) { if (String(b.password).length < 8) return json(res, 400, { error: 'Пароль короче 8 символов' }); setSetting(db, 'admin_hash', hashPassword(String(b.password))); db.exec('DELETE FROM sessions'); }
    await queueSync({ full: true }); return json(res, 200, stateForAdmin());
  }
  // ---------- сервер, маршруты, WARP, протоколы, история ----------
  const qs = new URL(req.url, 'http://x').searchParams, M = req.method;
  const done = (r) => r.ok ? json(res, 200, { ...r, manage: mgr.stateForAdmin() }) : json(res, 400, { error: r.error, log: r.log || '' });
  const agentDone = (r, okText) => r.code === 0 ? json(res, 200, { ok: true, out: r.out, text: okText }) : json(res, r.code < 0 ? 503 : 400, { error: r.out.split(/\n/).filter(Boolean).slice(-3).join(' ') || 'Не получилось' });
  const managed = () => mgr.stateForAdmin().managed || (json(res, 409, { error: 'Xray настроен не через monolit (autoXRAY). Чтобы управлять им здесь, переустановите: install.sh --reconfigure --replace-autoxray' }), false);
  let mm;
  if (path === '/api/server' && M === 'GET') return json(res, 200, { manage: mgr.stateForAdmin(), status: await mgr.server.status(), presets: Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })) });
  if (path === '/api/server/reload' && M === 'POST') return agentDone(await mgr.server.reload(), 'nginx перечитал настройки');
  if ((mm = /^\/api\/server\/(restart|update|geo|cert)$/.exec(path)) && M === 'POST') return json(res, 200, await mgr.server[mm[1]]());
  if (path === '/api/job' && M === 'GET') return json(res, 200, { job: mgr.server.job(), manage: mgr.stateForAdmin() });
  if (path === '/api/server/journal' && M === 'GET') { const r = await mgr.server.journal(qs.get('n')); return r.code === 0 ? json(res, 200, { text: r.out }) : json(res, 503, { error: r.out }); }
  if (path === '/api/routes/reach' && M === 'GET') { const r = await mgr.routes.reach(qs.get('host')); return json(res, r.error ? 400 : 200, r); }
  if (path === '/api/routes/test' && M === 'GET') return json(res, 200, mgr.routes.test(qs.get('host') || ''));
  if (path.startsWith('/api/routes') || path.startsWith('/api/warp') || path === '/api/proto' || path.startsWith('/api/history')) { if (!managed()) return; }
  if (path === '/api/routes' && M === 'DELETE') return done(await mgr.routes.clear());
  if (path === '/api/routes' && M === 'POST') return done(await mgr.routes.add(await readBody(req)));
  if (path === '/api/routes/order' && M === 'POST') return done(await mgr.routes.order([].concat((await readBody(req)).ids || [])));
  if (path === '/api/routes/preset' && M === 'POST') return done(await mgr.routes.preset((await readBody(req)).name));
  if ((mm = /^\/api\/routes\/(\d+)$/.exec(path))) {
    if (M === 'PATCH') return done(await mgr.routes.edit(Number(mm[1]), await readBody(req)));
    if (M === 'DELETE') return done(await mgr.routes.remove(Number(mm[1])));
  }
  if (path === '/api/warp' && M === 'POST') return done(await mgr.warp.toggle(!!(await readBody(req)).on));
  if (path === '/api/warp/register' && M === 'POST') return done(await mgr.warp.register());
  if (path === '/api/warp/license' && M === 'POST') return done(await mgr.warp.license((await readBody(req)).key));
  if (path === '/api/warp/check' && M === 'POST') { const r = await mgr.warp.check(); return json(res, r.warp ? 200 : 400, r.warp ? r : { error: r.error }); }
  if (path === '/api/proto' && M === 'PATCH') return done(await mgr.proto.set(await readBody(req)));
  if (path === '/api/mtg' && M === 'POST') return done(await mgr.proto.mtg(!!(await readBody(req)).on));
  if ((mm = /^\/api\/history\/(\d+)(\/rollback)?$/.exec(path))) {
    if (mm[2] && M === 'POST') return done(await mgr.history.rollback(Number(mm[1])));
    if (!mm[2] && M === 'GET') { const b = mgr.history.show(Number(mm[1])); return b ? send(res, 200, b, { 'content-type': 'application/json; charset=utf-8' }) : json(res, 404, { error: 'Нет такой версии' }); }
  }
  if (path === '/api/template/check' && req.method === 'POST') { const r = await checkTemplate(true); return json(res, 200, { ...r, state: stateForAdmin() }); }
  if (path === '/api/template/rollback' && req.method === 'POST') { const ok = rollbackTemplate(); return json(res, ok ? 200 : 400, ok ? stateForAdmin() : { error: 'Нет прошлой версии шаблона' }); }
  return json(res, 404, { error: 'Нет такого действия' });
}

// ---------- подписка ----------
const CLIENT_UA = /happ|incy|v2ray|streisand|hiddify|clash|mihomo|sing-?box|shadowrocket|foxray|karing|nekobox|throne|xray|v2box|v2rayng|okhttp|dart|cfnetwork/i;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

function subscription(req, res, tok, mode) {
  const u = db.prepare('SELECT * FROM users WHERE token = ?').get(tok);
  if (!u) return send(res, 404, 'not found');
  const st = userState(u), ctx = { user: u, server: serverCtx() }, kinds = kindsOn(), tpl = activeTpl();
  const ua = req.headers['user-agent'] || '';
  const browser = mode === 'auto' && /mozilla/i.test(ua) && (req.headers.accept || '').includes('text/html') && !CLIENT_UA.test(ua);
  const info = { name: u.name, server: ctx.server.name, state: st, used: u.up + u.down, limit: u.limit_bytes, expire: u.expire_at, url: subUrl(u), support: getSetting(db, 'support_url'), configs: st === 'active' ? links(ctx, kinds) : [] };
  if (browser) {
    const page = readFileSync(join(UI, 'sub.html'), 'utf8').replace('"__SUB__"', JSON.stringify(info).replace(/</g, '\\u003c'));
    return send(res, 200, page, { 'content-type': MIME['.html'], 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
  }
  db.prepare('UPDATE users SET last_sub = ? WHERE id = ?').run(now(), u.id);
  const headers = {
    'profile-title': 'base64:' + b64(`${ctx.server.name}`),
    'profile-update-interval': getSetting(db, 'update_hours', '12'),
    'subscription-userinfo': `upload=${u.up};download=${u.down};total=${u.limit_bytes};expire=${u.expire_at}`,
    'profile-web-page-url': subUrl(u),
    ...(getSetting(db, 'support_url') ? { 'support-url': getSetting(db, 'support_url') } : {}),
    ...(st !== 'active' ? { announce: 'base64:' + b64({ off: 'Доступ отключён', expired: 'Срок подписки закончился', limit: 'Трафик по подписке закончился' }[st]) } : {}),
  };
  const asLinks = mode === 'links' || (mode === 'auto' && /v2rayn\b|nekobox|throne|shadowrocket/i.test(ua) && !/v2rayng/i.test(ua));
  if (asLinks) return send(res, 200, b64(info.configs.join('\n')), { ...headers, 'content-type': 'text/plain; charset=utf-8' });
  const body = st === 'active' && tpl ? renderAll(tpl.parsed, ctx, kinds) : [];
  return send(res, 200, JSON.stringify(body, null, 2), { ...headers, 'content-type': 'application/json; charset=utf-8' });
}

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
    let m;
    if ((m = /^\/s\/([A-Za-z0-9_-]{10,40})(?:\/(json|links))?$/.exec(p)) && req.method === 'GET') return subscription(req, res, m[1], m[2] || 'auto');
    if (p.startsWith('/s/_/')) return staticFile(res, p.slice(5));
    if (p === ADMIN) return send(res, 301, '', { location: ADMIN + '/' });
    if (p === ADMIN + '/') return staticFile(res, 'admin.html');
    if (p.startsWith(ADMIN + '/_/')) return staticFile(res, p.slice(ADMIN.length + 3));
    if (p.startsWith(ADMIN + '/api/')) return await adminApi(req, res, p.slice(ADMIN.length));
    if (p === '/healthz') return json(res, 200, { ok: true, xray: xrayOk });
    // Посторонний на домене VPN видит обычную с виду страницу входа (nginx отдаёт сюда всё, что не сайт). Вход всегда «неверный»
    if (p === '/api/v1/authenticate' && req.method === 'POST') { req.resume(); return json(res, 401, { success: false, code: 'ERR_INVALID_CREDENTIALS', message: 'Неверный логин или пароль' }); }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (/^\/_\/(gate\.(css|js)|manrope-[a-z-]+\.woff2)$/.test(p)) return staticFile(res, p.slice(3));
      return staticFile(res, 'gate.html');
    }
    send(res, 404, 'not found');
  } catch (e) { log('http', e.message); if (!res.headersSent) json(res, 500, { error: 'Ошибка сервера' }); }
});
http.listen(Number(PORT), HOST, async () => {
  log(`monolit proxy слушает ${HOST}:${PORT}, админка ${ADMIN}/`);
  if (!activeTpl()) await checkTemplate();
  await queueSync({ full: true });
  await mgr.start().catch(e => log('manage:', e.message));
  setInterval(() => queueSync(), 60_000);
  setInterval(() => queueSync({ full: true }), 10 * 60_000);    // если Xray перезапускали — вернуть пользователей
  setInterval(() => checkTemplate().catch(e => log('tpl', e.message)), 24 * 3600_000);
  setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(now()), 3600_000);
});
