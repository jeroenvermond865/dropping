// Spelregels: route per team, inchecken, antwoorden en de score.
const crypto = require('crypto');

const id = (p = '') => p + crypto.randomBytes(5).toString('hex');

const ARRIVE_POINTS = [50, 30, 20]; // 1e, 2e, daarna bij een punt
const FASTEST_BONUS = 25;           // snelste juiste antwoord op een punt
const FINISH_POINTS = [100, 60, 30];
const MAX_TRIES = 3;
const MAX_JOKERS = 3;
const MIST_MS = 60 * 1000;

function seed() {
  // Voorbeeldpunten rond Lunteren. De posities zijn een schatting:
  // verplaats ze in het beheerscherm naar de echte plek.
  return {
    settings: {
      title: 'Dropping Familieweekend',
      radius: 30,
      hintCost: 20,
      testMode: true,
      started: false,
      lastIsFinish: true,
    },
    points: [
      { id: id('p'), name: 'Start: Landgoed de Scheleberg', lat: 52.0455, lng: 5.6655, radius: 40, type: 'checkin',
        intro: 'Welkom bij de dropping! Check hier in om te beginnen.', points: 50, letter: 'D' },
      { id: id('p'), name: 'Uitkijkpost', lat: 52.0560, lng: 5.6450, radius: 30, type: 'vraag',
        intro: 'Zoek de houten uitkijkpost aan de weg.', question: 'Hoeveel treden heeft de trap van de uitkijkpost?',
        answers: '', hint: 'Tel ze gewoon, ook de bovenste.', points: 100, letter: 'R', kompas: false },
      { id: id('p'), name: 'Middelpunt van Nederland', lat: 52.0575, lng: 5.6425, radius: 30, type: 'keuze',
        intro: 'Het hart van het land!', question: 'Welke stad was vroeger het middelpunt volgens de Utrechtse sterrenwacht?',
        options: ['Amersfoort', 'Lunteren', 'Utrecht', 'Ede'], correct: 0, hint: 'Denk aan de Onze Lieve Vrouwetoren.', points: 100, letter: 'O' },
      { id: id('p'), name: 'Opdracht onderweg', lat: 52.0650, lng: 5.6600, radius: 30, type: 'opdracht',
        intro: 'Alleen met het kompas! De kaart is weg.', question: 'Maak met het hele team een menselijke piramide en zing een couplet van een Sinterklaasliedje.',
        points: 75, letter: 'P', kompas: true },
      { id: id('p'), name: 'Finish: De Eiken Stek', lat: 52.0700, lng: 5.6920, radius: 40, type: 'vraag',
        intro: 'De laatste etappe, naar huis!', question: 'Wat is het codewoord van alle letters die je hebt verzameld?',
        answers: 'drop|dropje', points: 150, letter: '' },
    ],
    zones: [
      { id: id('z'), name: 'Bos Wekeromse Zand (na zonsondergang verboden)',
        polygon: [[52.0735, 5.6640], [52.0760, 5.6820], [52.0700, 5.6900], [52.0600, 5.6870], [52.0560, 5.6720], [52.0620, 5.6610]] },
    ],
    teams: [
      { id: id('t'), name: 'Team Vos', pin: '1234', color: '#ff7a3d', offset: 0 },
    ],
    progress: {},
    sessions: {},
  };
}

function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function distance(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Route van een team: de volgorde uit het beheer, met een eigen startpunt
// (offset) zodat teams elkaar niet op de hielen zitten. De finish blijft laatst.
function route(state, team) {
  const pts = state.points;
  if (!state.settings.lastIsFinish || pts.length < 3) return rotate(pts, team.offset);
  return [...rotate(pts.slice(0, -1), team.offset), pts[pts.length - 1]];
}

function rotate(arr, n) {
  if (!arr.length) return arr;
  const k = ((Number(n) || 0) % arr.length + arr.length) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

function progressOf(state, teamId) {
  if (!state.progress[teamId]) state.progress[teamId] = { results: {}, jokers: 0, mistUntil: 0, pos: null, finishedAt: null };
  return state.progress[teamId];
}

function currentPoint(state, team) {
  const pr = progressOf(state, team.id);
  return route(state, team).find(p => !(pr.results[p.id] && pr.results[p.id].done)) || null;
}

function arrivalRank(state, pointId, teamId) {
  const times = state.teams
    .map(t => ({ t: t.id, at: state.progress[t.id]?.results[pointId]?.arrivedAt }))
    .filter(x => x.at)
    .sort((a, b) => a.at - b.at);
  return times.findIndex(x => x.t === teamId);
}

// ---- acties van een team ----

function checkin(state, team, pos) {
  const p = currentPoint(state, team);
  if (!p) return { error: 'Je hebt alle punten al gehad!' };
  const pr = progressOf(state, team.id);
  const r = pr.results[p.id] || (pr.results[p.id] = {});
  if (r.arrivedAt) return { ok: true };
  if (!state.settings.testMode) {
    if (!pos || typeof pos.lat !== 'number') return { error: 'Geen gps-positie ontvangen.' };
    const d = distance(pos, p);
    const allowed = (p.radius || state.settings.radius) + Math.min(Number(pos.acc) || 0, 25);
    if (d > allowed) return { error: `Nog ${Math.round(d)} meter te gaan!` };
  }
  r.arrivedAt = Date.now();
  r.tries = 0;
  const rank = arrivalRank(state, p.id, team.id);
  r.arrivePoints = ARRIVE_POINTS[Math.min(rank, ARRIVE_POINTS.length - 1)];
  r.rank = rank + 1;
  if (rank === 0 && state.teams.length > 1) pr.jokers = Math.min(MAX_JOKERS, (pr.jokers || 0) + 1);
  if (p.type === 'checkin') finishPoint(state, team, p, r, true);
  return { ok: true, rank: r.rank, first: rank === 0 };
}

function answer(state, team, value) {
  const p = currentPoint(state, team);
  if (!p) return { error: 'Geen open punt.' };
  const r = progressOf(state, team.id).results[p.id];
  if (!r || !r.arrivedAt) return { error: 'Eerst inchecken bij het punt.' };
  let correct;
  if (p.type === 'opdracht') correct = true;
  else if (p.type === 'keuze') correct = Number(value) === Number(p.correct);
  else {
    const accepted = String(p.answers || '').split('|').map(normalize).filter(Boolean);
    // Zonder ingevuld antwoord telt elk antwoord goed (handig voor tellen/schatten).
    correct = accepted.length ? accepted.includes(normalize(value)) : normalize(value) !== '';
  }
  r.tries = (r.tries || 0) + 1;
  r.lastAnswer = String(value).slice(0, 200);
  if (correct) {
    finishPoint(state, team, p, r, true);
    return { ok: true, correct: true, letter: p.letter || '' };
  }
  if (r.tries >= MAX_TRIES) {
    finishPoint(state, team, p, r, false);
    return { ok: true, correct: false, out: true, letter: '' };
  }
  return { ok: true, correct: false, triesLeft: MAX_TRIES - r.tries };
}

function finishPoint(state, team, p, r, correct) {
  r.done = true;
  r.correct = correct;
  r.doneAt = Date.now();
  const base = Number(p.points) || 100;
  r.answerPoints = correct ? Math.max(base - 25 * Math.max(0, (r.tries || 1) - 1), 25) - (r.hint ? state.settings.hintCost : 0) : 0;
  const pr = progressOf(state, team.id);
  if (!currentPoint(state, team) && !pr.finishedAt) pr.finishedAt = Date.now();
}

function useHint(state, team) {
  const p = currentPoint(state, team);
  if (!p || !p.hint) return { error: 'Geen hint voor dit punt.' };
  const r = progressOf(state, team.id).results[p.id];
  if (!r || !r.arrivedAt) return { error: 'Eerst inchecken.' };
  r.hint = true;
  return { ok: true, hint: p.hint };
}

function sendMist(state, team, targetId) {
  const pr = progressOf(state, team.id);
  if (!pr.jokers) return { error: 'Je hebt geen mist-jokers.' };
  const target = state.teams.find(t => t.id === targetId && t.id !== team.id);
  if (!target) return { error: 'Onbekend team.' };
  pr.jokers -= 1;
  progressOf(state, target.id).mistUntil = Date.now() + MIST_MS;
  return { ok: true, target };
}

// ---- weergaven ----

function teamView(state, team) {
  const pr = progressOf(state, team.id);
  const r = route(state, team);
  const p = currentPoint(state, team);
  const res = p ? pr.results[p.id] || {} : {};
  const letters = r.filter(x => pr.results[x.id]?.correct && x.letter).map(x => x.letter);
  const done = r.filter(x => pr.results[x.id]?.done).map(x => ({ lat: x.lat, lng: x.lng, name: x.name }));
  const row = scoreboard(state).find(s => s.id === team.id);
  let point = null;
  if (p) {
    point = {
      id: p.id, name: p.name, lat: p.lat, lng: p.lng, type: p.type,
      radius: p.radius || state.settings.radius, intro: p.intro || '', kompas: !!p.kompas,
      hasHint: !!p.hint, points: Number(p.points) || 100,
    };
    if (res.arrivedAt) {
      Object.assign(point, { question: p.question || '', options: p.type === 'keuze' ? p.options || [] : null });
      if (res.hint) point.hint = p.hint;
    }
  }
  return {
    team: { id: team.id, name: team.name, color: team.color },
    settings: { title: state.settings.title, testMode: state.settings.testMode, started: state.settings.started },
    index: done.length, total: r.length, point,
    arrived: !!res.arrivedAt, tries: res.tries || 0, maxTries: MAX_TRIES,
    done, letters, jokers: pr.jokers || 0, mistUntil: pr.mistUntil || 0,
    finished: !!pr.finishedAt, score: row ? row.score : 0, rank: row ? row.rank : null,
    zones: state.zones,
    others: state.teams.filter(t => t.id !== team.id).map(t => ({ id: t.id, name: t.name, color: t.color })),
  };
}

function scoreboard(state) {
  const rows = state.teams.map(t => {
    const pr = state.progress[t.id] || { results: {} };
    const r = route(state, t);
    let score = 0, solved = 0, firsts = 0, times = [];
    for (const p of r) {
      const x = pr.results[p.id];
      if (!x) continue;
      score += (x.arrivePoints || 0) + (x.answerPoints || 0);
      if (x.rank === 1) firsts++;
      if (x.correct) solved++;
      if (x.correct && p.type !== 'checkin' && x.doneAt) times.push(x.doneAt - x.arrivedAt);
    }
    return { id: t.id, name: t.name, color: t.color, score, solved, firsts, fastest: 0,
      avgAnswerMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      done: r.filter(p => pr.results[p.id]?.done).length, total: r.length,
      finishedAt: pr.finishedAt || null, pos: pr.pos || null };
  });
  // Snelste juiste antwoord per punt
  for (const p of state.points) {
    if (p.type === 'checkin') continue;
    let best = null;
    for (const t of state.teams) {
      const x = state.progress[t.id]?.results[p.id];
      if (!x || !x.correct) continue;
      const ms = x.doneAt - x.arrivedAt;
      if (!best || ms < best.ms) best = { id: t.id, ms };
    }
    if (best && state.teams.length > 1) {
      const row = rows.find(r => r.id === best.id);
      row.fastest++;
      row.score += FASTEST_BONUS;
    }
  }
  // Finishbonus op volgorde van binnenkomst
  rows.filter(r => r.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt)
    .forEach((r, i) => { r.score += FINISH_POINTS[Math.min(i, FINISH_POINTS.length - 1)]; });
  rows.sort((a, b) => b.score - a.score || b.solved - a.solved);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function adminView(state) {
  const { sessions, ...rest } = state;
  return { ...rest, scoreboard: scoreboard(state) };
}

module.exports = {
  id, seed, distance, route, currentPoint, progressOf,
  checkin, answer, useHint, sendMist, teamView, scoreboard, adminView,
};
