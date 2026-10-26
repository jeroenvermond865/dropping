(() => {
  const $ = id => document.getElementById(id);
  const esc = App.esc;
  const api = (path, body, method) => App.api(path, body, 'adminToken', method);
  const TYPES = { checkin: 'Alleen inchecken', vraag: 'Open vraag', keuze: 'Meerkeuze', opdracht: 'Opdracht (gedaan-knop)' };

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
    } else if (mode === 'zone') {
      draft.push([e.latlng.lat, e.latlng.lng]);
      drawDraft();
    }
  }

  function draw() {
    $('title').textContent = state.settings.title;
    layers.zones.clearLayers();
    for (const z of state.zones) {
      L.polygon(z.polygon, { color: '#ff5470', weight: 2, fillOpacity: 0.2, dashArray: '6 6' }).bindTooltip(esc(z.name)).addTo(layers.zones);
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
        catch (e) { App.toast(e.message, 'bad'); }
      });
    });
    drawTeams();
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
    if (draft.length) L.polyline([...draft, draft[0]], { color: '#ffc44d', weight: 3, dashArray: '4 6' }).addTo(layers.draft);
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
    ({ punten: renderPoints, teams: renderTeams, zones: renderZones, live: renderLive, instellingen: renderSettings })[tab]();
  }

  // Punten
  function renderPoints() {
    const el = $('tab');
    const p = state.points.find(x => x.id === selected);
    if (p) return renderPointForm(p);
    el.innerHTML = `
      <button class="btn block" id="addPoint">➕ Punt op de kaart zetten</button>
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

  function renderPointForm(p) {
    const el = $('tab');
    el.innerHTML = `
      <button class="btn ghost small" id="back">← Alle punten</button>
      <div class="stack" style="margin-top:12px">
        <div><label>Naam</label><input id="f_name" value="${esc(p.name)}"></div>
        <div><label>Soort</label><select id="f_type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><label>Aanwijzing bij onthullen (zien ze onderweg)</label><textarea id="f_intro">${esc(p.intro)}</textarea></div>
        <div data-show="vraag keuze opdracht"><label>Vraag of opdracht (zien ze pas bij het punt)</label><textarea id="f_question">${esc(p.question)}</textarea></div>
        <div data-show="vraag"><label>Goede antwoorden, scheiden met | (leeg = elk antwoord goed)</label><input id="f_answers" value="${esc(p.answers)}" placeholder="bijv. 12|twaalf"></div>
        <div data-show="keuze"><label>Antwoordopties (één per regel)</label><textarea id="f_options">${esc((p.options || []).join('\n'))}</textarea></div>
        <div data-show="keuze"><label>Nummer van het goede antwoord (1 = eerste)</label><input id="f_correct" type="number" min="1" value="${(Number(p.correct) || 0) + 1}"></div>
        <div data-show="vraag keuze opdracht"><label>Hint (kost ${state.settings.hintCost} pt)</label><input id="f_hint" value="${esc(p.hint)}"></div>
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
      ${state.zones.map(z => `<div class="list-item" data-zone="${z.id}"><div class="grow"><b>${esc(z.name)}</b><div class="muted" style="font-size:.8em">${z.polygon.length} hoeken</div></div><button class="btn danger small">Verwijderen</button></div>`).join('')}
      <button class="btn block" id="addZone">✏️ Zone tekenen</button>`;
    el.querySelectorAll('[data-zone]').forEach(li => {
      li.querySelector('button').onclick = async () => { if (confirm('Zone verwijderen?')) await api('/api/admin/zone/' + li.dataset.zone, null, 'DELETE'); };
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
      <button class="btn" id="s_save">Opslaan</button>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <button class="btn danger" id="s_reset">Alle voortgang en scores wissen</button>
    </div>`;
    $('s_save').onclick = async () => {
      await api('/api/admin/settings', { title: $('s_title').value, radius: Number($('s_radius').value), hintCost: Number($('s_hint').value), testMode: $('s_test').checked, lastIsFinish: $('s_finish').checked });
      App.toast('Instellingen opgeslagen', 'good');
    };
    $('s_reset').onclick = async () => { if (confirm('Echt alle scores wissen?')) await api('/api/admin/reset', {}); };
  }

  start();
})();
