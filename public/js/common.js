// Gedeelde hulpfuncties voor alle pagina's.
const App = (() => {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  async function api(path, body, tokenKey = 'teamToken', method) {
    const token = store.get(tokenKey);
    const res = await fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Er ging iets mis'), { status: res.status });
    return data;
  }

  let toastTimer;
  function toast(msg, kind = '') {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.className = 'show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = kind; }, 3200);
  }

  function distance(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearing(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  // Ligt punt [lat,lng] binnen een polygoon van [lat,lng]-hoeken?
  function inPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < ((xj - xi) * (pt[0] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function fmtDist(m) {
    if (m == null || isNaN(m)) return '–';
    return m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m';
  }

  function fmtTime(ms) {
    if (ms == null) return '–';
    const s = Math.round(ms / 1000);
    return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function tileLayers() {
    return {
      'Nacht': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 20, attribution: '&copy; OpenStreetMap, &copy; CARTO' }),
      'Kaart': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap' }),
      'Satelliet': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19, attribution: '&copy; Esri' }),
    };
  }

  function confetti() {
    const c = document.getElementById('confetti') || Object.assign(document.createElement('canvas'), { id: 'confetti' });
    if (!c.parentNode) document.body.appendChild(c);
    const ctx = c.getContext('2d');
    c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const colors = ['#4dd2ff', '#b06bff', '#3ee08f', '#ffc44d', '#ff7a3d', '#fff'];
    const parts = Array.from({ length: 140 }, () => ({
      x: innerWidth / 2, y: innerHeight * .55, vx: (Math.random() - .5) * 14, vy: -Math.random() * 16 - 4,
      r: Math.random() * 6 + 3, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 6, va: (Math.random() - .5) * .4,
    }));
    let frames = 0;
    (function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += .45; p.x += p.vx; p.y += p.vy; p.a += p.va; p.vx *= .99;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
      }
      if (++frames < 150) requestAnimationFrame(tick); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })();
  }

  function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} }

  return { store, api, toast, distance, bearing, inPolygon, fmtDist, fmtTime, esc, tileLayers, confetti, buzz };
})();
