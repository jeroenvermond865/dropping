const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const store = require('./store');
const game = require('./game');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || 'beheer';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let state;

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build'), { maxAge: '7d' }));

// ---- hulpfuncties ----

function changed() {
  store.save(state);
  broadcast();
}

function broadcast() {
  io.to('admin').emit('admin', game.adminView(state));
  io.to('score').emit('score', publicScore());
  for (const t of state.teams) io.to('team:' + t.id).emit('view', game.teamView(state, t));
}

function publicScore() {
  return {
    title: state.settings.title,
    rows: game.scoreboard(state).map(({ pos, ...r }) => r),
  };
}

function newToken(session) {
  const token = crypto.randomBytes(18).toString('base64url');
  state.sessions[token] = { ...session, at: Date.now() };
  store.save(state);
  return token;
}

function session(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  return token && state.sessions[token];
}

function teamAuth(req, res, next) {
  const s = session(req);
  const team = s && s.type === 'team' && state.teams.find(t => t.id === s.teamId);
  if (!team) return res.status(401).json({ error: 'Log opnieuw in.' });
  req.team = team;
  next();
}

function adminAuth(req, res, next) {
  const s = session(req);
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'Alleen voor beheerders.' });
  next();
}

const clean = (v, max = 500) => String(v ?? '').slice(0, max);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---- openbaar ----

app.get('/api/teams', (req, res) => {
  res.json({ title: state.settings.title, teams: state.teams.map(t => ({ id: t.id, name: t.name, color: t.color })) });
});

app.get('/api/scoreboard', (req, res) => res.json(publicScore()));

app.post('/api/login', (req, res) => {
  const team = state.teams.find(t => t.id === req.body.teamId);
  if (!team || String(team.pin) !== String(req.body.pin || '').trim()) return res.status(401).json({ error: 'Pincode klopt niet.' });
  res.json({ token: newToken({ type: 'team', teamId: team.id }), team: { id: team.id, name: team.name } });
});

app.post('/api/admin/login', (req, res) => {
  if (String(req.body.pin || '').trim() !== ADMIN_PIN) return res.status(401).json({ error: 'Pincode klopt niet.' });
  res.json({ token: newToken({ type: 'admin' }) });
});

// ---- team ----

app.get('/api/me', teamAuth, (req, res) => res.json(game.teamView(state, req.team)));

function teamAction(fn) {
  return [teamAuth, (req, res) => {
    const out = fn(req);
    if (out.error) return res.status(400).json(out);
    changed();
    res.json(out);
  }];
}

app.post('/api/checkin', ...teamAction(req => game.checkin(state, req.team, {
  lat: num(req.body.lat, null), lng: num(req.body.lng, null), acc: num(req.body.acc, 0),
})));
app.post('/api/answer', ...teamAction(req => game.answer(state, req.team, clean(req.body.answer, 200))));
app.post('/api/hint', ...teamAction(req => game.useHint(state, req.team)));
app.post('/api/mist', ...teamAction(req => {
  const out = game.sendMist(state, req.team, req.body.teamId);
  if (out.ok) io.to('team:' + out.target.id).emit('mist', { from: req.team.name });
  return out.ok ? { ok: true } : out;
}));

app.post('/api/pos', teamAuth, (req, res) => {
  const lat = num(req.body.lat, null), lng = num(req.body.lng, null);
  if (lat === null || lng === null) return res.status(400).json({ error: 'Ongeldige positie.' });
  game.progressOf(state, req.team.id).pos = { lat, lng, acc: num(req.body.acc, 0), ts: Date.now() };
  store.save(state);
  io.to('admin').emit('pos', { teamId: req.team.id, lat, lng, ts: Date.now() });
  res.json({ ok: true });
});

// ---- beheer ----

app.get('/api/admin/state', adminAuth, (req, res) => res.json(game.adminView(state)));

const POINT_TYPES = ['checkin', 'vraag', 'keuze', 'opdracht'];

app.post('/api/admin/point', adminAuth, (req, res) => {
  const b = req.body;
  const lat = num(b.lat, null), lng = num(b.lng, null);
  if (lat === null || lng === null) return res.status(400).json({ error: 'Positie ontbreekt.' });
  const point = {
    id: b.id && state.points.some(p => p.id === b.id) ? b.id : game.id('p'),
    name: clean(b.name, 80) || 'Nieuw punt',
    lat, lng,
    radius: Math.min(Math.max(num(b.radius, state.settings.radius), 5), 500),
    type: POINT_TYPES.includes(b.type) ? b.type : 'checkin',
    intro: clean(b.intro), question: clean(b.question), answers: clean(b.answers, 300),
    options: Array.isArray(b.options) ? b.options.map(o => clean(o, 120)).filter(Boolean).slice(0, 6) : [],
    correct: num(b.correct, 0), hint: clean(b.hint, 300),
    points: Math.min(Math.max(num(b.points, 100), 0), 1000),
    letter: clean(b.letter, 3), kompas: !!b.kompas,
  };
  const i = state.points.findIndex(p => p.id === point.id);
  if (i >= 0) state.points[i] = point; else state.points.push(point);
  changed();
  res.json(point);
});

app.delete('/api/admin/point/:id', adminAuth, (req, res) => {
  state.points = state.points.filter(p => p.id !== req.params.id);
  changed();
  res.json({ ok: true });
});

app.post('/api/admin/order', adminAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const byId = new Map(state.points.map(p => [p.id, p]));
  const ordered = ids.map(i => byId.get(i)).filter(Boolean);
  state.points = [...ordered, ...state.points.filter(p => !ids.includes(p.id))];
  changed();
  res.json({ ok: true });
});

app.post('/api/admin/team', adminAuth, (req, res) => {
  const b = req.body;
  const team = {
    id: b.id && state.teams.some(t => t.id === b.id) ? b.id : game.id('t'),
    name: clean(b.name, 40) || 'Team',
    pin: clean(b.pin, 12) || String(Math.floor(1000 + Math.random() * 9000)),
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#4dd2ff',
    offset: Math.max(0, Math.floor(num(b.offset, 0))),
  };
  const i = state.teams.findIndex(t => t.id === team.id);
  if (i >= 0) state.teams[i] = team; else state.teams.push(team);
  changed();
  res.json(team);
});

app.delete('/api/admin/team/:id', adminAuth, (req, res) => {
  state.teams = state.teams.filter(t => t.id !== req.params.id);
  delete state.progress[req.params.id];
  for (const [k, s] of Object.entries(state.sessions)) if (s.teamId === req.params.id) delete state.sessions[k];
  changed();
  res.json({ ok: true });
});

app.post('/api/admin/zone', adminAuth, (req, res) => {
  const b = req.body;
  const polygon = (Array.isArray(b.polygon) ? b.polygon : [])
    .map(c => [num(c[0], null), num(c[1], null)]).filter(c => c[0] !== null && c[1] !== null);
  if (polygon.length < 3) return res.status(400).json({ error: 'Een zone heeft minstens 3 hoeken nodig.' });
  const zone = { id: b.id && state.zones.some(z => z.id === b.id) ? b.id : game.id('z'), name: clean(b.name, 80) || 'Verboden gebied', polygon };
  const i = state.zones.findIndex(z => z.id === zone.id);
  if (i >= 0) state.zones[i] = zone; else state.zones.push(zone);
  changed();
  res.json(zone);
});

app.delete('/api/admin/zone/:id', adminAuth, (req, res) => {
  state.zones = state.zones.filter(z => z.id !== req.params.id);
  changed();
  res.json({ ok: true });
});

app.post('/api/admin/settings', adminAuth, (req, res) => {
  const b = req.body, s = state.settings;
  if (b.title !== undefined) s.title = clean(b.title, 80);
  if (b.radius !== undefined) s.radius = Math.min(Math.max(num(b.radius, 30), 5), 500);
  if (b.hintCost !== undefined) s.hintCost = Math.max(0, num(b.hintCost, 20));
  if (b.testMode !== undefined) s.testMode = !!b.testMode;
  if (b.started !== undefined) s.started = !!b.started;
  if (b.lastIsFinish !== undefined) s.lastIsFinish = !!b.lastIsFinish;
  changed();
  res.json(s);
});

// Zet een team een punt verder (bijvoorbeeld als een punt onbereikbaar blijkt).
app.post('/api/admin/skip/:teamId', adminAuth, (req, res) => {
  const team = state.teams.find(t => t.id === req.params.teamId);
  const p = team && game.currentPoint(state, team);
  if (!p) return res.status(400).json({ error: 'Niets om over te slaan.' });
  const pr = game.progressOf(state, team.id);
  pr.results[p.id] = { ...(pr.results[p.id] || {}), arrivedAt: pr.results[p.id]?.arrivedAt || Date.now(), done: true, correct: false, doneAt: Date.now(), answerPoints: 0, skipped: true };
  if (!game.currentPoint(state, team)) pr.finishedAt = Date.now();
  changed();
  res.json({ ok: true });
});

app.post('/api/admin/reset', adminAuth, (req, res) => {
  if (req.body.teamId) delete state.progress[req.body.teamId];
  else state.progress = {};
  changed();
  res.json({ ok: true });
});

// ---- live verbindingen ----

io.on('connection', socket => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const s = token && state.sessions[token];
  if (s && s.type === 'admin') {
    socket.join('admin');
    socket.emit('admin', game.adminView(state));
  } else if (s && s.type === 'team' && state.teams.some(t => t.id === s.teamId)) {
    socket.join('team:' + s.teamId);
    socket.emit('view', game.teamView(state, state.teams.find(t => t.id === s.teamId)));
  }
  socket.join('score');
  socket.emit('score', publicScore());
});

// Ververs elke 30 s zodat aflopende mist en tijden bijgewerkt worden.
setInterval(broadcast, 30000);

(async () => {
  state = (await store.init()) || game.seed();
  state.sessions = state.sessions || {};
  store.save(state);
  server.listen(PORT, () => console.log(`Dropping draait op poort ${PORT} (${store.usesDatabase() ? 'Postgres' : 'bestand'})`));
})();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { await store.flush(); process.exit(0); });
}
