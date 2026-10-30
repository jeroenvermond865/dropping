// Tijdelijk: schrijft de routes en leuke plekken in de buurt naar het logboek,
// zodat er punten langs de route bedacht kunnen worden. Leest alleen, wijzigt niets.
const { distance } = require('./game');

const r5 = x => Math.round(x * 1e5) / 1e5;

function log(tag, obj) {
  const s = JSON.stringify(obj);
  for (let i = 0, n = 0; i < s.length; i += 3000, n++) console.log(`[inspect] ${tag} #${n} ${s.slice(i, i + 3000)}`);
}

async function overpass(b) {
  const box = `${b.s},${b.w},${b.n},${b.e}`;
  const q = `[out:json][timeout:90];
(
  node["tourism"](${box});
  node["amenity"~"^(bench|shelter|place_of_worship|waste_basket|drinking_water|post_box|bbq|parking|restaurant|cafe|pub)$"](${box});
  node["historic"](${box});
  node["man_made"](${box});
  node["leisure"](${box});
  node["natural"~"^(tree|peak|spring)$"](${box});
  node["highway"~"^(street_lamp|crossing|stop)$"]["name"](${box});
  node["barrier"~"^(gate|stile|kissing_gate)$"](${box});
  way["bridge"="yes"](${box});
  way["leisure"~"^(playground|park|pitch)$"](${box});
  way["natural"="water"](${box});
  way["waterway"](${box});
);
out center tags qt;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'dropping-familieweekend/1.0' },
    body: 'data=' + encodeURIComponent(q),
    signal: AbortSignal.timeout(100000),
  });
  if (!r.ok) throw new Error('Overpass ' + r.status);
  return r.json();
}

module.exports = async function inspect(db) {
  try {
    for (const d of db.droppings) {
      log('dropping', {
        id: d.id, title: d.settings.title, active: d.active, settings: d.settings,
        points: d.points.map(p => ({ name: p.name, lat: p.lat, lng: p.lng, type: p.type })),
        teams: d.teams.map(t => t.name), zones: d.zones.map(z => ({ name: z.name, polygon: z.polygon.map(c => [r5(c[0]), r5(c[1])]) })),
        treasures: d.treasures.length,
        paths: d.paths.map(p => ({ id: p.id, name: p.name, n: p.line.length })),
      });
      for (const p of d.paths) {
        log('path ' + d.id + ' ' + p.id, p.line.map(c => [r5(c[0]), r5(c[1])]));
        const lats = p.line.map(c => c[0]), lngs = p.line.map(c => c[1]);
        const b = { s: Math.min(...lats) - 0.002, n: Math.max(...lats) + 0.002, w: Math.min(...lngs) - 0.003, e: Math.max(...lngs) + 0.003 };
        try {
          const osm = await overpass(b);
          const near = [];
          for (const el of osm.elements || []) {
            const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
            if (lat == null) continue;
            let off = Infinity;
            for (const c of p.line) off = Math.min(off, distance({ lat, lng }, { lat: c[0], lng: c[1] }));
            if (off > 80) continue;
            const t = el.tags || {};
            const kind = ['tourism', 'amenity', 'historic', 'man_made', 'leisure', 'natural', 'highway', 'barrier', 'bridge', 'waterway']
              .filter(k => t[k]).map(k => k + '=' + t[k]).join(',');
            near.push([r5(lat), r5(lng), Math.round(off), kind, t.name || '', t.inscription || t.description || '']);
          }
          log('pois ' + d.id + ' ' + p.id, near);
        } catch (e) {
          console.log('[inspect] overpass mislukt', e.message);
        }
      }
    }
    console.log('[inspect] klaar');
  } catch (e) {
    console.log('[inspect] fout', e.message);
  }
};
