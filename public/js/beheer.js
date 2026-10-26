(() => {
  const $ = id => document.getElementById(id);
  const esc = App.esc;
  const api = (path, body, method) => App.api(path, body, 'adminToken', method);
  const TYPES = { checkin: 'Alleen inchecken', vraag: 'Open vraag', keuze: 'Meerkeuze', opdracht: 'Opdracht (gedaan-knop)', foto: 'Foto-opdracht' };

  let state = null, tab = 'punten', selected = null, mode = null, draft = [], map, socket;
  const layers = {};

  const isTyping = () => { const a = document.activeElement; return a && $('tab').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };

  // ---- inloggen ----
  async function start() {
    try { state = await api('/api/admin/state'); }
    catch {
      App.store.set('adminToken', null);
      $('login').style.display = 'flex';
      $('adminPin').focus();
      return;
    }
    $('login').style.display = 'none';
    $('admin').style.display = 'grid';
    initMap();
    socket = io({ auth: { token: App.store.get('adminToken') } });
    socket.on('admin', s => { state = s; draw(); if (!(tab === 'punten' && selected) && !isTyping()) renderTab(); });
    socket.on('pos', ({ teamId, lat, lng, ts }) => {
      const pr = state.progress[teamId] || (state.progress[teamId] = { results: {} });
      pr.pos = { lat, lng, ts };
      drawTeams();
    });
    draw();
    renderTab();
  }
  $('adminGo').onclick = async () => {
    try {
      const { token } = await App.api('/api/admin/login', { pin: $('adminPin').value });
      App.store.set('adminToken', token);
      start();
    } catch (e) { App.toast(e.message, 'bad'); }
  };
  $('adminPin').onkeydown = e => { if (e.key === 'Enter') $('adminGo').click(); };
  $('logout').onclick = () => { App.store.set('adminToken', null); location.reload(); };

  // ---- kaart ----
  function initMap() {
    map = L.map('map').setView([52.06, 5.665], 14);
    const tiles = App.tileLayers();
    tiles['Kaart'].addTo(map);
    L.control.layers(tiles, null, { position: 'topright' }).addTo(map);
    layers.zones = L.layerGroup().addTo(map);
    layers.points = L.layerGroup().addTo(map);
    layers.teams = L.layerGroup().addTo(map);
    layers.draft = L.layerGroup().addTo(map);
    layers.paths = L.layerGroup().addTo(map);
    layers.treasures = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
    if (state.points.length) map.fitBounds(L.latLngBounds(state.points.map(p => [p.lat, p.lng])).pad(0.2));
    setTimeout(() => map.invalidateSize(), 100);
  }

  function setMode(m, text) {
    mode = m;
    $('banner').style.display = m ? 'block' : 'none';
    $('banner').innerHTML = text || '';
    map.getContainer().style.cursor = m ? 'crosshair' : '';
  }

  async function onMapClick(e) {
    if (mode === 'point') {
      setMode(null);
      try {
        const p = await api('/api/admin/point', { lat: e.latlng.lat, lng: e.latlng.lng, name: `Punt ${state.points.length + 1}`, type: 'vraag' });
        selected = p.id;
        state.points.push(p);
        tab = 'punten';
        renderTab();
        draw();
      } catch (err) { App.toast(err.message, 'bad'); }
    } else if (mode === 'treasure') {
      setMode(null);
      try {
        await api('/api/admin/treasure', { lat: e.latlng.lat, lng: e.latlng.lng, name: `Schat ${state.treasures.length + 1}`, points: 50 });
        App.toast('💎 Schat geplaatst', 'good');
      } catch (err) { App.toast(err.message, 'bad'); }
    } else if (mode === 'zone' || mode === 'path') {
      draft.push([e.latlng.lat, e.latlng.lng]);
      drawDraft();
    }
  }

  function draw() {
    $('title').textContent = state.settings.title;
    layers.zones.clearLayers();
    for (const z of state.zones) {
      L.polygon(z.polygon, { color: '#ff5470', weight: 2, fillOpacity: 0.2, dashArray: '6 6' })
        .bindTooltip(esc(z.name) + ' · tik om de vorm aan te passen')
        .on('click', () => { if (!mode) { tab = 'zones'; renderTab(); editZoneShape(z); } })
        .addTo(layers.zones);
    }
    layers.points.clearLayers();
    const pts = state.points;
    if (pts.length > 1) L.polyline(pts.map(p => [p.lat, p.lng]), { color: '#b06bff', weight: 3, opacity: 0.7, dashArray: '8 8' }).addTo(layers.points);
    pts.forEach((p, i) => {
      const finish = state.settings.lastIsFinish && i === pts.length - 1 && pts.length > 2;
      const color = p.id === selected ? '#4dd2ff' : finish ? '#3ee08f' : '#b06bff';
      L.circle([p.lat, p.lng], { radius: p.radius || state.settings.radius, color, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(layers.points);
      const m = L.marker([p.lat, p.lng], {
        draggable: true,
        icon: L.divIcon({ className: '', html: `<div class="pin-marker" style="background:${color}"><span>${finish ? '🏁' : i + 1}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34] }),
      }).addTo(layers.points);
      m.bindTooltip(esc(p.name));
      m.on('click', () => { selected = p.id; tab = 'punten'; renderTab(); draw(); });
      m.on('dragend', async () => {
        const ll = m.getLatLng();
        try { await api('/api/admin/point', { ...p, lat: ll.lat, lng: ll.lng }); App.toast('Punt verplaatst', 'good'); }
        catch (e) { App.toast(e.message, 'bad'); draw(); }
      });
    });
    layers.paths.clearLayers();
    for (const r of state.paths) {
      const bad = lineCrossesZone(r.line);
      L.polyline(r.line, { color: bad ? '#ff5470' : '#ffc44d', weight: 4, opacity: 0.85 }).bindTooltip(esc(r.name) + (bad ? ' ⚠️ door verboden gebied!' : '')).addTo(layers.paths);
    }
    layers.treasures.clearLayers();
    for (const t of state.treasures) {
      const found = Object.keys(t.claims || {}).length;
      const m = L.marker([t.lat, t.lng], {
        draggable: true,
        icon: L.divIcon({ className: '', html: `<div class="treasure-marker ${found ? 'claimed' : ''}">💎</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      }).bindTooltip(`${esc(t.name)} · ${t.points} pt · ${found}× gevonden`).addTo(layers.treasures);
      m.on('dragend', async () => {
        const ll = m.getLatLng();
        try { await api('/api/admin/treasure', { ...t, lat: ll.lat, lng: ll.lng }); }
        catch (e) { App.toast(e.message, 'bad'); draw(); }
      });
    }
    drawTeams();
  }

  // ---- verboden gebied controleren ----
  function segCross(p1, p2, q1, q2) {
    const o = (a, b, c) => Math.sign((b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]));
    return o(p1, p2, q1) !== o(p1, p2, q2) && o(q1, q2, p1) !== o(q1, q2, p2);
  }
  function segmentHitsZone(a, b) {
    return state.zones.some(z => App.inPolygon(a, z.polygon) || App.inPolygon(b, z.polygon) ||
      z.polygon.some((c, i) => segCross(a, b, c, z.polygon[(i + 1) % z.polygon.length])));
  }
  function lineCrossesZone(line) {
    for (let i = 1; i < line.length; i++) if (segmentHitsZone(line[i - 1], line[i])) return true;
    return false;
  }

  function drawTeams() {
    layers.teams.clearLayers();
    for (const t of state.teams) {
      const pos = state.progress[t.id]?.pos;
      if (!pos) continue;
      const ago = Math.round((Date.now() - pos.ts) / 60000);
      L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({ className: '', html: `<div class="team-marker" style="background:${esc(t.color)}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: 1000,
      }).bindTooltip(`${esc(t.name)} · ${ago} min geleden`, { permanent: true, direction: 'right' }).addTo(layers.teams);
    }
  }

  function drawDraft() {
    layers.draft.clearLayers();
    if (draft.length) L.polyline(mode === 'path' ? draft : [...draft, draft[0]], { color: mode === 'path' && lineCrossesZone(draft) ? '#ff5470' : '#ffc44d', weight: 3, dashArray: '4 6' }).addTo(layers.draft);
    draft.forEach(c => L.circleMarker(c, { radius: 5, color: '#ffc44d' }).addTo(layers.draft));
  }

  // ---- tabbladen ----
  $('tabs').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    tab = b.dataset.tab;
    selected = null;
    setMode(null);
    renderTab();
    draw();
  };

  function renderTab() {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    ({ punten: renderPoints, teams: renderTeams, zones: renderZones, route: renderPaths, schatten: renderTreasures, fotos: renderPhotos, live: renderLive, instellingen: renderSettings })[tab]();
    const pending = state.photos.filter(p => p.status === 'wacht').length;
    document.querySelector('[data-tab=fotos]').textContent = pending ? `📸 Foto's (${pending})` : "📸 Foto's";
  }

  // Punten
  function renderPoints() {
    const el = $('tab');
    const p = state.points.find(x => x.id === selected);
    if (p) return renderPointForm(p);
    el.innerHTML = `
      <button class="btn block" id="addPoint">➕ Punt op de kaart zetten</button>
      ${legWarnings()}
      <p class="muted" style="font-size:.85em">De volgorde hieronder is de route. ${state.settings.lastIsFinish ? 'Het laatste punt is de finish.' : ''} Sleep een pin op de kaart om hem te verplaatsen.</p>
      <div id="plist">${state.points.map((x, i) => `
        <div class="list-item" data-id="${x.id}">
          <div class="num">${i + 1}</div>
          <div class="grow"><b>${esc(x.name)}</b><div class="muted" style="font-size:.8em">${TYPES[x.type]}${x.kompas ? ' · 🧭' : ''}${x.letter ? ' · letter ' + esc(x.letter) : ''} · ${x.points} pt</div></div>
          <button class="btn ghost small" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn ghost small" data-down="${i}" ${i === state.points.length - 1 ? 'disabled' : ''}>↓</button>
        </div>`).join('') || '<p class="muted">Nog geen punten.</p>'}</div>`;
    $('addPoint').onclick = () => setMode('point', 'Tik op de kaart waar het punt moet komen');
    el.querySelectorAll('.list-item').forEach(li => {
      li.onclick = e => {
        if (e.target.closest('button')) return;
        selected = li.dataset.id;
        const q = state.points.find(x => x.id === selected);
        map.setView([q.lat, q.lng], Math.max(map.getZoom(), 16));
        renderTab();
        draw();
      };
    });
    el.querySelectorAll('[data-up],[data-down]').forEach(b => {
      b.onclick = async () => {
        const ids = state.points.map(x => x.id);
        const i = Number(b.dataset.up ?? b.dataset.down), j = b.dataset.up != null ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        try { await api('/api/admin/order', { ids }); } catch (e) { App.toast(e.message, 'bad'); }
      };
    });
  }

  function legWarnings() {
    const pts = state.points, legs = [];
    for (let i = 1; i < pts.length; i++) {
      if (segmentHitsZone([pts[i - 1].lat, pts[i - 1].lng], [pts[i].lat, pts[i].lng])) legs.push(`${i} → ${i + 1}`);
    }
    if (!legs.length) return '';
    return `<div class="card" style="padding:12px;border-color:var(--warn);background:rgba(255,196,77,.1);font-size:.9em">
      ⚠️ De rechte lijn tussen punt ${legs.join(', ')} gaat door het verboden gebied. Teams lopen hier waarschijnlijk dwars door het bos.
      Zet er een tussenpunt buiten het bos bij, of teken onder 🛤️ Route de echte looproute en zet "route tonen" aan.</div>`;
  }

  // Looproutes (de echte weg om het bos heen)
  function renderPaths() {
    const el = $('tab');
    el.innerHTML = `<p class="muted" style="font-size:.85em">Teken de wegen die de teams moeten lopen, om het bos heen. Schatten worden langs deze route verstopt. Een route die door een verboden zone gaat wordt rood.</p>
      ${state.paths.map(r => `<div class="list-item" data-path="${r.id}"><div class="grow"><b>${esc(r.name)}</b>
        <div class="muted" style="font-size:.8em">${r.line.length} punten · ${App.fmtDist(lineLength(r.line))}${lineCrossesZone(r.line) ? ' · <span style="color:var(--bad)">⚠️ door verboden gebied</span>' : ' · ✅ buiten het bos'}</div></div>
        <button class="btn danger small">Verwijderen</button></div>`).join('')}
      <button class="btn block" id="addPath">✏️ Looproute tekenen</button>
      <label style="display:flex;gap:8px;color:var(--text);margin-top:12px"><input type="checkbox" id="showPath" ${state.settings.showPath ? 'checked' : ''}> Route ook aan de teams laten zien</label>`;
    el.querySelectorAll('[data-path]').forEach(li => {
      li.querySelector('button').onclick = async () => { if (confirm('Route verwijderen?')) await api('/api/admin/path/' + li.dataset.path, null, 'DELETE'); };
      li.onclick = e => { if (!e.target.closest('button')) map.fitBounds(state.paths.find(r => r.id === li.dataset.path).line); };
    });
    $('showPath').onchange = e => api('/api/admin/settings', { showPath: e.target.checked });
    $('addPath').onclick = () => {
      draft = [];
      drawDraft();
      setMode('path', 'Tik langs de weg, bocht voor bocht · <button class="btn small" id="pathUndo">↶</button> <button class="btn small" id="pathDone">Klaar</button> <button class="btn ghost small" id="pathCancel">Stop</button>');
      $('pathUndo').onclick = e => { e.stopPropagation(); draft.pop(); drawDraft(); };
      $('pathDone').onclick = async e => {
        e.stopPropagation();
        if (draft.length < 2) return App.toast('Minstens 2 punten nodig', 'bad');
        if (lineCrossesZone(draft) && !confirm('Deze route gaat door een verboden gebied. Toch opslaan?')) return;
        const name = prompt('Naam van de route', 'Route linksom');
        if (name === null) return;
        try { await api('/api/admin/path', { name, line: draft }); } catch (err) { App.toast(err.message, 'bad'); }
        draft = []; drawDraft(); setMode(null);
      };
      $('pathCancel').onclick = e => { e.stopPropagation(); draft = []; drawDraft(); setMode(null); };
    };
  }

  function lineLength(line) {
    let m = 0;
    for (let i = 1; i < line.length; i++) m += App.distance({ lat: line[i - 1][0], lng: line[i - 1][1] }, { lat: line[i][0], lng: line[i][1] });
    return m;
  }

  // Verborgen schatten
  function renderTreasures() {
    const el = $('tab');
    el.innerHTML = `<p class="muted" style="font-size:.85em">Schatten zijn onzichtbaar tot een team er binnen ${state.settings.treasureReveal} m langs loopt. Wie hem als eerste pakt krijgt alle punten, latere teams de helft. In het bos kun je geen schat leggen.</p>
      <div class="card stack" style="padding:14px">
        <b>Automatisch langs de looproute</b>
        <div class="grid2"><div><label>Aantal</label><input id="scCount" type="number" value="5" min="1" max="30"></div>
        <div><label>Punten per schat</label><input id="scPts" type="number" value="50" min="0"></div></div>
        <button class="btn" id="scatter" ${state.paths.length ? '' : 'disabled'}>💎 Verstop langs de route</button>
        ${state.paths.length ? '' : '<div class="muted" style="font-size:.8em">Teken eerst een looproute onder 🛤️ Route.</div>'}
      </div>
      <button class="btn ghost block" id="addTreasure" style="margin:12px 0">➕ Zelf een schat op de kaart zetten</button>
      ${state.treasures.map(t => `<div class="list-item" data-tr="${t.id}">
        <div style="font-size:1.4em">💎</div>
        <div class="grow"><input data-f="name" value="${esc(t.name)}" style="padding:.4em .6em"><div class="muted" style="font-size:.8em;margin-top:4px">${Object.keys(t.claims || {}).length}× gevonden</div></div>
        <input data-f="points" type="number" value="${t.points}" style="width:70px;padding:.4em">
        <button class="btn small" data-save>✓</button><button class="btn danger small" data-del>✕</button></div>`).join('')}`;
    $('addTreasure').onclick = () => setMode('treasure', 'Tik op de kaart waar de schat moet liggen');
    $('scatter').onclick = async () => {
      try {
        const r = await api('/api/admin/scatter', { count: Number($('scCount').value), points: Number($('scPts').value) });
        App.toast(`💎 ${r.made} schatten verstopt. Sleep ze eventueel precies op de weg.`, 'good');
      } catch (e) { App.toast(e.message, 'bad'); }
    };
    el.querySelectorAll('[data-tr]').forEach(li => {
      const t = state.treasures.find(x => x.id === li.dataset.tr);
      li.onclick = e => { if (!e.target.closest('button,input')) map.setView([t.lat, t.lng], 17); };
      li.querySelector('[data-save]').onclick = async () => {
        try { await api('/api/admin/treasure', { ...t, name: li.querySelector('[data-f=name]').value, points: Number(li.querySelector('[data-f=points]').value) }); App.toast('Opgeslagen', 'good'); }
        catch (e) { App.toast(e.message, 'bad'); }
      };
      li.querySelector('[data-del]').onclick = async () => { if (confirm('Schat verwijderen?')) await api('/api/admin/treasure/' + t.id, null, 'DELETE'); };
    });
  }

  // Foto's beoordelen
  function renderPhotos() {
    const el = $('tab');
    const name = id => esc((state.teams.find(t => t.id === id) || {}).name || '?');
    const label = { wacht: '⏳ wacht', goed: '✅ goed', afgekeurd: '❌ afgekeurd' };
    el.innerHTML = `<p class="muted" style="font-size:.85em">Goedgekeurde foto's komen in het <a href="/album" target="_blank">album</a> en op het tv-scherm.</p>
      ${[...state.photos].sort((a, b) => (a.status === 'wacht' ? 0 : 1) - (b.status === 'wacht' ? 0 : 1)).map(p => `
        <div class="card" style="padding:10px;margin-bottom:10px">
          <a href="/foto/${p.id}" target="_blank"><img src="/foto/${p.id}" loading="lazy" style="width:100%;border-radius:10px;display:block;max-height:260px;object-fit:cover"></a>
          <div class="row" style="margin-top:8px"><div class="grow"><b>${name(p.teamId)}</b> · ${esc(p.pointName)}<div class="muted" style="font-size:.8em">${label[p.status]}</div></div>
          ${p.status !== 'goed' ? `<button class="btn small" data-ok="${p.id}">Goed</button>` : ''}
          ${p.status !== 'afgekeurd' ? `<button class="btn danger small" data-no="${p.id}">Af</button>` : ''}</div>
        </div>`).join('') || '<p class="muted">Nog geen foto\'s.</p>'}`;
    el.querySelectorAll('[data-ok],[data-no]').forEach(b => {
      b.onclick = () => api('/api/admin/photo/' + (b.dataset.ok || b.dataset.no), { approve: !!b.dataset.ok }).catch(e => App.toast(e.message, 'bad'));
    });
  }

  function renderPointForm(p) {
    const el = $('tab');
    el.innerHTML = `
      <button class="btn ghost small" id="back">← Alle punten</button>
      <div class="stack" style="margin-top:12px">
        <div><label>Naam</label><input id="f_name" value="${esc(p.name)}"></div>
        <div><label>Soort</label><select id="f_type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><label>Aanwijzing bij onthullen (zien ze onderweg)</label><textarea id="f_intro">${esc(p.intro)}</textarea></div>
        <div data-show="vraag keuze opdracht foto"><label>Vraag of opdracht (zien ze pas bij het punt)</label><textarea id="f_question">${esc(p.question)}</textarea></div>
        <div data-show="vraag"><label>Goede antwoorden, scheiden met | (leeg = elk antwoord goed)</label><input id="f_answers" value="${esc(p.answers)}" placeholder="bijv. 12|twaalf"></div>
        <div data-show="keuze"><label>Antwoordopties (één per regel)</label><textarea id="f_options">${esc((p.options || []).join('\n'))}</textarea></div>
        <div data-show="keuze"><label>Nummer van het goede antwoord (1 = eerste)</label><input id="f_correct" type="number" min="1" value="${(Number(p.correct) || 0) + 1}"></div>
        <div data-show="vraag keuze opdracht foto"><label>Hint (kost ${state.settings.hintCost} pt)</label><input id="f_hint" value="${esc(p.hint)}"></div>
        <div class="grid2">
          <div><label>Punten</label><input id="f_points" type="number" min="0" value="${p.points}"></div>
          <div><label>Straal (m)</label><input id="f_radius" type="number" min="5" value="${p.radius}"></div>
          <div><label>Letter voor codewoord</label><input id="f_letter" maxlength="3" value="${esc(p.letter)}"></div>
          <div><label>Kompasmodus</label><label style="display:flex;gap:8px;align-items:center;color:var(--text);padding:.7em 0"><input type="checkbox" id="f_kompas" ${p.kompas ? 'checked' : ''}> geen kaart</label></div>
        </div>
        <div class="muted" style="font-size:.8em">Positie: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · <a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank">open in Google Maps</a></div>
        <div class="row"><button class="btn grow" id="save">Opslaan</button><button class="btn danger" id="del">Verwijderen</button></div>
      </div>`;
    const syncType = () => el.querySelectorAll('[data-show]').forEach(d => { d.style.display = d.dataset.show.split(' ').includes($('f_type').value) ? '' : 'none'; });
    $('f_type').onchange = syncType;
    syncType();
    $('back').onclick = () => { selected = null; renderTab(); draw(); };
    $('save').onclick = async () => {
      const cur = state.points.find(x => x.id === p.id) || p;
      try {
        await api('/api/admin/point', {
          id: p.id, lat: cur.lat, lng: cur.lng,
          name: $('f_name').value, type: $('f_type').value, intro: $('f_intro').value, question: $('f_question').value,
          answers: $('f_answers').value, options: $('f_options').value.split('\n').map(s => s.trim()).filter(Boolean),
          correct: Number($('f_correct').value) - 1, hint: $('f_hint').value, points: Number($('f_points').value),
          radius: Number($('f_radius').value), letter: $('f_letter').value.trim().toUpperCase(), kompas: $('f_kompas').checked,
        });
        App.toast('Opgeslagen', 'good');
        selected = null;
        renderTab();
      } catch (e) { App.toast(e.message, 'bad'); }
    };
    $('del').onclick = async () => {
      if (!confirm(`"${p.name}" verwijderen?`)) return;
      await api('/api/admin/point/' + p.id, null, 'DELETE');
      selected = null;
      renderTab();
    };
  }

  // Teams
  function renderTeams() {
    const el = $('tab');
    el.innerHTML = `<p class="muted" style="font-size:.85em">Elk team logt in met zijn pincode. Met "start bij punt" laat je teams op een ander punt beginnen, zodat ze niet achter elkaar aan lopen.</p>
      ${state.teams.map(t => `
        <div class="card stack" style="padding:14px;margin-bottom:10px" data-team="${t.id}">
          <div class="grid2">
            <div><label>Naam</label><input data-f="name" value="${esc(t.name)}"></div>
            <div><label>Pincode</label><input data-f="pin" value="${esc(t.pin)}"></div>
            <div><label>Kleur</label><input data-f="color" type="color" value="${esc(t.color)}"></div>
            <div><label>Start bij punt</label><input data-f="offset" type="number" min="1" value="${(t.offset || 0) + 1}"></div>
          </div>
          <div class="row"><button class="btn small grow" data-save>Opslaan</button><button class="btn danger small" data-del>Verwijderen</button></div>
        </div>`).join('')}
      <button class="btn block" id="addTeam">➕ Team toevoegen</button>`;
    $('addTeam').onclick = async () => {
      const colors = ['#ff7a3d', '#3ee08f', '#4dd2ff', '#ffc44d', '#ff5ec4', '#b06bff'];
      await api('/api/admin/team', { name: `Team ${state.teams.length + 1}`, color: colors[state.teams.length % colors.length], offset: state.teams.length });
    };
    el.querySelectorAll('[data-team]').forEach(card => {
      const f = k => card.querySelector(`[data-f=${k}]`).value;
      card.querySelector('[data-save]').onclick = async () => {
        try { await api('/api/admin/team', { id: card.dataset.team, name: f('name'), pin: f('pin'), color: f('color'), offset: Number(f('offset')) - 1 }); App.toast('Team opgeslagen', 'good'); }
        catch (e) { App.toast(e.message, 'bad'); }
      };
      card.querySelector('[data-del]').onclick = async () => {
        if (confirm('Team en zijn voortgang verwijderen?')) await api('/api/admin/team/' + card.dataset.team, null, 'DELETE');
      };
    });
  }

  // Verboden zones
  function renderZones() {
    const el = $('tab');
    el.innerHTML = `<p class="muted" style="font-size:.85em">Teams krijgen een rode waarschuwing en trilling als ze in een verboden zone lopen, bijvoorbeeld het bos na zonsondergang.</p>
      ${state.zones.map(z => `<div class="list-item" data-zone="${z.id}"><div class="grow"><b>${esc(z.name)}</b><div class="muted" style="font-size:.8em">${z.polygon.length} hoeken</div></div><button class="btn small" data-edit>✏️ Vorm</button><button class="btn danger small" data-del>✕</button></div>`).join('')}
      <button class="btn block" id="addZone">✏️ Zone tekenen</button>`;
    el.querySelectorAll('[data-zone]').forEach(li => {
      li.querySelector('[data-del]').onclick = async () => { if (confirm('Zone verwijderen?')) await api('/api/admin/zone/' + li.dataset.zone, null, 'DELETE'); };
      li.querySelector('[data-edit]').onclick = () => editZoneShape(state.zones.find(z => z.id === li.dataset.zone));
      li.onclick = e => { if (!e.target.closest('button')) map.fitBounds(state.zones.find(z => z.id === li.dataset.zone).polygon); };
    });
    $('addZone').onclick = () => {
      draft = [];
      drawDraft();
      setMode('zone', 'Tik de hoeken van de zone aan · <button class="btn small" id="zoneDone">Klaar</button> <button class="btn ghost small" id="zoneCancel">Stop</button>');
      $('zoneDone').onclick = async e => {
        e.stopPropagation();
        if (draft.length < 3) return App.toast('Minstens 3 hoeken nodig', 'bad');
        const name = prompt('Naam van de zone', 'Bos (na zonsondergang verboden)');
        if (name === null) return;
        try { await api('/api/admin/zone', { name, polygon: draft }); } catch (err) { App.toast(err.message, 'bad'); }
        draft = []; drawDraft(); setMode(null);
      };
      $('zoneCancel').onclick = e => { e.stopPropagation(); draft = []; drawDraft(); setMode(null); };
    };
  }

  // Vorm van een zone aanpassen: hoeken slepen, plusjes voor extra hoeken, gekozen hoek weghalen
  function editZoneShape(zone) {
    const poly = zone.polygon.map(c => [...c]);
    let sel = null;
    document.body.classList.add('editing');
    scrollTo(0, 0);
    map.invalidateSize();
    setMode('zoneEdit', '<div style="font-size:.85em;margin-bottom:6px">Sleep de gele bolletjes · tik ＋ voor een extra hoek</div><button class="btn small" id="zDel">Hoek weg</button> <button class="btn small" id="zSave">Opslaan</button> <button class="btn ghost small" id="zCancel">Stop</button>');
    map.fitBounds(poly, { paddingTopLeft: [30, 30], paddingBottomRight: [30, 110], animate: false });
    const shape = L.polygon(poly, { color: '#ffc44d', weight: 3, fillOpacity: 0.15, interactive: false });
    function redraw() {
      layers.draft.clearLayers();
      shape.setLatLngs(poly).addTo(layers.draft);
      poly.forEach((c, i) => {
        const m = L.marker(c, { draggable: true, zIndexOffset: 2000,
          icon: L.divIcon({ className: '', html: `<div class="vtx ${sel === i ? 'sel' : ''}"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(layers.draft);
        m.on('drag', () => { const ll = m.getLatLng(); poly[i] = [ll.lat, ll.lng]; shape.setLatLngs(poly); });
        m.on('dragend', redraw);
        m.on('click', () => { sel = i; redraw(); });
        const n = poly[(i + 1) % poly.length];
        const mid = L.marker([(c[0] + n[0]) / 2, (c[1] + n[1]) / 2], { zIndexOffset: 1500,
          icon: L.divIcon({ className: '', html: '<div class="mid">＋</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(layers.draft);
        mid.on('click', () => { poly.splice(i + 1, 0, [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2]); sel = i + 1; redraw(); });
      });
    }
    redraw();
    const stop = () => { layers.draft.clearLayers(); setMode(null); document.body.classList.remove('editing'); map.invalidateSize(); };
    $('zDel').onclick = e => {
      e.stopPropagation();
      if (sel == null) return App.toast('Tik eerst een hoek aan');
      if (poly.length <= 3) return App.toast('Een zone heeft minstens 3 hoeken', 'bad');
      poly.splice(sel, 1); sel = null; redraw();
    };
    $('zSave').onclick = async e => {
      e.stopPropagation();
      try { await api('/api/admin/zone', { id: zone.id, name: zone.name, polygon: poly }); App.toast('Zone opgeslagen', 'good'); stop(); }
      catch (err) { App.toast(err.message, 'bad'); }
    };
    $('zCancel').onclick = e => { e.stopPropagation(); stop(); };
  }

  // Live volgen
  function renderLive() {
    const el = $('tab');
    const rows = state.scoreboard;
    el.innerHTML = rows.map(r => {
      const t = state.teams.find(x => x.id === r.id);
      const pr = state.progress[r.id];
      const route = routeFor(t);
      const cur = route.find(p => !(pr && pr.results[p.id] && pr.results[p.id].done));
      const pos = pr && pr.pos;
      return `<div class="card" style="padding:14px;margin-bottom:10px">
        <div class="row"><span class="dot" style="background:${esc(r.color)}"></span><b class="grow">${esc(r.name)}</b><b>${r.score} pt</b></div>
        <div class="bar"><div style="width:${r.total ? (r.done / r.total) * 100 : 0}%"></div></div>
        <div class="muted" style="font-size:.85em;margin:6px 0">${r.done}/${r.total} · nu: ${cur ? esc(cur.name) + (pr?.results[cur.id]?.arrivedAt ? ' (ingecheckt)' : ' (onderweg)') : '🏁 binnen'}
          ${pos ? `· gezien ${Math.round((Date.now() - pos.ts) / 60000)} min geleden` : '· nog geen gps'}</div>
        <div class="row wrap">
          ${pos ? `<button class="btn ghost small" data-find="${r.id}">📍 Toon</button>` : ''}
          ${cur ? `<button class="btn ghost small" data-skip="${r.id}">⏭️ Punt overslaan</button>` : ''}
          <button class="btn ghost small" data-reset="${r.id}">↺ Opnieuw</button>
        </div></div>`;
    }).join('') || '<p class="muted">Nog geen teams.</p>';
    el.querySelectorAll('[data-find]').forEach(b => { b.onclick = () => { const p = state.progress[b.dataset.find].pos; map.setView([p.lat, p.lng], 17); }; });
    el.querySelectorAll('[data-skip]').forEach(b => { b.onclick = async () => { if (confirm('Dit team naar het volgende punt zetten?')) await api('/api/admin/skip/' + b.dataset.skip, {}); }; });
    el.querySelectorAll('[data-reset]').forEach(b => { b.onclick = async () => { if (confirm('Alle voortgang van dit team wissen?')) await api('/api/admin/reset', { teamId: b.dataset.reset }); }; });
  }

  function routeFor(team) {
    const pts = state.points;
    const rot = arr => { const k = arr.length ? ((team.offset || 0) % arr.length) : 0; return [...arr.slice(k), ...arr.slice(0, k)]; };
    if (!state.settings.lastIsFinish || pts.length < 3) return rot(pts);
    return [...rot(pts.slice(0, -1)), pts[pts.length - 1]];
  }

  // Instellingen
  function renderSettings() {
    const s = state.settings;
    const el = $('tab');
    el.innerHTML = `<div class="stack">
      <div><label>Titel</label><input id="s_title" value="${esc(s.title)}"></div>
      <div class="grid2">
        <div><label>Standaard straal (m)</label><input id="s_radius" type="number" value="${s.radius}"></div>
        <div><label>Kosten hint (pt)</label><input id="s_hint" type="number" value="${s.hintCost}"></div>
      </div>
      <label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" id="s_test" ${s.testMode ? 'checked' : ''}> Testmodus: inchecken kan overal (zet uit tijdens het echte spel!)</label>
      <label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" id="s_finish" ${s.lastIsFinish ? 'checked' : ''}> Laatste punt is voor iedereen de finish</label>
      <div><label>Schatten zichtbaar vanaf (m)</label><input id="s_reveal" type="number" value="${s.treasureReveal}"></div>
      <a class="btn ghost" href="/tv" target="_blank">📺 Tv-scherm openen</a>
      <button class="btn" id="s_save">Opslaan</button>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <button class="btn danger" id="s_reset">Alle voortgang en scores wissen</button>
    </div>`;
    $('s_save').onclick = async () => {
      await api('/api/admin/settings', { title: $('s_title').value, radius: Number($('s_radius').value), hintCost: Number($('s_hint').value), testMode: $('s_test').checked, lastIsFinish: $('s_finish').checked, treasureReveal: Number($('s_reveal').value) });
      App.toast('Instellingen opgeslagen', 'good');
    };
    $('s_reset').onclick = async () => { if (confirm('Echt alle scores wissen?')) await api('/api/admin/reset', {}); };
  }

  start();
})();
