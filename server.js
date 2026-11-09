'use strict';
// tthome — cihaz durumu, Wake-on-LAN, RustDesk bağlantısı ve webcam proxy.
// Harici bağımlılık yok; yalnızca Node.js çekirdek modülleri.

const http = require('http');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MODE = (process.env.MODE || 'web').toLowerCase(); // 'web' | 'relay'
const PORT = Number(process.env.PORT) || (MODE === 'relay' ? 9099 : 3000);
const BIND = process.env.BIND || '0.0.0.0';
const RELAY_URL = (process.env.WOL_RELAY_URL || '').replace(/\/+$/, '');
const RELAY_TOKEN = process.env.WOL_RELAY_TOKEN || '';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- Wake-on-LAN

function magicPacket(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('Geçersiz MAC adresi: ' + mac);
  const m = Buffer.from(hex, 'hex');
  const buf = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) m.copy(buf, 6 + i * 6);
  return buf;
}

async function sendWol(mac, broadcast) {
  const pkt = magicPacket(mac);
  const targets = [...new Set([broadcast || '255.255.255.255', '255.255.255.255'])];
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(resolve);
  });
  sock.setBroadcast(true);
  try {
    // Birkaç kez ve iki portta gönder: bazı kartlar 7, bazıları 9 dinler.
    for (let round = 0; round < 3; round++) {
      for (const t of targets) {
        for (const p of [9, 7]) {
          await new Promise((res, rej) => sock.send(pkt, p, t, (e) => (e ? rej(e) : res())));
        }
      }
    }
  } finally {
    sock.close();
  }
}

// ---------------------------------------------------------------- Yardımcılar

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- RELAY modu
// Ana bilgisayarın ağına (network_mode: host) bağlı küçük servis: yalnızca WoL paketi yollar.

if (MODE === 'relay') {
  if (!RELAY_TOKEN) {
    console.error('HATA: relay modunda WOL_RELAY_TOKEN zorunlu.');
    process.exit(1);
  }
  http
    .createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, 'ok');
      if (req.method !== 'POST' || req.url !== '/wake') return send(res, 404, 'not found');
      const auth = req.headers.authorization || '';
      if (!safeEqual(auth, 'Bearer ' + RELAY_TOKEN)) return send(res, 401, { error: 'unauthorized' });
      try {
        const { mac, broadcast } = JSON.parse(await readBody(req));
        await sendWol(mac, broadcast);
        log('relay: WoL gönderildi', mac, broadcast || '');
        send(res, 200, { ok: true });
      } catch (e) {
        send(res, 400, { error: e.message });
      }
    })
    .listen(PORT, BIND, () => log(`WoL relay ${BIND}:${PORT} üzerinde dinliyor`));
  return;
}

// ---------------------------------------------------------------- WEB modu

const PASSWORD = process.env.APP_PASSWORD || '';
if (!PASSWORD) {
  console.error('HATA: APP_PASSWORD ortam değişkeni zorunlu.');
  process.exit(1);
}
const SECRET =
  process.env.SESSION_SECRET || crypto.createHash('sha256').update('ev-kontrol:' + PASSWORD).digest('hex');
const POLL_MS = (Number(process.env.POLL_SECONDS) || 10) * 1000;
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const DEFAULT_PORTS = [21118, 1984, 3389, 445, 135];

function loadDevices() {
  let raw = process.env.DEVICES;
  const file = process.env.DEVICES_FILE || '/config/devices.json';
  if (!raw && fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
  if (!raw) {
    console.error('HATA: DEVICES ortam değişkeni (JSON) veya ' + file + ' gerekli.');
    process.exit(1);
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    console.error('HATA: DEVICES geçerli JSON değil:', e.message);
    process.exit(1);
  }
  return list.map((d, i) => {
    if (!d.host) throw new Error(`Cihaz #${i + 1}: "host" alanı zorunlu`);
    if (d.mac) magicPacket(d.mac); // MAC'i erken doğrula
    return {
      id: String(d.id || 'dev' + (i + 1)).replace(/[^a-z0-9_-]/gi, ''),
      name: d.name || d.host,
      icon: d.icon === 'laptop' ? 'laptop' : 'desktop',
      host: d.host,
      mac: d.mac || '',
      broadcast: d.broadcast || '',
      rustdeskId: String(d.rustdeskId || '').replace(/\s+/g, ''),
      camUrl: d.camUrl || '',
      checkPorts: Array.isArray(d.checkPorts) && d.checkPorts.length ? d.checkPorts.map(Number) : DEFAULT_PORTS,
    };
  });
}

const devices = loadDevices();
const state = Object.fromEntries(
  devices.map((d) => [d.id, { online: false, latency: null, lastSeen: null, camOnline: false, wakeAt: null, checked: false }])
);

// ---- Durum kontrolü

function tcpCheck(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok ? Date.now() - start : null);
    };
    sock.setTimeout(timeout, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

function icmpCheck(host) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '1', host], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /time[=<]([\d.]+)/.exec(stdout);
      resolve(m ? Math.round(Number(m[1])) : 1);
    });
  });
}

async function checkDevice(d) {
  const results = await Promise.all([icmpCheck(d.host), ...d.checkPorts.map((p) => tcpCheck(d.host, p))]);
  const hits = results.filter((r) => r !== null);
  const s = state[d.id];
  s.online = hits.length > 0;
  s.latency = s.online ? Math.min(...hits) : null;
  if (s.online) {
    s.lastSeen = Date.now();
    s.wakeAt = null;
  }
  if (d.camUrl && s.online) {
    try {
      const u = new URL(d.camUrl);
      s.camOnline = (await tcpCheck(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80))) !== null;
    } catch {
      s.camOnline = false;
    }
  } else s.camOnline = false;
  s.checked = true;
}

async function pollAll() {
  await Promise.all(devices.map((d) => checkDevice(d).catch((e) => log('kontrol hatası', d.id, e.message))));
}
pollAll();
setInterval(pollAll, POLL_MS);

// ---- Oturum

function sign(v) {
  return crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
}
function newSessionCookie(req) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `ek_session=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  const c = parseCookies(req).ek_session;
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

// Basit kaba-kuvvet koruması: IP başına 15 dakikada 10 hatalı deneme.
const failures = new Map();
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}
function isLocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) {
    failures.delete(ip);
    return false;
  }
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

// ---- Statik dosyalar

const PUBLIC = path.join(__dirname, 'public');
const pages = {
  index: fs.readFileSync(path.join(PUBLIC, 'index.html')),
  login: fs.readFileSync(path.join(PUBLIC, 'login.html')),
};
const SEC_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function sendPage(res, name) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(pages[name]);
}

// ---- Webcam proxy (go2rtc MJPEG akışı)

function proxyCam(d, req, res) {
  let u;
  try {
    u = new URL(d.camUrl);
  } catch {
    return send(res, 500, 'camUrl geçersiz');
  }
  const lib = u.protocol === 'https:' ? https : http;
  const upstream = lib.get(u, { timeout: 8000 }, (ur) => {
    res.writeHead(ur.statusCode || 502, {
      'Content-Type': ur.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      // Ters vekilin (Traefik) akışı sıkıştırıp tamponlamaması için:
      'Content-Encoding': 'identity',
      'X-Accel-Buffering': 'no',
      ...SEC_HEADERS,
    });
    ur.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (e) => {
    if (!res.headersSent) send(res, 502, 'Kamera yayınına ulaşılamadı: ' + e.message);
    else res.destroy();
  });
  res.on('close', () => upstream.destroy());
}

// ---- Wake

async function wake(d) {
  if (!d.mac) throw new Error('Bu cihaz için MAC adresi tanımlı değil');
  if (RELAY_URL) {
    const r = await fetch(RELAY_URL + '/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RELAY_TOKEN },
      body: JSON.stringify({ mac: d.mac, broadcast: d.broadcast }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error('Relay hatası: ' + r.status + ' ' + (await r.text()));
  } else {
    await sendWol(d.mac, d.broadcast);
  }
}

function publicDevice(d) {
  const s = state[d.id];
  return {
    id: d.id,
    name: d.name,
    icon: d.icon,
    host: d.host,
    rustdeskId: d.rustdeskId,
    hasWol: !!d.mac,
    hasCam: !!d.camUrl,
    ...s,
  };
}

// ---- Router

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/healthz') return send(res, 200, 'ok');

    if (p === '/login' && req.method === 'GET') {
      if (isAuthed(req)) return send(res, 302, '', { Location: '/' });
      return sendPage(res, 'login');
    }

    if (p === '/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (isLocked(ip)) return send(res, 302, '', { Location: '/login?e=locked' });
      const form = new URLSearchParams(await readBody(req));
      if (safeEqual(form.get('password') || '', PASSWORD)) {
        failures.delete(ip);
        return send(res, 302, '', { Location: '/', 'Set-Cookie': newSessionCookie(req) });
      }
      recordFailure(ip);
      log('hatalı giriş denemesi', ip);
      await new Promise((r) => setTimeout(r, 1000));
      return send(res, 302, '', { Location: '/login?e=1' });
    }

    if (p === '/logout' && req.method === 'POST') {
      return send(res, 302, '', { Location: '/login', 'Set-Cookie': 'ek_session=; Path=/; Max-Age=0' });
    }

    // --- Buradan sonrası oturum ister
    if (!isAuthed(req)) {
      if (p.startsWith('/api/') || p.startsWith('/cam/')) return send(res, 401, { error: 'unauthorized' });
      return send(res, 302, '', { Location: '/login' });
    }

    if (p === '/' && req.method === 'GET') return sendPage(res, 'index');

    if (p === '/api/devices' && req.method === 'GET') {
      return send(res, 200, { devices: devices.map(publicDevice), pollSeconds: POLL_MS / 1000 });
    }

    let m;
    if ((m = /^\/api\/devices\/([\w-]+)\/wake$/.exec(p)) && req.method === 'POST') {
      // Basit CSRF koruması: yalnızca JS'den gelen istekler (özel başlık)
      if (req.headers['x-requested-with'] !== 'ev-kontrol') return send(res, 403, { error: 'forbidden' });
      const d = devices.find((x) => x.id === m[1]);
      if (!d) return send(res, 404, { error: 'Cihaz bulunamadı' });
      await wake(d);
      state[d.id].wakeAt = Date.now();
      log('WoL gönderildi:', d.name);
      // Uyanınca hızlı fark etmek için birkaç ek kontrol
      [15e3, 30e3, 45e3, 60e3, 90e3].forEach((t) => setTimeout(() => checkDevice(d).catch(() => {}), t));
      return send(res, 200, { ok: true });
    }

    if ((m = /^\/api\/devices\/([\w-]+)\/refresh$/.exec(p)) && req.method === 'POST') {
      const d = devices.find((x) => x.id === m[1]);
      if (!d) return send(res, 404, { error: 'Cihaz bulunamadı' });
      await checkDevice(d);
      return send(res, 200, publicDevice(d));
    }

    if ((m = /^\/cam\/([\w-]+)$/.exec(p)) && req.method === 'GET') {
      const d = devices.find((x) => x.id === m[1]);
      if (!d || !d.camUrl) return send(res, 404, 'Kamera tanımlı değil');
      return proxyCam(d, req, res);
    }

    send(res, 404, 'not found');
  } catch (e) {
    log('hata', p, e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, BIND, () => {
  log(`tthome ${BIND}:${PORT} üzerinde çalışıyor — ${devices.length} cihaz`);
  log(RELAY_URL ? `WoL relay: ${RELAY_URL}` : 'WoL doğrudan gönderilecek (relay yok)');
});
