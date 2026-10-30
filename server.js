const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const store = require('./store');
const game = require('./game');
const routegen = require('./routegen');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || 'beheer';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let db; // { droppings: [...], sessions: {} }

const smallJson = express.json({ limit: '200kb' });
app.use((req, res, next) => (req.path === '/api/photo' ? next() : smallJson(req, res, next)));
// Altijd de nieuwste versie laten ophalen, ook op telefoons die agressief cachen.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build'), { maxAge: '7d' }));

// ---- hulpfuncties ----

const findDropping = id => (id && db.droppings.find(d => d.id === id)) || null;
const firstActive = () => db.droppings.find(d => d.active) || db.droppings[0];

function changed(d) {
  store.save(db);
  broadcast(d);
}

function broadcast(d) {
  io.to('admin:' + d.id).emit('admin', adminView(d));
  io.to('tv:' + d.id).emit('tv', game.tvView(d));
  io.to('score:' + d.id).emit('score', publicScore(d));
  for (const t of d.teams) io.to('team:' + t.id).emit('view', game.teamView(d, t));
}

// Na het aanmaken, hernoemen of (de)activeren van een dropping
function broadcastAll() {
  store.save(db);
  for (const d of db.droppings) broadcast(d);
  io.emit('droppings', publicDroppings());
}

function adminView(d) {
  return {
    ...game.adminView(d),
    dropping: { id: d.id, active: !!d.active },
    droppings: db.droppings.map(x => ({ id: x.id, name: x.settings.title, active: !!x.active, teams: x.teams.length, points: x.points.length })),
  };
}

function publicScore(d) {
  return {
    title: d.settings.title,
    rows: game.scoreboard(d).map(({ pos, ...r }) => r),
  };
}

function publicDroppings() {
  return db.droppings.filter(d => d.active).map(d => ({
    id: d.id, name: d.settings.title, started: !!d.settings.started,
    teams: d.teams.map(t => ({ id: t.id, name: t.name, color: t.color })),
  }));
}

function newToken(session) {
  const token = crypto.randomBytes(18).toString('base64url');
  db.sessions[token] = { ...session, at: Date.now() };
  store.save(db);
  return token;
}

function session(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  return token && db.sessions[token];
}

function teamAuth(req, res, next) {
  const s = session(req);
  const d = s && s.type === 'team' && findDropping(s.droppingId);
  const team = d && d.teams.find(t => t.id === s.teamId);
  if (!team) return res.status(401).json({ error: 'Log opnieuw in.' });
  req.d = d;
  req.team = team;
  next();
}

// Beheerders kiezen zelf welke dropping ze bewerken (header x-dropping).
function adminAuth(req, res, next) {
  const s = session(req);
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'Alleen voor beheerders.' });
  req.d = findDropping(req.headers['x-dropping']) || db.droppings[0];
  next();
}

// Openbare pagina's: ?d=<id> of droppingId in de body, anders de eerste actieve.
function pickDropping(req, res, next) {
  req.d = findDropping(req.query.d || (req.body && req.body.droppingId)) || firstActive();
  next();
}

// Logische standaardpincode: team 1 = 1111, team 2 = 2222, ... team 10 = 1010
function defaultPin(d) {
  const used = new Set(d.teams.map(t => String(t.pin)));
  for (let n = 1; n < 100; n++) {
    const pin = n < 10 ? String(n).repeat(4) : String(n).repeat(2);
    if (!used.has(pin)) return pin;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Hoofdletters en spaties tellen niet mee, zodat ook een teamnaam als wachtwoord werkt.
const samePin = (a, b) => String(a ?? '').replace(/\s+/g, '').toLowerCase() === String(b ?? '').replace(/\s+/g, '').toLowerCase();
const clean = (v, max = 500) => String(v ?? '').slice(0, max);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

app.use(['/api/teams', '/api/scoreboard', '/api/login', '/api/album'], pickDropping);

app.get('/api/droppings', (req, res) => res.json(publicDroppings()));

// ---- openbaar ----

app.get('/api/teams', (req, res) => {
  res.json({ title: req.d.settings.title, teams: req.d.teams.map(t => ({ id: t.id, name: t.name, color: t.color })) });
});

app.get('/api/scoreboard', (req, res) => res.json(publicScore(req.d)));

app.post('/api/login', (req, res) => {
  const team = req.d.teams.find(t => t.id === req.body.teamId);
  if (!team || !samePin(team.pin, req.body.pin)) return res.status(401).json({ error: 'Pincode klopt niet.' });
  res.json({ token: newToken({ type: 'team', teamId: team.id, droppingId: req.d.id }), team: { id: team.id, name: team.name }, dropping: { id: req.d.id, name: req.d.settings.title } });
});

app.post('/api/admin/login', (req, res) => {
  if (String(req.body.pin || '').trim().toLowerCase() !== ADMIN_PIN.toLowerCase()) return res.status(401).json({ error: 'Pincode klopt niet.' });
  res.json({ token: newToken({ type: 'admin' }) });
});

// Foutmeldingen van telefoons, alleen naar het logboek
let clientLogs = 0;
setInterval(() => { clientLogs = 0; }, 60000);
app.post('/api/clientlog', (req, res) => {
  if (clientLogs++ < 60) console.log('[telefoon]', clean(req.body.msg, 300), '|', clean(req.body.ua, 160));
  res.json({ ok: true });
});

// ---- team ----

app.get('/api/me', teamAuth, (req, res) => res.json(game.teamView(req.d, req.team)));

function teamAction(fn) {
  return [teamAuth, (req, res) => {
    const wasDone = !!game.progressOf(req.d, req.team.id).finishedAt;
    const out = fn(req);
    if (out.error) return res.status(400).json(out);
    changed(req.d);
    finishCheck(req.d, req.team, wasDone);
    res.json(out);
  }];
}

// Team net binnen: het scorebord als grote pop-up op de tv
function finishCheck(d, team, wasDone) {
  if (wasDone || !game.progressOf(d, team.id).finishedAt) return;
  const rows = game.scoreboard(d).map(({ pos, ...r }) => r);
  tvLive(d, team, { kind: 'finish', rows, rank: (rows.find(r => r.id === team.id) || {}).rank });
}

// Live meekijken op het tv-scherm: opdracht, antwoord, punten en foto's
function tvLive(d, team, ev) {
  io.to('tv:' + d.id).emit('live', { ...ev, team: { id: team.id, name: team.name, color: team.color }, ts: Date.now() });
}
const tvPoint = p => ({ name: p.name, type: p.type, question: p.question || '', options: p.type === 'keuze' ? p.options || [] : [], points: Number(p.points) || 100 });

app.post('/api/checkin', ...teamAction(req => {
  const p = game.currentPoint(req.d, req.team);
  const out = game.checkin(req.d, req.team, { lat: num(req.body.lat, null), lng: num(req.body.lng, null), acc: num(req.body.acc, 0) });
  if (out.ok && out.rank && p) tvLive(req.d, req.team, { kind: p.type === 'checkin' ? 'aangekomen' : 'opdracht', point: tvPoint(p), rank: out.rank });
  return out;
}));
app.post('/api/answer', ...teamAction(req => {
  const p = game.currentPoint(req.d, req.team);
  const value = clean(req.body.answer, 200);
  const out = game.answer(req.d, req.team, value);
  if (out.ok && p) {
    const r = game.progressOf(req.d, req.team.id).results[p.id] || {};
    const shown = p.type === 'keuze' ? (p.options || [])[Number(value)] || value : p.type === 'opdracht' ? 'Opdracht gedaan ✅' : value;
    tvLive(req.d, req.team, { kind: 'antwoord', point: tvPoint(p), answer: shown, correct: !!out.correct, out: !!out.out,
      triesLeft: out.triesLeft, points: out.correct || out.out ? r.answerPoints || 0 : null });
  }
  return out;
}));
app.post('/api/hint', ...teamAction(req => game.useHint(req.d, req.team)));
app.post('/api/mist', ...teamAction(req => {
  const out = game.sendMist(req.d, req.team, req.body.teamId);
  if (out.ok) {
    io.to('team:' + out.target.id).emit('mist', { from: req.team.name });
    game.event(req.d, `🌫️ ${req.team.name} stuurde mist naar ${out.target.name}`, req.team.id);
  }
  return out.ok ? { ok: true } : out;
}));

// Meerdere telefoons in één team: van hun recente posities wordt één gemiddelde gemaakt,
// zodat het team als één punt op de kaart staat.
const devicePos = {}; // teamId -> { token: { lat, lng, acc, ts } }

function teamPos(teamId, token, pos) {
  const devs = devicePos[teamId] || (devicePos[teamId] = {});
  devs[token] = { ...pos, ts: Date.now() };
  for (const [k, p] of Object.entries(devs)) if (Date.now() - p.ts > 30000) delete devs[k];
  const recent = Object.values(devs);
  const avg = k => recent.reduce((s, p) => s + p[k], 0) / recent.length;
  return { lat: avg('lat'), lng: avg('lng'), acc: Math.min(...recent.map(p => p.acc)) };
}

// Spelers kunnen tijdens het testen zelf opnieuw beginnen.
app.post('/api/restart', teamAuth, (req, res) => {
  if (!req.d.settings.testMode) return res.status(400).json({ error: 'Opnieuw beginnen kan alleen in testmodus. Vraag het beheer.' });
  delete req.d.progress[req.team.id];
  for (const t of req.d.treasures) if (t.claims) delete t.claims[req.team.id];
  req.d.photos = req.d.photos.filter(p => p.teamId !== req.team.id);
  changed(req.d);
  res.json({ ok: true });
});

app.post('/api/pos', teamAuth, (req, res) => {
  const lat = num(req.body.lat, null), lng = num(req.body.lng, null);
  if (lat === null || lng === null) return res.status(400).json({ error: 'Ongeldige positie.' });
  const pos = teamPos(req.team.id, req.headers.authorization || '', { lat, lng, acc: num(req.body.acc, 0) });
  const newTreasure = game.recordPos(req.d, req.team, pos);
  if (newTreasure) changed(req.d);
  else {
    store.save(db);
    io.to('admin:' + req.d.id).emit('pos', { teamId: req.team.id, lat: pos.lat, lng: pos.lng, ts: Date.now() });
    io.to('tv:' + req.d.id).emit('pos', { teamId: req.team.id, lat: pos.lat, lng: pos.lng, ts: Date.now() });
  }
  res.json({ ok: true });
});

app.post('/api/treasure/:id', ...teamAction(req => {
  const out = game.claimTreasure(req.d, req.team, req.params.id, { lat: num(req.body.lat, null), lng: num(req.body.lng, null), acc: num(req.body.acc, 0) });
  if (out.ok) tvLive(req.d, req.team, { kind: 'schat', points: out.points, first: out.first });
  return out;
}));

app.post('/api/photo', express.json({ limit: '6mb' }), teamAuth, async (req, res) => {
  const p = game.currentPoint(req.d, req.team);
  const r = p && game.progressOf(req.d, req.team.id).results[p.id];
  if (!p || p.type !== 'foto' || !r || !r.arrivedAt) return res.status(400).json({ error: 'Hier hoort geen foto bij.' });
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(req.body.data || ''));
  const buf = m && Buffer.from(m[1], 'base64');
  if (!buf || buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Dat is geen goede foto.' });
  const photoId = crypto.randomBytes(12).toString('hex');
  try { await store.savePhoto(photoId, buf); }
  catch (e) { console.error('Foto opslaan mislukt:', e.message); return res.status(500).json({ error: 'Foto opslaan mislukt, probeer opnieuw.' }); }
  const wasDone = !!game.progressOf(req.d, req.team.id).finishedAt;
  const out = game.submitPhoto(req.d, req.team, photoId);
  if (out.error) return res.status(400).json(out);
  changed(req.d);
  setTimeout(() => finishCheck(req.d, req.team, wasDone), 1500);
  // Meteen een venster in het beheer om de foto te beoordelen
  io.to('admin:' + req.d.id).emit('newPhoto', { ...out.photo, teamName: req.team.name });
  tvLive(req.d, req.team, { kind: 'foto', photoId: out.photo.id, point: { name: out.photo.pointName }, max: out.photo.max });
  res.json({ ok: true, letter: out.letter });
});

app.get('/foto/:id', async (req, res) => {
  if (!/^[0-9a-f]{24}$/.test(req.params.id)) return res.sendStatus(404);
  const buf = await store.getPhoto(req.params.id).catch(() => null);
  if (!buf) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' }).send(buf);
});

app.get('/api/album', (req, res) => {
  res.json({ title: req.d.settings.title, photos: req.d.photos.filter(p => p.status === 'goed').map(p => ({ ...p, team: req.d.teams.find(t => t.id === p.teamId) || null })) });
});

// ---- beheer ----

// Locaties zoeken via OpenStreetMap (Nominatim), met voorkeur voor de buurt van Lunteren.
const searchCache = new Map();
let lastSearch = 0;
app.get('/api/admin/zoek', adminAuth, async (req, res) => {
  const q = clean(req.query.q, 120).trim();
  if (q.length < 2) return res.json([]);
  if (searchCache.has(q)) return res.json(searchCache.get(q));
  // Nominatim staat maximaal 1 verzoek per seconde toe
  const wait = lastSearch + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSearch = Date.now();
  try {
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q, format: 'jsonv2', limit: '7', countrycodes: 'nl', 'accept-language': 'nl', viewbox: '5.55,52.12,5.78,52.00', bounded: '0',
    });
    const r = await fetch(url, { headers: { 'User-Agent': 'dropping-familieweekend/1.0 (https://dropping.onrender.com)' } });
    if (!r.ok) throw new Error('status ' + r.status);
    const out = (await r.json()).map(x => ({ name: x.display_name, lat: Number(x.lat), lng: Number(x.lon), type: x.type }));
    searchCache.set(q, out);
    res.json(out);
  } catch (e) {
    console.error('Zoeken mislukt:', e.message);
    res.status(502).json({ error: 'Zoeken lukt nu even niet.' });
  }
});

app.get('/api/admin/state', adminAuth, (req, res) => res.json(adminView(req.d)));

const POINT_TYPES = ['checkin', 'vraag', 'keuze', 'opdracht', 'foto'];
const ZONE_ERROR = { error: 'Dit ligt in een verboden gebied (bos). Kies een plek erbuiten.' };

app.post('/api/admin/point', adminAuth, (req, res) => {
  const b = req.body;
  const lat = num(b.lat, null), lng = num(b.lng, null);
  if (lat === null || lng === null) return res.status(400).json({ error: 'Positie ontbreekt.' });
  if (game.inZone(req.d, lat, lng)) return res.status(400).json(ZONE_ERROR);
  const point = {
    id: b.id && req.d.points.some(p => p.id === b.id) ? b.id : game.id('p'),
    name: clean(b.name, 80) || 'Nieuw punt',
    lat, lng,
    radius: Math.min(Math.max(num(b.radius, req.d.settings.radius), 5), 500),
    type: POINT_TYPES.includes(b.type) ? b.type : 'checkin',
    intro: clean(b.intro), question: clean(b.question), answers: clean(b.answers, 300),
    options: Array.isArray(b.options) ? b.options.map(o => clean(o, 120)).filter(Boolean).slice(0, 6) : [],
    correct: num(b.correct, 0), hint: clean(b.hint, 300),
    points: Math.min(Math.max(num(b.points, 100), 0), 1000),
    letter: clean(b.letter, 3), kompas: !!b.kompas,
  };
  const i = req.d.points.findIndex(p => p.id === point.id);
  if (i >= 0) req.d.points[i] = point; else req.d.points.push(point);
  changed(req.d);
  res.json(point);
});

app.delete('/api/admin/point/:id', adminAuth, (req, res) => {
  req.d.points = req.d.points.filter(p => p.id !== req.params.id);
  changed(req.d);
  res.json({ ok: true });
});

app.post('/api/admin/order', adminAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const byId = new Map(req.d.points.map(p => [p.id, p]));
  const ordered = ids.map(i => byId.get(i)).filter(Boolean);
  req.d.points = [...ordered, ...req.d.points.filter(p => !ids.includes(p.id))];
  changed(req.d);
  res.json({ ok: true });
});

app.post('/api/admin/treasure', adminAuth, (req, res) => {
  const b = req.body;
  const lat = num(b.lat, null), lng = num(b.lng, null);
  if (lat === null || lng === null) return res.status(400).json({ error: 'Positie ontbreekt.' });
  if (game.inZone(req.d, lat, lng)) return res.status(400).json(ZONE_ERROR);
  const old = req.d.treasures.find(t => t.id === b.id);
  const t = { id: old ? old.id : game.id('s'), name: clean(b.name, 60) || 'Schat', lat, lng,
    points: Math.min(Math.max(num(b.points, 50), 0), 1000), claims: old ? old.claims : {} };
  if (old) Object.assign(old, t); else req.d.treasures.push(t);
  changed(req.d);
  res.json(t);
});

app.delete('/api/admin/treasure/:id', adminAuth, (req, res) => {
  req.d.treasures = req.d.treasures.filter(t => t.id !== req.params.id);
  changed(req.d);
  res.json({ ok: true });
});

app.post('/api/admin/scatter', adminAuth, (req, res) => {
  const out = game.scatterTreasures(req.d, Math.min(Math.max(Math.floor(num(req.body.count, 5)), 1), 30), Math.min(Math.max(num(req.body.points, 50), 0), 1000));
  if (out.error) return res.status(400).json(out);
  changed(req.d);
  res.json(out);
});

app.post('/api/admin/path', adminAuth, (req, res) => {
  const b = req.body;
  const line = (Array.isArray(b.line) ? b.line : [])
    .map(c => [num(c[0], null), num(c[1], null)]).filter(c => c[0] !== null && c[1] !== null);
  if (line.length < 2) return res.status(400).json({ error: 'Een route heeft minstens 2 punten nodig.' });
  const path_ = { id: b.id && req.d.paths.some(p => p.id === b.id) ? b.id : game.id('r'), name: clean(b.name, 80) || 'Looproute', line };
  const i = req.d.paths.findIndex(p => p.id === path_.id);
  if (i >= 0) req.d.paths[i] = path_; else req.d.paths.push(path_);
  changed(req.d);
  res.json(path_);
});

app.delete('/api/admin/path/:id', adminAuth, (req, res) => {
  req.d.paths = req.d.paths.filter(p => p.id !== req.params.id);
  changed(req.d);
  res.json({ ok: true });
});

// ---- automatische route ----

const latlng = p => (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) ? { lat: Number(p.lat), lng: Number(p.lng) } : null);

app.post('/api/admin/routegen/preview', adminAuth, async (req, res) => {
  const start = latlng(req.body.start), end = latlng(req.body.end);
  if (!start || !end) return res.status(400).json({ error: 'Kies een start en een finish.' });
  try {
    const out = await routegen.preview(req.d, start, end);
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) {
    console.error('Route maken mislukt:', e.message);
    res.status(502).json({ error: 'De kaartgegevens van OpenStreetMap zijn nu niet bereikbaar. Probeer het over een minuut opnieuw.' });
  }
});

app.post('/api/admin/routegen/apply', adminAuth, (req, res) => {
  const line = (Array.isArray(req.body.line) ? req.body.line : [])
    .map(c => [num(c[0], null), num(c[1], null)]).filter(c => c[0] !== null && c[1] !== null);
  if (line.length < 2) return res.status(400).json({ error: 'Geen route ontvangen.' });
  const count = Math.min(Math.max(Math.floor(num(req.body.count, 6)), 1), 20);
  const side = req.body.side === 'rechtsom' ? 'rechtsom' : 'linksom';
  const { points, total } = routegen.placePoints(req.d, line, count);
  const mk = (p, extra = {}) => ({
    id: game.id('p'), name: clean(p.name, 80), lat: p.lat, lng: p.lng, radius: req.d.settings.radius, type: 'checkin',
    intro: p.intro || '', question: '', answers: '', options: [], correct: 0, hint: '', points: 50, letter: '', kompas: false, ...extra,
  });
  const mid = points.filter(p => !game.inZone(req.d, p.lat, p.lng)).map(p => mk(p));
  if (req.body.replace) {
    const [sLat, sLng] = line[0], [eLat, eLng] = line[line.length - 1];
    req.d.points = [
      mk({ name: 'Start', lat: sLat, lng: sLng, intro: 'Welkom bij de dropping! Check hier in om te beginnen.' }),
      ...mid,
      mk({ name: 'Finish', lat: eLat, lng: eLng, intro: 'De laatste etappe, naar huis!' }, { points: 100 }),
    ];
  } else if (req.d.settings.lastIsFinish && req.d.points.length) {
    req.d.points.splice(req.d.points.length - 1, 0, ...mid);
  } else {
    req.d.points.push(...mid);
  }
  req.d.paths.push({ id: game.id('r'), name: `Automatische route ${side} (${(total / 1000).toFixed(1).replace('.', ',')} km)`, line });
  changed(req.d);
  res.json({ ok: true, added: mid.length, poi: points.filter(p => p.poi).length, total });
});

app.post('/api/admin/photo/:id', adminAuth, (req, res) => {
  const out = game.judgePhoto(req.d, req.params.id, !!req.body.approve, req.body.points === undefined ? undefined : num(req.body.points, 0));
  if (out.error) return res.status(400).json(out);
  changed(req.d);
  io.to('team:' + out.teamId).emit('photoJudged', out);
  const team = req.d.teams.find(t => t.id === out.teamId);
  if (team) tvLive(req.d, team, { kind: 'fotoBeoordeeld', photoId: req.params.id, point: { name: out.pointName }, approve: out.approve, points: out.points, max: out.max });
  res.json(out);
});

app.post('/api/admin/team', adminAuth, (req, res) => {
  const b = req.body;
  const team = {
    id: b.id && req.d.teams.some(t => t.id === b.id) ? b.id : game.id('t'),
    name: clean(b.name, 40) || 'Team',
    pin: clean(b.pin, 40).trim() || req.d.teams.find(t => t.id === b.id)?.pin || defaultPin(req.d),
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#4dd2ff',
    offset: Math.max(0, Math.floor(num(b.offset, 0))),
  };
  const i = req.d.teams.findIndex(t => t.id === team.id);
  if (i >= 0) req.d.teams[i] = team; else req.d.teams.push(team);
  changed(req.d);
  res.json(team);
});

app.delete('/api/admin/team/:id', adminAuth, (req, res) => {
  req.d.teams = req.d.teams.filter(t => t.id !== req.params.id);
  delete req.d.progress[req.params.id];
  for (const [k, s] of Object.entries(db.sessions)) if (s.teamId === req.params.id) delete db.sessions[k];
  changed(req.d);
  res.json({ ok: true });
});

app.post('/api/admin/zone', adminAuth, (req, res) => {
  const b = req.body;
  const polygon = (Array.isArray(b.polygon) ? b.polygon : [])
    .map(c => [num(c[0], null), num(c[1], null)]).filter(c => c[0] !== null && c[1] !== null);
  if (polygon.length < 3) return res.status(400).json({ error: 'Een zone heeft minstens 3 hoeken nodig.' });
  const zone = { id: b.id && req.d.zones.some(z => z.id === b.id) ? b.id : game.id('z'), name: clean(b.name, 80) || 'Verboden gebied', polygon };
  const i = req.d.zones.findIndex(z => z.id === zone.id);
  if (i >= 0) req.d.zones[i] = zone; else req.d.zones.push(zone);
  changed(req.d);
  res.json(zone);
});

app.delete('/api/admin/zone/:id', adminAuth, (req, res) => {
  req.d.zones = req.d.zones.filter(z => z.id !== req.params.id);
  changed(req.d);
  res.json({ ok: true });
});

app.post('/api/admin/settings', adminAuth, (req, res) => {
  const b = req.body, s = req.d.settings;
  if (b.title !== undefined) s.title = clean(b.title, 80);
  if (b.radius !== undefined) s.radius = Math.min(Math.max(num(b.radius, 30), 5), 500);
  if (b.hintCost !== undefined) s.hintCost = Math.max(0, num(b.hintCost, 20));
  if (b.testMode !== undefined) s.testMode = !!b.testMode;
  if (b.started !== undefined) s.started = !!b.started;
  if (b.lastIsFinish !== undefined) s.lastIsFinish = !!b.lastIsFinish;
  if (b.treasureReveal !== undefined) s.treasureReveal = Math.min(Math.max(num(b.treasureReveal, 100), 20), 1000);
  if (b.showPath !== undefined) s.showPath = !!b.showPath;
  if (b.showMap !== undefined) s.showMap = !!b.showMap;
  changed(req.d);
  res.json(s);
});

// Zet een team een punt verder (bijvoorbeeld als een punt onbereikbaar blijkt).
app.post('/api/admin/skip/:teamId', adminAuth, (req, res) => {
  const team = req.d.teams.find(t => t.id === req.params.teamId);
  const p = team && game.currentPoint(req.d, team);
  if (!p) return res.status(400).json({ error: 'Niets om over te slaan.' });
  const pr = game.progressOf(req.d, team.id);
  pr.results[p.id] = { ...(pr.results[p.id] || {}), arrivedAt: pr.results[p.id]?.arrivedAt || Date.now(), done: true, correct: false, doneAt: Date.now(), answerPoints: 0, skipped: true };
  if (!game.currentPoint(req.d, team)) pr.finishedAt = Date.now();
  changed(req.d);
  res.json({ ok: true });
});

app.post('/api/admin/reset', adminAuth, (req, res) => {
  const teamId = req.body.teamId;
  if (teamId) {
    delete req.d.progress[teamId];
    for (const t of req.d.treasures) if (t.claims) delete t.claims[teamId];
    req.d.photos = req.d.photos.filter(p => p.teamId !== teamId);
  } else {
    req.d.progress = {};
    for (const t of req.d.treasures) t.claims = {};
    req.d.photos = [];
    req.d.events = [];
  }
  changed(req.d);
  res.json({ ok: true });
});

// ---- droppings beheren ----

const TEAM_COLORS = ['#ff7a3d', '#4dd2ff', '#3ee08f', '#b06bff', '#ffc44d', '#ff5470'];

function emptyDropping(name, from) {
  const d = game.seed();
  d.id = game.id('d');
  d.active = false;
  d.settings.title = name;
  d.points = [];
  d.treasures = [];
  d.paths = [];
  d.zones = from ? JSON.parse(JSON.stringify(from.zones)) : d.zones;
  d.teams = [];
  d.teams.push({ id: game.id('t'), name: 'Team 1', pin: defaultPin(d), color: TEAM_COLORS[0], offset: 0 });
  delete d.sessions;
  return d;
}

app.post('/api/admin/dropping', adminAuth, (req, res) => {
  const name = clean(req.body.name, 80).trim() || 'Nieuwe dropping';
  const from = findDropping(req.body.copyFrom);
  let d;
  if (from) {
    // Kopie: route, zones, teams en schatten mee, maar zonder voortgang
    d = JSON.parse(JSON.stringify({ settings: from.settings, points: from.points, zones: from.zones, paths: from.paths, teams: from.teams, treasures: from.treasures }));
    d = game.migrate({ ...d, id: game.id('d'), active: false, progress: {}, photos: [], events: [] });
    delete d.sessions;
    d.settings.title = name;
    d.settings.started = false;
    for (const t of d.teams) t.id = game.id('t');
    for (const t of d.treasures) t.claims = {};
  } else {
    d = emptyDropping(name, db.droppings[0]);
  }
  db.droppings.push(d);
  broadcastAll();
  res.json({ id: d.id });
});

app.post('/api/admin/dropping/:id', adminAuth, (req, res) => {
  const d = findDropping(req.params.id);
  if (!d) return res.status(404).json({ error: 'Deze dropping bestaat niet meer.' });
  if (req.body.name !== undefined) d.settings.title = clean(req.body.name, 80).trim() || d.settings.title;
  if (req.body.active !== undefined) d.active = !!req.body.active;
  broadcastAll();
  res.json({ ok: true });
});

app.delete('/api/admin/dropping/:id', adminAuth, (req, res) => {
  if (db.droppings.length <= 1) return res.status(400).json({ error: 'De laatste dropping kan niet weg. Maak eerst een nieuwe aan.' });
  const d = findDropping(req.params.id);
  if (!d) return res.status(404).json({ error: 'Deze dropping bestaat niet meer.' });
  db.droppings = db.droppings.filter(x => x !== d);
  for (const [k, s] of Object.entries(db.sessions)) if (s.droppingId === d.id) delete db.sessions[k];
  broadcastAll();
  res.json({ ok: true });
});

// ---- live verbindingen ----

io.on('connection', socket => {
  const auth = socket.handshake.auth || {};
  const s = auth.token && db.sessions[auth.token];
  let d = findDropping(auth.dropping) || firstActive();
  if (s && s.type === 'admin' && auth.tv) {
    socket.join('tv:' + d.id);
    socket.emit('tv', game.tvView(d));
  } else if (s && s.type === 'admin') {
    d = findDropping(auth.dropping) || db.droppings[0];
    socket.join('admin:' + d.id);
    socket.emit('admin', adminView(d));
  } else if (s && s.type === 'team' && findDropping(s.droppingId)?.teams.some(t => t.id === s.teamId)) {
    d = findDropping(s.droppingId);
    socket.join('team:' + s.teamId);
    socket.emit('view', game.teamView(d, d.teams.find(t => t.id === s.teamId)));
  }
  socket.join('score:' + d.id);
  socket.emit('score', publicScore(d));
});

// Ververs elke 30 s zodat aflopende mist en tijden bijgewerkt worden.
setInterval(() => db.droppings.forEach(broadcast), 30000);

// Oude opslag (één spel) omzetten naar een lijst droppings.
function migrateDb(raw) {
  if (raw && Array.isArray(raw.droppings)) {
    raw.sessions = raw.sessions || {};
    raw.droppings = raw.droppings.map(d => { const m = game.migrate(d); delete m.sessions; return m; });
    return raw;
  }
  const old = game.migrate(raw || game.seed());
  const { sessions, ...d } = old;
  d.id = game.id('d');
  d.active = true;
  if (d.settings.title === 'Dropping Familieweekend') d.settings.title = 'Familieweekend 2026';
  // Logische pincodes: team 1 = 1111, team 2 = 2222, ...
  const pins = d.teams.map(t => t.pin);
  d.teams.forEach(t => { t.pin = null; });
  d.teams.forEach(t => { t.pin = defaultPin(d); });
  // Sessies blijven geldig, maar weten nu bij welke dropping ze horen
  for (const s of Object.values(sessions)) if (s.type === 'team') s.droppingId = d.id;
  console.log('Opslag omgezet naar meerdere droppings; pincodes', pins.join(','), '->', d.teams.map(t => t.pin).join(','));
  return { droppings: [d], sessions };
}

(async () => {
  db = migrateDb(await store.init());
  store.save(db);
  server.listen(PORT, () => console.log(`Dropping draait op poort ${PORT} (${store.usesDatabase() ? 'Postgres' : 'bestand'})`));
})();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { await store.flush(); process.exit(0); });
}
