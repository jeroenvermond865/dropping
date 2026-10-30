(() => {
  const $ = id => document.getElementById(id);
  const esc = App.esc;
  let data = null, map, layers = {}, fitted = false, replay = null, photoIdx = 0;

  function start() {
    const token = App.store.get('adminToken');
    if (!token) { $('login').style.display = 'flex'; return; }
    const dropping = new URLSearchParams(location.search).get('d') || App.store.get('adminDropping') || '';
    const socket = io({ auth: { token, tv: true, dropping } });
    socket.on('connect_error', () => {});
    socket.on('tv', d => { data = d; render(); });
    socket.on('pos', p => {
      const t = data && data.teams.find(x => x.id === p.teamId);
      if (!t) return;
      t.pos = { lat: p.lat, lng: p.lng, ts: p.ts };
      const last = t.trail[t.trail.length - 1];
      if (!last || p.ts - last[2] > 20000) t.trail.push([p.lat, p.lng, p.ts]);
      if (!replay) drawTeams();
    });
    socket.on('connect', () => { $('live').style.color = 'var(--good)'; });
    socket.on('disconnect', () => { $('live').style.color = 'var(--bad)'; });
    // Een tv-socket krijgt niets als de pincode niet (meer) klopt.
    setTimeout(() => { if (!data) { App.store.set('adminToken', null); location.reload(); } }, 8000);
    $('tv').style.display = 'grid';
    map = L.map('map', { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, keyboard: false, zoomSnap: 0.25 });
    App.tileLayers()['Nacht'].addTo(map);
    for (const k of ['zones', 'paths', 'points', 'treasures', 'trails', 'teams']) layers[k] = L.layerGroup().addTo(map);
    map.setView([52.06, 5.665], 14);
  }

  $('adminGo').onclick = async () => {
    try {
      const { token } = await App.api('/api/admin/login', { pin: $('adminPin').value });
      App.store.set('adminToken', token);
      location.reload();
    } catch (e) { App.toast(e.message, 'bad'); }
  };

  function render() {
    $('title').textContent = data.title;
    layers.zones.clearLayers();
    for (const z of data.zones) L.polygon(z.polygon, { color: '#ff5470', weight: 2, fillOpacity: 0.18, dashArray: '6 6' }).addTo(layers.zones);
    layers.paths.clearLayers();
    for (const p of data.paths) L.polyline(p.line, { color: '#ffc44d', weight: 3, opacity: 0.35 }).addTo(layers.paths);
    layers.points.clearLayers();
    data.points.forEach((p, i) => {
      const last = i === data.points.length - 1;
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="pin-marker" style="background:${last ? '#3ee08f' : '#b06bff'}"><span>${last ? '🏁' : i + 1}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34] }) }).addTo(layers.points);
    });
    layers.treasures.clearLayers();
    for (const t of data.treasures) {
      L.marker([t.lat, t.lng], { icon: L.divIcon({ className: '', html: `<div class="treasure-marker ${t.found ? 'claimed' : ''}">💎</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(layers.treasures);
    }
    if (!fitted) {
      const all = overviewBounds();
      if (all) { map.fitBounds(all, safePad()); fitted = true; }
    }
    if (!replay) drawTeams();
    renderBoard();
    renderEvents();
  }

  function drawTeams(untilTs) {
    layers.trails.clearLayers();
    layers.teams.clearLayers();
    for (const t of data.teams) {
      const trail = untilTs ? t.trail.filter(p => p[2] <= untilTs) : t.trail;
      if (trail.length > 1) {
        const line = trail.map(p => [p[0], p[1]]);
        L.polyline(line, { color: t.color, weight: 9, opacity: 0.18 }).addTo(layers.trails);
        L.polyline(line, { color: t.color, weight: 3, opacity: 0.9 }).addTo(layers.trails);
      }
      const at = untilTs ? trail[trail.length - 1] : (t.pos ? [t.pos.lat, t.pos.lng] : trail[trail.length - 1]);
      if (!at) continue;
      L.marker([at[0], at[1]], { icon: L.divIcon({ className: '', html: `<div class="tv-team" style="background:${esc(t.color)}"></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000 })
        .bindTooltip(esc(t.name), { permanent: true, direction: 'top', offset: [0, -14], className: 'tv-label' }).addTo(layers.teams);
    }
  }

  function overviewBounds() {
    const all = [...data.points.map(p => [p.lat, p.lng]), ...data.paths.flatMap(p => p.line),
      ...data.teams.filter(t => t.pos).map(t => [t.pos.lat, t.pos.lng])];
    return all.length ? L.latLngBounds(all).pad(0.05) : null;
  }

  // ---- camera: draait langzaam in 3D rond de kaart ----
  const tilt = document.querySelector('.tv-tilt');
  (function orbit(now) {
    const s = now / 1000;
    const x = 40 + 7 * Math.sin(s / 13);    // kantelen: meer of minder van bovenaf
    const z = 22 * Math.sin(s / 37);        // rond de kaart draaien
    tilt.style.transform = `rotateX(${x.toFixed(2)}deg) rotateZ(${z.toFixed(2)}deg)`;
    requestAnimationFrame(orbit);
  })(performance.now());

  // ---- regie: om de beurt het overzicht en elk team van dichtbij, met in- en uitzoomen ----
  // Door de 3D-kanteling is niet de hele kaart zichtbaar. Teams moeten in het middenstuk
  // rond het draaipunt van de kanteling blijven (ongeveer 65% van boven).
  const SAFE = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.2 };
  function safePad() {
    const s = map.getSize();
    return { paddingTopLeft: [s.x * SAFE.left, s.y * SAFE.top], paddingBottomRight: [s.x * SAFE.right, s.y * SAFE.bottom] };
  }
  // Kaartmidden zo kiezen dat dit punt op het draaipunt staat in plaats van in het midden
  function focusCenter(ll, zoom) {
    const s = map.getSize();
    return map.unproject(map.project(ll, zoom).subtract([0, s.y * 0.15]), zoom);
  }
  function inView(ll) {
    const s = map.getSize(), p = map.latLngToContainerPoint(ll);
    return p.x > s.x * 0.22 && p.x < s.x * 0.78 && p.y > s.y * 0.4 && p.y < s.y * 0.86;
  }
  const liveTeams = () => data ? data.teams.filter(t => t.pos && Date.now() - t.pos.ts < 15 * 60000) : [];
  let cam = { type: 'overzicht' }, flying = false, zoomOutTimer;
  watchFlying();
  function watchFlying() {
    if (!map) return setTimeout(watchFlying, 500);
    map.on('movestart', () => { flying = true; });
    map.on('moveend', () => { flying = false; });
  }
  function overview(duration) {
    const b = overviewBounds();
    if (b) map.flyToBounds(b, { ...safePad(), duration });
  }
  // Inzoomen op één team, maar nooit zo ver dat de andere teams uit beeld raken
  function focusTeam(t, zoom, duration) {
    const c = L.latLng(t.pos.lat, t.pos.lng);
    const others = liveTeams().filter(x => x.id !== t.id).map(x => L.latLng(x.pos.lat, x.pos.lng));
    if (others.length) {
      // spiegelen rond het team, zodat het team in het midden blijft
      const pts = [c, ...others, ...others.map(o => L.latLng(2 * c.lat - o.lat, 2 * c.lng - o.lng))];
      const s = map.getSize();
      zoom = Math.min(zoom, map.getBoundsZoom(L.latLngBounds(pts), false, L.point(s.x * 0.5, s.y * 0.6)));
    }
    map.flyTo(focusCenter(c, zoom), zoom, { duration });
  }

  let shot = 0;
  function nextShot() {
    if (!data || !map) return;
    clearTimeout(zoomOutTimer);
    if (replay) { cam = { type: 'overzicht' }; return overview(3); }
    const live = liveTeams();
    const shots = ['overzicht', ...live.map(t => t.id)];
    const pick = shots[shot++ % shots.length];
    const t = live.find(x => x.id === pick);
    if (!t) {
      cam = { type: 'overzicht' };
      $('camLabel').textContent = '🎥 Overzicht';
      return overview(4);
    }
    cam = { type: 'team', id: t.id, zoom: 17 };
    $('camLabel').textContent = '🎥 ' + t.name;
    focusTeam(t, 17, 4);
    // halverwege rustig een stukje uitzoomen, nog steeds op het team
    zoomOutTimer = setTimeout(() => { if (!replay && t.pos) { cam.zoom = 15.5; focusTeam(t, 15.5, 5); } }, 7000);
  }
  setInterval(nextShot, 14000);
  setTimeout(nextShot, 3000);

  // Bewaker: loopt een team uit beeld, dan stuurt de camera meteen bij
  setInterval(() => {
    if (!data || !map || flying) return;
    if (cam.type === 'team') {
      const t = liveTeams().find(x => x.id === cam.id);
      if (t && liveTeams().some(x => !inView([x.pos.lat, x.pos.lng]))) focusTeam(t, cam.zoom || map.getZoom(), 1.5);
    } else if (liveTeams().some(t => !inView([t.pos.lat, t.pos.lng]))) overview(2);
  }, 2000);

  const prevRank = {};
  function renderBoard() {
    $('board').innerHTML = data.scoreboard.map(r => {
      const up = prevRank[r.id] && prevRank[r.id] > r.rank;
      return `<div class="tv-row ${up ? 'flash' : ''}" style="border-left:5px solid ${esc(r.color)}">
        <div class="rank">${['🥇', '🥈', '🥉'][r.rank - 1] || r.rank}</div>
        <div class="grow"><b style="font-size:1.15rem">${esc(r.name)}</b>${r.finishedAt ? ' 🏁' : ''}
          <div class="bar"><div style="width:${r.total ? (r.done / r.total) * 100 : 0}%;background:${esc(r.color)}"></div></div>
          <div class="muted" style="font-size:.8rem">${r.done}/${r.total} punten · ✅ ${r.solved} · 🥇 ${r.firsts} · 💎 ${r.treasures}</div></div>
        <div class="sc">${r.score}</div></div>`;
    }).join('') || '<p class="muted">Nog geen teams</p>';
    data.scoreboard.forEach(r => { prevRank[r.id] = r.rank; });
  }

  function renderEvents() {
    const time = ts => new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    $('events').innerHTML = data.events.map(e => `<div><span class="muted">${time(e.ts)}</span> ${esc(e.text)}</div>`).join('') || '<div class="muted">Wachten op de eerste teams…</div>';
  }

  // Fotocarrousel
  setInterval(() => {
    if (!data || !data.photos.length) { $('photo').style.display = 'none'; return; }
    const p = data.photos[photoIdx++ % data.photos.length];
    const team = data.teams.find(t => t.id === p.teamId);
    $('photo').style.display = 'block';
    const img = $('photoImg');
    img.style.animation = 'none'; void img.offsetWidth; img.style.animation = '';
    img.src = '/foto/' + p.id;
    $('photoCap').textContent = `📸 ${team ? team.name : ''} · ${p.pointName}`;
  }, 7000);

  // Replay: alle routes in 40 seconden opnieuw afspelen
  $('replayBtn').onclick = () => {
    if (replay) return stopReplay();
    const times = data.teams.flatMap(t => t.trail.map(p => p[2]));
    if (times.length < 2) return App.toast('Nog geen routes om af te spelen');
    const t0 = Math.min(...times), t1 = Math.max(...times), dur = 40000, started = performance.now();
    $('replayBtn').textContent = '■ Stop replay';
    $('replayClock').style.display = '';
    replay = true;
    (function frame(now) {
      if (!replay) return;
      const f = Math.min(1, (now - started) / dur);
      const ts = t0 + (t1 - t0) * f;
      drawTeams(ts);
      $('replayClock').textContent = '🕘 ' + new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
      if (f < 1) requestAnimationFrame(frame); else setTimeout(stopReplay, 4000);
    })(started);
  };
  function stopReplay() {
    replay = null;
    $('replayBtn').textContent = '▶ Replay van de routes';
    $('replayClock').style.display = 'none';
    drawTeams();
  }

  // Volledig scherm aan/uit (Esc werkt ook)
  $('fsBtn').onclick = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement);
  };
  const fsLabel = () => { $('fsBtn').textContent = document.fullscreenElement || document.webkitFullscreenElement ? '✕ Volledig scherm uit' : '⛶ Volledig scherm'; };
  document.addEventListener('fullscreenchange', fsLabel);
  document.addEventListener('webkitfullscreenchange', fsLabel);

  start();
})();
