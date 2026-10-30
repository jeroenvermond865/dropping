// Eenmalig: vragen bij de eerste twee punten, Team Vos weg en drie schatten langs
// Route rechtsom in Familieweekend 2026. Slaat over als de schatten er al zijn.
const game = require('./game');

const DROPPING = 'dc316e4ae5b';
const TEAM = 'De Avondstrijders';

const EDITS = {
  'Punt 1': { name: 'Start', type: 'keuze', intro: 'Welkom, Avondstrijders! Hier begint de tocht.',
    question: 'Waarom heet een dropping eigenlijk een dropping?',
    options: ['Omdat er vroeger drop werd uitgedeeld', 'Omdat je ergens wordt "gedropt" en zelf de weg moet vinden', 'Naar het Engelse woord voor regendruppel', 'Omdat je onderweg punten laat vallen'],
    correct: 1, hint: 'Denk aan het Engelse werkwoord to drop.' },
  'Punt 2': { name: 'Warming-up', type: 'keuze', intro: 'Even inschatten waar jullie aan begonnen zijn.',
    question: 'Hoe lang is de tocht van vanavond ongeveer?',
    options: ['3 kilometer', '7 kilometer', '12 kilometer', '20 kilometer'],
    correct: 1, hint: 'Meer dan een rondje om de kerk, minder dan een halve marathon.' },
  'Eerste bocht': { name: 'Stilteplek' },
};

const TREASURES = [
  { name: 'Schat bij de zuidbocht', lat: 52.08755, lng: 5.6795, points: 75 },
  { name: 'Schat langs de bosrand', lat: 52.09616, lng: 5.69645, points: 75 },
  { name: 'Schat vlak voor de finish', lat: 52.10776, lng: 5.69733, points: 75 },
];

module.exports = function avond2(db, save) {
  const d = db.droppings.find(x => x.id === DROPPING);
  if (!d) return console.log('[avond2] dropping niet gevonden');
  if (d.treasures.some(t => t.name === TREASURES[0].name)) return console.log('[avond2] al gedaan');

  for (const p of d.points) if (EDITS[p.name]) Object.assign(p, EDITS[p.name]);

  // In deze dropping blijft alleen De Avondstrijders over
  const gone = d.teams.filter(t => t.name !== TEAM).map(t => t.name);
  for (const t of d.teams.filter(t => t.name !== TEAM)) {
    delete d.progress[t.id];
    for (const [k, s] of Object.entries(db.sessions)) if (s.teamId === t.id) delete db.sessions[k];
  }
  d.teams = d.teams.filter(t => t.name === TEAM);

  for (const t of TREASURES) {
    if (game.inZone(d, t.lat, t.lng)) { console.log('[avond2] schat in verboden zone, overgeslagen:', t.name); continue; }
    d.treasures.push({ id: game.id('s'), claims: {}, ...t });
  }
  save(db);
  console.log('[avond2] klaar. Punten:', d.points.map(p => p.name).join(', '), '| teams weg:', gone.join(', '), '| schatten:', d.treasures.length);
};
