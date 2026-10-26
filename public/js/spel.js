(() => {
  const token = App.store.get('teamToken');
  if (!token) { location.href = '/'; return; }
  const $ = id => document.getElementById(id);
  const ARROW = '<svg viewBox="0 0 100 100"><path d="M50 4 L78 86 L50 70 L22 86 Z" fill="#4dd2ff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><path d="M50 4 L50 70 L22 86 Z" fill="#b06bff" opacity=".85"/></svg>';
  document.querySelectorAll('[data-arrow]').forEach(a => { a.innerHTML = ARROW; });

  let view = null, me = null, heading = null, lastPointId = null, lastSentPos = 0, mistTimer = null;

  // ---- kaart ----
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([52.06, 5.66], 14);
  const layers = App.tileLayers();
  layers['Nacht'].addTo(map);
  L.control.layers(layers, null, { position: 'bottomright' }).addTo(map);
  const zoneLayer = L.layerGroup().addTo(map);
  const treasureLayer = L.layerGroup().addTo(map);
  let knownTreasures = null;
  const trailLayer = L.layerGroup().addTo(map);
  const targetMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="target-marker"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) });
  const targetCircle = L.circle([0, 0], { radius: 30, color: '#4dd2ff', weight: 1, fillOpacity: 0.08 });
  const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 });
  const meCircle = L.circle([0, 0], { radius: 10, color: '#b06bff', weight: 1, fillOpacity: 0.1 });
  let fitted = false;

  // ---- live verbinding ----
  const socket = io({ auth: { token } });
  socket.on('view', v => render(v));
  socket.on('mist', ({ from }) => { App.toast(`🌫️ ${from} stuurt mist! Even geen kaart…`, 'bad'); App.buzz([100, 50, 100]); });

  App.api('/api/me').then(render).catch(e => {
    if (e.status === 401) { App.store.set('teamToken', null); location.href = '/'; }
    else $('sheet').textContent = e.message;
  });

  // ---- gps ----
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(p => {
      me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      if (p.coords.heading != null && !isNaN(p.coords.heading) && p.coords.speed > 0.8 && heading == null) gpsHeading = p.coords.heading;
      meMarker.setLatLng(me).addTo(map);
      meCircle.setLatLng(me).setRadius(me.acc).addTo(map);
      $('gpsInfo').textContent = `GPS ±${Math.round(me.acc)} m` + (heading == null ? ' · tik de pijl voor kompas' : '');
      if (Date.now() - lastSentPos > 10000) {
        lastSentPos = Date.now();
        App.api('/api/pos', me).catch(() => {});
      }
      updateNav();
    }, err => {
      $('gpsInfo').textContent = err.code === 1 ? 'Geef de site toegang tot je locatie!' : 'Geen GPS-signaal';
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  } else {
    $('gpsInfo').textContent = 'Deze telefoon heeft geen GPS in de browser';
  }
  let gpsHeading = null;

  // ---- kompas ----
  function onOrient(e) {
    if (e.webkitCompassHeading != null) heading = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) heading = (360 - e.alpha) % 360;
    else return;
    updateArrow();
  }
  async function enableCompass() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return App.toast('Kompas niet toegestaan', 'bad');
      }
      addEventListener('deviceorientationabsolute', onOrient);
      addEventListener('deviceorientation', onOrient);
      App.toast('🧭 Kompas staat aan. Houd je telefoon plat.', 'good');
    } catch { App.toast('Kompas werkt niet op deze telefoon', 'bad'); }
  }
  if (typeof DeviceOrientationEvent !== 'undefined' && !DeviceOrientationEvent.requestPermission) enableCompass();
  $('compassSmall').onclick = enableCompass;
  $('compassOnly').onclick = () => { if (heading == null) enableCompass(); };

  // Scherm aan houden tijdens de tocht
  async function wakeLock() { try { await navigator.wakeLock?.request('screen'); } catch {} }
  wakeLock();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeLock(); });

  function updateArrow() {
    if (!view || !view.point || !me) return;
    const b = App.bearing(me, view.point);
    const h = heading ?? gpsHeading ?? 0;
    document.querySelectorAll('[data-arrow]').forEach(a => { a.style.transform = `rotate(${b - h}deg)`; });
  }

  function updateNav() {
    if (!view) return;
    const p = view.point;
    let d = null;
    if (p && me) d = App.distance(me, p);
    document.querySelectorAll('[data-dist]').forEach(el => {
      el.textContent = d == null ? '–' : App.fmtDist(d);
    });
    updateArrow();
    // verboden gebied
    const inZone = me && view.zones.some(z => App.inPolygon([me.lat, me.lng], z.polygon));
    const za = $('zoneAlert');
    if (inZone && za.style.display !== 'block') App.buzz([300, 100, 300, 100, 300]);
    za.style.display = inZone ? 'block' : 'none';
    // incheckknop
    // dichtstbijzijnde schat die nog te pakken is
    const tb = $('treasureBtn');
    const open = (view.treasures || []).filter(t => !t.claimed)
      .map(t => ({ ...t, d: me ? App.distance(me, t) : null }))
      .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9))[0];
    if (open) {
      const near = view.settings.testMode || (open.d != null && open.d <= 25 + Math.min(me.acc || 0, 20));
      tb.style.display = '';
      tb.disabled = !near;
      tb.classList.toggle('glow', near);
      tb.textContent = near ? `💎 Pak de schat! (+${open.points})` : `💎 Schat op ${App.fmtDist(open.d)}`;
      tb.dataset.id = open.id;
    } else tb.style.display = 'none';
    const btn = $('checkinBtn');
    if (btn && p) {
      const near = d != null && d <= p.radius + Math.min(me.acc || 0, 25);
      btn.disabled = !(near || view.settings.testMode);
      btn.classList.toggle('glow', near);
      $('checkinHint').textContent = near ? 'Je bent er! Check in.' :
        view.settings.testMode ? 'Testmodus: inchecken kan overal.' : `Kom binnen ${p.radius} m van het punt.`;
    }
  }

  // ---- weergave ----
  function render(v) {
    const prevId = lastPointId;
    view = v;
    lastPointId = v.point ? v.point.id : null;
    $('teamChip').innerHTML = `<span class="dot" style="background:${App.esc(v.team.color)}"></span> ${App.esc(v.team.name)}`;
    $('scoreChip').textContent = `${v.score} pt` + (v.rank ? ` · #${v.rank}` : '');
    $('jokers').textContent = v.jokers;
    $('jokerBtn').style.display = v.others.length ? '' : 'none';
    $('pointNr').textContent = v.point ? `Punt ${v.index + 1} van ${v.total}` : 'Klaar!';
    const compassOnly = v.point && v.point.kompas && !v.arrived;
    $('navCard').style.display = v.point && !compassOnly ? '' : 'none';

    // mist van een ander team
    clearTimeout(mistTimer);
    const mistLeft = v.mistUntil - Date.now();
    $('mist').classList.toggle('on', mistLeft > 0);
    if (mistLeft > 0) mistTimer = setTimeout(() => $('mist').classList.remove('on'), mistLeft);

    // kaartlagen
    zoneLayer.clearLayers();
    for (const z of v.zones) {
      L.polygon(z.polygon, { color: '#ff5470', weight: 2, fillOpacity: 0.25, dashArray: '6 6' }).bindTooltip(App.esc(z.name)).addTo(zoneLayer);
    }
    trailLayer.clearLayers();
    v.done.forEach((p, i) => L.circleMarker(p, { radius: 6, color: '#3ee08f', fillOpacity: 0.9 }).bindTooltip(`${i + 1}. ${App.esc(p.name)}`).addTo(trailLayer));
    if (v.done.length > 1) L.polyline(v.done, { color: '#3ee08f', weight: 2, opacity: 0.6, dashArray: '2 8' }).addTo(trailLayer);
    if (v.point) {
      targetMarker.setLatLng(v.point).addTo(map);
      targetCircle.setLatLng(v.point).setRadius(v.point.radius).addTo(map);
      if (!fitted || prevId !== v.point.id) {
        fitted = true;
        map.fitBounds(L.latLngBounds([v.point, me || v.point]).pad(0.4), { maxZoom: 17, animate: false });
      }
    } else { targetMarker.remove(); targetCircle.remove(); }
    $('compassOnly').style.display = compassOnly ? 'flex' : 'none';

    // verborgen schatten
    treasureLayer.clearLayers();
    for (const t of v.treasures || []) {
      L.marker([t.lat, t.lng], { icon: L.divIcon({ className: '', html: `<div class="treasure-marker ${t.claimed ? 'claimed' : ''}">💎</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }) })
        .bindTooltip(t.claimed ? 'Gevonden!' : `Schat: ${t.points} pt`).addTo(treasureLayer);
    }
    for (const p of v.paths || []) L.polyline(p.line, { color: '#ffc44d', weight: 3, opacity: 0.6, dashArray: '4 8' }).addTo(treasureLayer);
    const ids = (v.treasures || []).filter(t => !t.claimed).map(t => t.id);
    if (knownTreasures && ids.some(i => !knownTreasures.includes(i))) {
      App.toast('💎 Er ligt een schat in de buurt! Kijk op de kaart.', 'good');
      App.buzz([80, 60, 80, 60, 200]);
    }
    knownTreasures = ids;

    renderSheet(v);
    updateNav();
    if (prevId && v.point && prevId !== v.point.id) showReveal(v.point);
  }

  function lettersHtml(v) {
    return v.letters.length ? `<div><label>Verzamelde letters</label><div class="letters">${v.letters.map((l, i) => `<div class="letter" style="animation-delay:${i * .1}s">${App.esc(l)}</div>`).join('')}</div></div>` : '';
  }

  function renderSheet(v) {
    const s = $('sheet');
    const p = v.point;
    if (!p) {
      s.innerHTML = `<h2>🎉 Binnen!</h2>
        <p>Jullie hebben alle ${v.total} punten gehad met <b>${v.score} punten</b>${v.rank ? ` en staan op plek <b>${v.rank}</b>` : ''}.</p>
        ${lettersHtml(v)}<a class="btn block" href="/scorebord">🏆 Naar het scorebord</a>`;
      return;
    }
    if (!v.arrived) {
      s.innerHTML = `<div><h2>${App.esc(p.name)}</h2>${p.intro ? `<p class="muted" style="margin:0">${App.esc(p.intro)}</p>` : ''}</div>
        <button class="btn block" id="checkinBtn">📍 Inchecken</button>
        <div class="muted" id="checkinHint" style="font-size:.85em;text-align:center"></div>${lettersHtml(v)}`;
      $('checkinBtn').onclick = checkin;
      return;
    }
    const triesLeft = v.maxTries - v.tries;
    let body = `<div><div class="muted" style="font-size:.85em">${App.esc(p.name)} · ${p.points} pt</div>
      <h2>${App.esc(p.question || 'Opdracht')}</h2></div>`;
    if (p.type === 'keuze') {
      body += `<div class="options">${(p.options || []).map((o, i) => `<button class="opt" data-i="${i}">${String.fromCharCode(65 + i)}. ${App.esc(o)}</button>`).join('')}</div>`;
    } else if (p.type === 'foto') {
      body += `<label class="btn block" id="photoLbl" style="cursor:pointer">📸 Foto maken
        <input type="file" id="photoIn" accept="image/*" capture="environment" style="display:none"></label>
        <div class="muted" style="font-size:.85em">De organisatie keurt de foto goed, daarna krijgen jullie de punten.</div>`;
    } else if (p.type === 'opdracht') {
      body += `<button class="btn block" id="doneBtn">✅ Gedaan!</button>`;
    } else {
      body += `<div class="row"><input id="answer" class="grow" placeholder="Jullie antwoord" autocomplete="off"><button class="btn" id="sendBtn">➜</button></div>`;
    }
    if (p.type !== 'opdracht' && p.type !== 'foto') body += `<div class="muted" style="font-size:.85em">Nog ${triesLeft} ${triesLeft === 1 ? 'poging' : 'pogingen'}</div>`;
    if (p.hint) body += `<div class="card" style="padding:12px;background:rgba(255,196,77,.12)">💡 ${App.esc(p.hint)}</div>`;
    else if (p.hasHint) body += `<button class="btn ghost small" id="hintBtn">💡 Hint (kost punten)</button>`;
    s.innerHTML = body;
    s.querySelectorAll('.opt').forEach(b => { b.onclick = () => send(b.dataset.i); });
    if ($('doneBtn')) $('doneBtn').onclick = () => send('gedaan');
    if ($('photoIn')) $('photoIn').onchange = e => e.target.files[0] && uploadPhoto(e.target.files[0]);
    if ($('sendBtn')) {
      $('sendBtn').onclick = () => $('answer').value.trim() && send($('answer').value);
      $('answer').onkeydown = e => { if (e.key === 'Enter') $('sendBtn').click(); };
    }
    if ($('hintBtn')) $('hintBtn').onclick = async () => {
      if (!confirm('Een hint kost punten. Zeker weten?')) return;
      try { await App.api('/api/hint', {}); } catch (e) { App.toast(e.message, 'bad'); }
    };
  }

  async function checkin() {
    $('checkinBtn').disabled = true;
    try {
      const r = await App.api('/api/checkin', me || {});
      App.buzz([60, 40, 120]);
      App.toast(r.first ? '🥇 Jullie zijn als eerste bij dit punt!' : r.rank ? `📍 Ingecheckt als nummer ${r.rank}` : '📍 Ingecheckt', 'good');
      if (r.first) App.confetti();
    } catch (e) { App.toast(e.message, 'bad'); App.buzz(200); updateNav(); }
  }

  async function send(answer) {
    try {
      const r = await App.api('/api/answer', { answer });
      if (r.correct) { App.confetti(); App.buzz([50, 50, 50, 50, 200]); App.toast(r.letter ? `✅ Goed! Je krijgt de letter ${r.letter}` : '✅ Goed zo!', 'good'); }
      else if (r.out) App.toast('❌ Helaas, door naar het volgende punt.', 'bad');
      else { App.toast(`❌ Fout, nog ${r.triesLeft} ${r.triesLeft === 1 ? 'poging' : 'pogingen'}`, 'bad'); App.buzz(300); }
    } catch (e) { App.toast(e.message, 'bad'); }
  }

  // Foto verkleinen in de telefoon en dan versturen
  async function uploadPhoto(file) {
    const lbl = $('photoLbl');
    lbl.firstChild.textContent = '⏳ Foto versturen…';
    try {
      const img = await new Promise((ok, bad) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => bad(new Error('Kon de foto niet lezen'));
        i.src = URL.createObjectURL(file);
      });
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.78);
      const r = await App.api('/api/photo', { data });
      App.confetti(); App.buzz([50, 50, 200]);
      App.toast(r.letter ? `📸 Foto verstuurd! Letter ${r.letter}` : '📸 Foto verstuurd!', 'good');
    } catch (e) {
      App.toast(e.message, 'bad');
      if ($('photoLbl')) $('photoLbl').firstChild.textContent = '📸 Foto maken';
    }
  }

  $('treasureBtn').onclick = async () => {
    const b = $('treasureBtn');
    b.disabled = true;
    try {
      const r = await App.api('/api/treasure/' + b.dataset.id, me || {});
      App.confetti(); App.buzz([60, 40, 60, 40, 300]);
      App.toast(r.first ? `💎 Als eerste gevonden! +${r.points} pt` : `💎 Schat gevonden! +${r.points} pt`, 'good');
    } catch (e) { App.toast(e.message, 'bad'); b.disabled = false; }
  };

  function showReveal(p) {
    $('revealName').textContent = p.name;
    $('revealIntro').textContent = p.intro || (p.kompas ? 'Alleen met het kompas…' : 'Volg de pijl!');
    const r = $('reveal');
    r.classList.remove('show'); void r.offsetWidth; r.classList.add('show');
  }
  $('revealGo').onclick = () => $('reveal').classList.remove('show');

  // ---- mist sturen & menu ----
  $('jokerBtn').onclick = async () => {
    if (!view.jokers) return App.toast('Win een mist-joker door als eerste bij een punt te zijn!');
    const names = view.others.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
    const pick = prompt(`Naar welk team stuur je 60 seconden mist?\n${names}\n\nTyp het nummer:`);
    const t = view.others[Number(pick) - 1];
    if (!t) return;
    try { await App.api('/api/mist', { teamId: t.id }); App.toast(`🌫️ Mist gestuurd naar ${t.name}!`, 'good'); }
    catch (e) { App.toast(e.message, 'bad'); }
  };
  $('menuBtn').onclick = () => {
    const c = prompt('Menu:\n1. Scorebord\n2. Kompas aanzetten\n3. Uitloggen\n\nTyp het nummer:');
    if (c === '1') location.href = '/scorebord';
    if (c === '2') enableCompass();
    if (c === '3' && confirm('Uitloggen?')) { App.store.set('teamToken', null); location.href = '/'; }
  };
})();
