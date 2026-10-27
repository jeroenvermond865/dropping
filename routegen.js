// Automatische route: haalt wandelpaden en leuke plekken uit OpenStreetMap (Overpass),
// zoekt een route over die paden buiten de verboden zones, en verdeelt punten langs de route.
const { distance, inZone } = require('./game');

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

// Welke wegen mogen, en hoe prettig ze zijn om in het donker te lopen (lager = liever).
const WAY_COST = {
  footway: 1, path: 1, track: 1, bridleway: 1.1, cycleway: 1.15, pedestrian: 1, living_street: 1.1,
  residential: 1.25, unclassified: 1.3, service: 1.35, tertiary: 1.8, steps: 2,
};

const POI_KINDS = [
  { test: t => t.tourism === 'viewpoint', label: 'Uitkijkpunt', score: 4, intro: 'Zoek het uitkijkpunt.' },
  { test: t => t.man_made === 'tower' || t.tower, label: 'Uitkijktoren', score: 4, intro: 'Zoek de toren.' },
  { test: t => !!t.historic, label: 'Monument', score: 3, intro: 'Hier staat iets historisch. Zoek het!' },
  { test: t => t.tourism === 'artwork', label: 'Kunstwerk', score: 3, intro: 'Zoek het kunstwerk.' },
  { test: t => t.tourism === 'picnic_site' || t.leisure === 'picnic_table', label: 'Picknickplek', score: 2, intro: 'Zoek de picknickplek.' },
  { test: t => t.amenity === 'shelter', label: 'Schuilhut', score: 2, intro: 'Zoek de schuilhut.' },
  { test: t => t.tourism === 'information', label: 'Informatiebord', score: 1.5, intro: 'Zoek het bord langs het pad.' },
  { test: t => t.amenity === 'bench', label: 'Bankje', score: 1, intro: 'Zoek het bankje langs het pad.' },
];

let cache = null; // { key, graph, pois }

function bboxFor(state, start, end) {
  const pts = [start, end, ...state.zones.flatMap(z => z.polygon.map(c => ({ lat: c[0], lng: c[1] })))];
  const pad = 0.015; // ongeveer 1,5 km
  return {
    s: Math.min(...pts.map(p => p.lat)) - pad, n: Math.max(...pts.map(p => p.lat)) + pad,
    w: Math.min(...pts.map(p => p.lng)) - pad * 1.6, e: Math.max(...pts.map(p => p.lng)) + pad * 1.6,
  };
}

async function fetchOverpass(b) {
  const box = `${b.s},${b.w},${b.n},${b.e}`;
  const q = `[out:json][timeout:90];
(
  way["highway"~"^(${Object.keys(WAY_COST).join('|')})$"](${box});
  node["tourism"~"^(viewpoint|picnic_site|artwork|information)$"](${box});
  node["amenity"~"^(bench|shelter)$"](${box});
  node["historic"](${box});
  node["man_made"="tower"](${box});
  node["leisure"="picnic_table"](${box});
);
out geom qt;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'dropping-familieweekend/1.0' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(100000),
      });
      if (!r.ok) throw new Error('Overpass ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function blocked(tags) {
  return ['private', 'no'].includes(tags.access) || tags.foot === 'no' || tags.foot === 'private';
}

function buildGraph(state, osm) {
  const nodes = new Map(); // id -> { lat, lng, edges: [[id, cost, len]] }
  const pois = [];
  for (const el of osm.elements || []) {
    if (el.type === 'node' && el.tags) {
      const kind = POI_KINDS.find(k => k.test(el.tags));
      if (kind && !inZone(state, el.lat, el.lon)) {
        pois.push({ lat: el.lat, lng: el.lon, name: el.tags.name || kind.label, kind });
      }
      continue;
    }
    if (el.type !== 'way' || !el.geometry || !el.nodes) continue;
    const tags = el.tags || {};
    const factor = WAY_COST[tags.highway];
    if (!factor || blocked(tags)) continue;
    for (let i = 0; i < el.nodes.length; i++) {
      const g = el.geometry[i];
      if (!g) continue;
      if (!nodes.has(el.nodes[i])) nodes.set(el.nodes[i], { lat: g.lat, lng: g.lon, edges: [] });
    }
    for (let i = 1; i < el.nodes.length; i++) {
      const a = nodes.get(el.nodes[i - 1]), b = nodes.get(el.nodes[i]);
      if (!a || !b) continue;
      const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
      if (inZone(state, a.lat, a.lng) || inZone(state, b.lat, b.lng) || inZone(state, mid.lat, mid.lng)) continue;
      const len = distance(a, b);
      a.edges.push([el.nodes[i], len * factor, len]);
      b.edges.push([el.nodes[i - 1], len * factor, len]);
    }
  }
  return { nodes, pois };
}

function nearestNode(graph, p) {
  let best = null, bd = Infinity;
  for (const [id, n] of graph.nodes) {
    if (!n.edges.length) continue;
    const d = distance(p, n);
    if (d < bd) { bd = d; best = id; }
  }
  return { id: best, dist: bd };
}

// Dijkstra met een kleine binaire heap. penalty: Map van "a|b" -> extra factor.
function shortest(graph, from, to, penalty) {
  const dist = new Map([[from, 0]]), prev = new Map(), heap = [[0, from]];
  const push = x => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === to) break;
    if (d > dist.get(u)) continue;
    for (const [v, cost] of graph.nodes.get(u).edges) {
      const extra = penalty ? penalty.get(u + '|' + v) || 1 : 1;
      const nd = d + cost * extra;
      if (nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); prev.set(v, u); push([nd, v]); }
    }
  }
  if (!dist.has(to)) return null;
  const ids = [to];
  while (ids[0] !== from) ids.unshift(prev.get(ids[0]));
  return ids;
}

function lineOf(graph, ids) {
  return ids.map(id => { const n = graph.nodes.get(id); return [n.lat, n.lng]; });
}

function lengthOf(line) {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += distance({ lat: line[i - 1][0], lng: line[i - 1][1] }, { lat: line[i][0], lng: line[i][1] });
  return m;
}

// Links of rechts van de rechte lijn start -> finish (gezien in looprichting)
function sideOf(line, start, end) {
  const dx = end.lng - start.lng, dy = end.lat - start.lat;
  let sum = 0;
  for (const [lat, lng] of line) sum += dx * (lat - start.lat) - dy * (lng - start.lng);
  return sum > 0 ? 'linksom' : 'rechtsom';
}

async function preview(state, start, end) {
  const b = bboxFor(state, start, end);
  const key = JSON.stringify([b, state.zones]);
  if (!cache || cache.key !== key) {
    const osm = await fetchOverpass(b);
    cache = { key, ...buildGraph(state, osm) };
  }
  const graph = cache;
  const s = nearestNode(graph, start), e = nearestNode(graph, end);
  if (s.id == null || e.id == null) return { error: 'Geen paden gevonden in dit gebied.' };
  if (s.dist > 400 || e.dist > 400) return { error: 'Start of finish ligt te ver van een pad. Zet ze dichter bij een weg.' };
  const a = shortest(graph, s.id, e.id);
  if (!a) return { error: 'Geen route gevonden buiten het verboden gebied.' };
  // Tweede route: maak de paden van de eerste route duur, zodat de andere kant van het bos gekozen wordt.
  const penalty = new Map();
  for (let i = 1; i < a.length; i++) { penalty.set(a[i - 1] + '|' + a[i], 6); penalty.set(a[i] + '|' + a[i - 1], 6); }
  const bIds = shortest(graph, s.id, e.id, penalty);
  const options = [a, bIds].filter(Boolean).map(ids => {
    const line = lineOf(graph, ids);
    return { line, length: Math.round(lengthOf(line)), side: sideOf(line, start, end) };
  });
  // Tweede optie weglaten als hij bijna gelijk is aan de eerste
  if (options.length === 2) {
    const setA = new Set(a);
    const overlap = bIds.filter(id => setA.has(id)).length / bIds.length;
    if (overlap > 0.8 || options[0].side === options[1].side && overlap > 0.5) options.pop();
  }
  return { ok: true, options, pois: graph.pois.length };
}

// Verdeel `count` punten gelijkmatig langs de lijn, liefst bij een leuke plek in de buurt.
function placePoints(state, line, count) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + distance({ lat: line[i - 1][0], lng: line[i - 1][1] }, { lat: line[i][0], lng: line[i][1] }));
  const total = cum[cum.length - 1];
  const spacing = total / (count + 1);
  const pois = (cache ? cache.pois : []).map(p => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = distance(p, { lat: line[i][0], lng: line[i][1] });
      if (d < bd) { bd = d; bi = i; }
    }
    return { ...p, off: bd, at: cum[bi] };
  }).filter(p => p.off <= 120);
  const used = new Set();
  const out = [];
  for (let k = 1; k <= count; k++) {
    const target = spacing * k;
    let best = null, bestScore = -Infinity;
    pois.forEach((p, i) => {
      if (used.has(i) || Math.abs(p.at - target) > spacing * 0.35) return;
      const score = p.kind.score - p.off / 60 - Math.abs(p.at - target) / spacing;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best != null) {
      used.add(best);
      const p = pois[best];
      out.push({ name: p.name, lat: p.lat, lng: p.lng, intro: p.kind.intro, poi: true });
    } else {
      const i = cum.findIndex(c => c >= target);
      out.push({ name: `Punt onderweg ${k}`, lat: line[i][0], lng: line[i][1], intro: 'Volg het pad.', poi: false });
    }
  }
  return { points: out, total: Math.round(total) };
}

module.exports = { preview, placePoints, lengthOf };
