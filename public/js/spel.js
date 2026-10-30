(() => {
  const token = App.store.get('teamToken');
  if (!token) { location.href = '/'; return; }
  const $ = id => document.getElementById(id);
  const ARROW = '<svg viewBox="0 0 100 100"><path d="M50 4 L78 86 L50 70 L22 86 Z" fill="#4dd2ff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><path d="M50 4 L50 70 L22 86 Z" fill="#b06bff" opacity=".85"/></svg>';
  document.querySelectorAll('[data-arrow]').forEach(a => { a.innerHTML = ARROW; });

  // Fouten op de telefoon naar het serverlogboek, zodat ze te onderzoeken zijn
  let reported = 0;
  function reportError(msg) {
    if (reported++ > 20) return;
    fetch('/api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: String(msg).slice(0, 300), ua: navigator.userAgent }) }).catch(() => {});
  }
  addEventListener('error', e => reportError('fout: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
  addEventListener('unhandledrejection', e => reportError('promise: ' + (e.reason && e.reason.message || e.reason)));

  let view = null, me = null, heading = null, lastPointId = null, lastSentPos = 0, mistTimer = null;

  // ---- kaart ----
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([52.06, 5.66], 14);
  const layers = App.tileLayers();
  layers['Nacht'].addTo(map);
  const layerControl = L.control.layers(layers, null, { position: 'bottomright' }).addTo(map);
  const zoneLayer = L.layerGroup().addTo(map);
  const treasureLayer = L.layerGroup().addTo(map);
  let knownTreasures = null;
  const trailLayer = L.layerGroup().addTo(map);
  const legLayer = L.layerGroup().addTo(map);
  const tileLayer = layers['Nacht'];
  // Volgende punt: een vlag met de naam; jouw eigen gps: de knipperende blauwe stip
  const targetMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="next-marker">🚩</div>', iconSize: [30, 30], iconAnchor: [6, 28] }) });
  const prevMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="prev-marker"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) });
  const targetCircle = L.circle([0, 0], { radius: 30, color: '#4dd2ff', weight: 1, fillOpacity: 0.08 });
  const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 });
  const meCircle = L.circle([0, 0], { radius: 10, color: '#b06bff', weight: 1, fillOpacity: 0.1 });
  let fitted = false;

  // ---- live verbinding ----
  const socket = io({ auth: { token } });
  socket.on('view', v => render(v));
  socket.on('photoJudged', r => {
    if (r.approve) { App.confetti(); App.buzz([50, 50, 50, 50, 200]); }
    choose(r.approve ? `📸 Foto goedgekeurd! Jullie krijgen ${r.points} van de ${r.max} punten voor "${r.pointName}".${r.letter ? ` En de letter ${r.letter}!` : ''}` : `📸 De foto bij "${r.pointName}" is helaas afgekeurd. Geen punten.`, [{ label: r.approve ? '🎉 Top!' : 'Jammer', value: 1 }]);
  });
  socket.on('mist', ({ from }) => { App.toast(`🌫️ ${from} stuurt mist! Even geen kaart…`, 'bad'); App.buzz([100, 50, 100]); });

  App.api('/api/me').then(render).catch(e => {
    if (e.status === 401) { App.store.set('teamToken', null); location.href = '/'; }
    else $('sheet').textContent = e.message;
  });

  // ---- gps ----
  let gpsHeading = null, watchId = null, gpsTimer = null;
  const gpsText = (t, bad) => ['gpsInfo', 'gpsInfo2'].forEach(id => { const el = $(id); if (el) { el.textContent = t; el.style.color = bad ? 'var(--bad)' : ''; } });
  function sendPos() {
    if (!me) return;
    lastSentPos = Date.now();
    App.api('/api/pos', me).catch(() => {});
  }
  function onGps(p) {
    me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    // Eerst versturen, zodat het beheer het team ook ziet als er hieronder iets misgaat
    if (Date.now() - lastSentPos > 5000) sendPos();
    if (p.coords.heading != null && !isNaN(p.coords.heading) && p.coords.speed > 0.8 && heading == null) gpsHeading = p.coords.heading;
    gpsText(`📡 GPS werkt · ±${Math.round(me.acc)} m`);
    try {
      meMarker.setLatLng(me).addTo(map);
      meCircle.setLatLng(me).setRadius(me.acc).addTo(map);
      updateNav();
    } catch (e) { reportError('gps-weergave: ' + e.message); }
  }
  function onGpsError(err) {
    reportError('gps-fout ' + err.code + ': ' + err.message);
    if (err.code === 1) return gpsText('📡 Geen toegang tot je locatie. Zet op de iPhone aan: Instellingen › Privacy › Locatievoorzieningen › Chrome/Safari › "Bij gebruik van app", en sta de site toe. Herlaad daarna.', true);
    gpsText('📡 GPS zoekt signaal…', true);
    // Sommige telefoons stoppen na een time-out; dan opnieuw beginnen
    clearTimeout(gpsTimer);
    gpsTimer = setTimeout(startGps, 3000);
  }
  function startGps() {
    if (!('geolocation' in navigator)) return gpsText('Deze telefoon heeft geen GPS in de browser', true);
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    gpsText('📡 GPS zoeken…');
    watchId = navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  startGps();
  // Ook stilstaand blijft het team zichtbaar in het beheer
  setInterval(() => { if (me && Date.now() - lastSentPos > 10000) sendPos(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') startGps(); });

  // ---- kompas ----
  function onOrient(e) {
    if (e.webkitCompassHeading != null) heading = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) heading = (360 - e.alpha) % 360;
    else return;
    $('compassBtn').style.display = 'none';
    updateArrow();
  }
  let compassOn = false;
  async function enableCompass(quiet) {
    if (compassOn) return;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return App.toast('Kompas niet toegestaan. Sta "beweging en richting" toe.', 'bad');
      }
      compassOn = true;
      addEventListener('deviceorientationabsolute', onOrient);
      addEventListener('deviceorientation', onOrient);
      if (!quiet) App.toast('🧭 Kompas staat aan. Houd je telefoon plat.', 'good');
    } catch { App.toast('Kompas werkt niet op deze telefoon', 'bad'); }
  }
  // Android mag meteen; iPhone vraagt toestemming bij de eerste tik op het scherm.
  if (typeof DeviceOrientationEvent !== 'undefined' && !DeviceOrientationEvent.requestPermission) enableCompass(true);
  else document.addEventListener('click', () => enableCompass(), { once: true, capture: true });
  $('compassSmall').onclick = () => enableCompass();
  $('compassBtn').onclick = () => enableCompass();

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

  // Zonder kaart: bij een schat in de buurt alleen het stukje kaart tussen jou en de schat laten zien.
  function nearTreasure() {
    if (!view || !me) return null;
    return (view.treasures || []).filter(t => !t.claimed).map(t => ({ ...t, d: App.distance(me, t) })).sort((a, b) => a.d - b.d)[0] || null;
  }
  const treasureLine = L.polyline([], { color: '#ffc44d', weight: 3, dashArray: '4 8' });
  function treasureWindow() {
    const pane = map.getPane('tilePane');
    if (!view || view.settings.showMap) { pane.style.clipPath = ''; treasureLine.remove(); return; }
    const t = nearTreasure();
    if (!t) { tileLayer.remove(); treasureLine.remove(); pane.style.clipPath = ''; return; }
    tileLayer.addTo(map);
    treasureLine.setLatLngs([[me.lat, me.lng], [t.lat, t.lng]]).addTo(map);
    const a = map.latLngToLayerPoint([t.lat, t.lng]), b = map.latLngToLayerPoint([me.lat, me.lng]);
    const c = a.add(b).divideBy(2), r = a.distanceTo(b) / 2 + 70;
    pane.style.clipPath = `circle(${Math.round(r)}px at ${Math.round(c.x)}px ${Math.round(c.y)}px)`;
  }
  map.on('zoom move zoomend moveend', () => { try { treasureWindow(); } catch (e) { reportError('schatvenster: ' + e.message); } });

  // Kaartbeeld passend maken; zonder kaart blijft er boven ruimte voor het kompas en onder voor de vraag.
  let lastFit = 0;
  function fitView() {
    if (!view || !view.point) return;
    lastFit = Date.now();
    const t = !view.settings.showMap && nearTreasure();
    const pts = [...(view.point.leg || []), [view.point.lat, view.point.lng], ...(me ? [[me.lat, me.lng]] : []), ...(t ? [[t.lat, t.lng]] : [])];
    const nomap = !view.settings.showMap;
    const top = nomap ? Math.max(...[...$('compassOnly').children].map(c => c.getBoundingClientRect().bottom)) + 10 : 60;
    const bottom = nomap ? innerHeight - $('sheet').getBoundingClientRect().top + 10 : 60;
    try { map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, Math.max(60, top)], paddingBottomRight: [30, Math.max(60, bottom)], maxZoom: 17, animate: false }); }
    catch (e) { reportError('kaart passen: ' + e.message); }
  }

  function updateNav() {
    if (!view) return;
    if (Date.now() - lastFit > 15000) fitView();
    treasureWindow();
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
    $('scoreChip').textContent = `${v.score} / ${v.possible} pt`;
    $('jokers').textContent = v.jokers;
    $('jokerBtn').style.display = v.others.length ? '' : 'none';
    $('pointNr').textContent = v.point ? `Punt ${v.index + 1} van ${v.total}` : 'Klaar!';
    // Zonder kaart (standaard) altijd het grote kompas; met kaart alleen bij kompaspunten
    const showMap = v.settings.showMap;
    // Zonder kaart: geen straten, alleen het stukje route naar het volgende punt
    document.querySelector('.game').classList.toggle('nomap', !showMap);
    if (showMap) tileLayer.addTo(map); else tileLayer.remove();
    treasureWindow();
    layerControl.getContainer().style.display = showMap ? '' : 'none';
    const compassOnly = v.point && (!showMap || (v.point.kompas && !v.arrived));
    $('navCard').style.display = v.point && !compassOnly ? '' : 'none';
    $('compassLabel').textContent = v.point ? `Punt ${v.index + 1} van ${v.total}: ${v.point.name}` : '';

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
    legLayer.clearLayers();
    if (v.point && v.point.leg && v.point.leg.length > 1) {
      L.polyline(v.point.leg, { color: '#4dd2ff', weight: 14, opacity: 0.15 }).addTo(legLayer);
      L.polyline(v.point.leg, { color: '#4dd2ff', weight: 5, opacity: 0.95, dashArray: '10 10' }).addTo(legLayer);
    }
    if (!showMap) { zoneLayer.clearLayers(); trailLayer.clearLayers(); }
    if (v.point) {
      targetMarker.setLatLng(v.point).addTo(map)
        .unbindTooltip().bindTooltip('Volgende: ' + App.esc(v.point.name), { permanent: true, direction: 'right', offset: [14, -14], className: 'next-label' });
      if (v.point.leg && v.point.leg.length > 1) prevMarker.setLatLng(v.point.leg[0]).addTo(map); else prevMarker.remove();
      targetCircle.setLatLng(v.point).setRadius(v.point.radius).addTo(map);
      if (!fitted || prevId !== v.point.id) { fitted = true; lastFit = 0; }
    } else { targetMarker.remove(); targetCircle.remove(); prevMarker.remove(); }
    $('compassOnly').style.display = compassOnly ? 'flex' : 'none';
    $('compassBtn').style.display = heading == null ? '' : 'none';

    // verborgen schatten
    treasureLayer.clearLayers();
    for (const t of v.treasures || []) {
      L.marker([t.lat, t.lng], { icon: L.divIcon({ className: '', html: `<div class="treasure-marker ${t.claimed ? 'claimed' : ''}">💎</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }) })
        .bindTooltip(t.claimed ? 'Gevonden!' : `Schat: ${t.points} pt`).addTo(treasureLayer);
    }
    for (const p of v.paths || []) L.polyline(p.line, { color: '#ffc44d', weight: 3, opacity: 0.6, dashArray: '4 8' }).addTo(treasureLayer);
    const ids = (v.treasures || []).filter(t => !t.claimed).map(t => t.id);
    if (knownTreasures && ids.some(i => !knownTreasures.includes(i))) {
      App.toast(v.settings.showMap ? '💎 Er ligt een schat in de buurt! Kijk op de kaart.' : '💎 Schat in de buurt! Een stukje kaart laat zien waar hij ligt.', 'good');
      lastFit = 0;
      App.buzz([80, 60, 80, 60, 200]);
    }
    knownTreasures = ids;

    renderSheet(v);
    maybeShowRules();
    if (!lastFit) fitView();
    updateNav();
    if (prevId && v.point && prevId !== v.point.id) showReveal(v.point);
  }

  function scoreHtml(v) {
    return `<div class="muted" style="font-size:.85em">⭐ Jullie hebben <b>${v.score}</b> van de <b>${v.possible}</b> punten die tot nu toe te halen waren (hele tocht: ${v.maxTotal}).${v.pendingPhotos ? ` 📸 Nog tot ${v.pendingPhotos} punten voor foto's die wachten op goedkeuring.` : ''}</div>`;
  }

  function lettersHtml(v) {
    return v.letters.length ? `<div><label>Verzamelde letters</label><div class="letters">${v.letters.map((l, i) => `<div class="letter" style="animation-delay:${i * .1}s">${App.esc(l)}</div>`).join('')}</div></div>` : '';
  }

  function renderSheet(v) {
    const s = $('sheet');
    const p = v.point;
    if (!p) {
      s.innerHTML = `<h2>🎉 Binnen!</h2>
        <p>Jullie hebben alle ${v.total} punten gehad met <b>${v.score}</b> van de <b>${v.possible}</b> mogelijke punten${v.rank && v.others.length ? ` en staan op plek <b>${v.rank}</b>` : ''}.</p>
        ${lettersHtml(v)}<a class="btn block" href="/scorebord">🏆 Naar het scorebord</a>`;
      return;
    }
    if (!v.arrived) {
      s.innerHTML = `<div><h2>${App.esc(p.name)}</h2>${p.intro ? `<p class="muted" style="margin:0">${App.esc(p.intro)}</p>` : ''}</div>
        <button class="btn block" id="checkinBtn">📍 Inchecken</button>
        <div class="muted" id="checkinHint" style="font-size:.85em;text-align:center"></div>${scoreHtml(v)}${lettersHtml(v)}`;
      $('checkinBtn').onclick = checkin;
      return;
    }
    if (p.codeword) return renderCodeword(s, v, p.codeword);
    const triesLeft = v.maxTries - v.tries;
    const penalty = p.type === 'keuze' || p.type === 'vraag' ? ` · −${v.wrongPenalty} per fout antwoord` : '';
    let body = `<div><div class="muted" style="font-size:.85em">${App.esc(p.name)} · te verdienen: ${p.points} pt${penalty}</div>
      <h2>${App.esc(p.question || 'Opdracht')}</h2></div>`;
    if (p.type === 'keuze') {
      body += `<div class="options">${(p.options || []).map((o, i) => `<button class="opt" data-i="${i}">${String.fromCharCode(65 + i)}. ${App.esc(o)}</button>`).join('')}</div>`;
    } else if (p.type === 'foto') {
      body += `<div class="card" style="padding:12px;background:rgba(77,210,255,.1)">📸 <b>Foto-opdracht:</b> jullie punten (max ${p.points}) komen pas als de organisatie de foto heeft goedgekeurd. Dat kan meteen zijn, maar soms ook pas na afloop. Na het insturen kunnen jullie gewoon door naar het volgende punt.</div>
        <div class="row" style="gap:8px">
          <label class="btn grow photo-lbl" style="cursor:pointer">📸 Foto maken
            <input type="file" class="photo-in" accept="image/*" capture="environment" style="display:none"></label>
          <label class="btn ghost grow photo-lbl" style="cursor:pointer">🖼️ Uit galerij
            <input type="file" class="photo-in" accept="image/*" style="display:none"></label>
        </div>`;
    } else if (p.type === 'opdracht') {
      body += `<button class="btn block" id="doneBtn">✅ Gedaan!</button>`;
    } else {
      body += `<div class="row"><input id="answer" class="grow" placeholder="Jullie antwoord" autocomplete="off"><button class="btn" id="sendBtn">➜</button></div>`;
    }
    if (p.type !== 'opdracht' && p.type !== 'foto') body += `<div class="muted" style="font-size:.85em">Nog ${triesLeft} ${triesLeft === 1 ? 'poging' : 'pogingen'}</div>`;
    if (p.hint) body += `<div class="card" style="padding:12px;background:rgba(255,196,77,.12)">💡 ${App.esc(p.hint)}</div>`;
    else if (p.hasHint) body += `<button class="btn ghost small" id="hintBtn">💡 Hint gebruiken (kost ${v.settings.hintCost} punten)</button>`;
    body += scoreHtml(v);
    s.innerHTML = body;
    s.querySelectorAll('.opt').forEach(b => { b.onclick = () => send(b.dataset.i); });
    if ($('doneBtn')) $('doneBtn').onclick = () => send('gedaan');
    s.querySelectorAll('.photo-in').forEach(i => { i.onchange = e => e.target.files[0] && uploadPhoto(e.target.files[0]); });
    if ($('sendBtn')) {
      $('sendBtn').onclick = () => $('answer').value.trim() && send($('answer').value);
      $('answer').onkeydown = e => { if (e.key === 'Enter') $('sendBtn').click(); };
    }
    if ($('hintBtn')) $('hintBtn').onclick = async () => {
      if (await choose(`Een hint kost ${v.settings.hintCost} punten. Zeker weten?`, [{ label: `💡 Ja, hint gebruiken (−${v.settings.hintCost})`, value: 1 }, { label: 'Nee, zelf proberen', value: 0, ghost: true }]) !== 1) return;
      try { await App.api('/api/hint', {}); } catch (e) { App.toast(e.message, 'bad'); }
    };
  }

  // Finish: het codewoord met de verdiende letters al ingevuld; de rest zelf aanvullen
  function renderCodeword(s, v, cw) {
    const got = cw.board.filter(Boolean).length;
    s.innerHTML = `<div><div class="muted" style="font-size:.85em">🏁 Finish · laatste opdracht</div><h2>🔤 Het codewoord</h2></div>
      <p style="margin:0">De <b style="color:var(--good)">groene letters</b> hebben jullie onderweg verdiend: ${got} van de ${cw.length} (+${cw.perLetter} per letter).
        Vul de lege vakjes aan: +${cw.perGuess} per goede letter en +${cw.whole} als het hele woord klopt. <b>Je hebt één poging!</b></p>
      <div class="code-row">${cw.board.map((c, i) => c
        ? `<div class="code-slot got">${App.esc(c)}</div>`
        : `<input class="code-slot" data-i="${i}" maxlength="1" autocomplete="off" autocapitalize="characters" spellcheck="false">`).join('')}</div>
      <button class="btn block" id="codeBtn">🔤 Codewoord insturen</button>${scoreHtml(v)}`;
    const inputs = [...s.querySelectorAll('input.code-slot')];
    inputs.forEach((inp, k) => {
      inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, ''); if (inp.value && inputs[k + 1]) inputs[k + 1].focus(); };
      inp.onkeydown = e => { if (e.key === 'Backspace' && !inp.value && inputs[k - 1]) inputs[k - 1].focus(); };
    });
    $('codeBtn').onclick = async () => {
      const guess = cw.board.map((c, i) => c || (s.querySelector(`input[data-i="${i}"]`).value || ' ')).join('');
      if (inputs.some(i => !i.value) && await choose('Nog niet alle vakjes zijn ingevuld. Toch insturen?', [{ label: 'Ja, insturen', value: 1 }]) !== 1) return;
      $('codeBtn').disabled = true;
      try {
        const r = await App.api('/api/codeword', { guess });
        if (r.whole) { App.confetti(); App.buzz([50, 50, 50, 50, 300]); }
        await choose(`${r.whole ? '🎉 Goed geraden' : '🔤 Het woord was'}: ${r.word}! Verdiende letters ${r.parts.letters} + zelf ingevuld ${r.parts.guessed}${r.whole ? ' + hele woord ' + r.parts.whole : ''} = ${r.points} punten.`, [{ label: '🏆 Op naar het scorebord!', value: 1 }]);
      } catch (e) { App.toast(e.message, 'bad'); $('codeBtn').disabled = false; }
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
      if (r.correct) { App.confetti(); App.buzz([50, 50, 50, 50, 200]); App.toast(r.letter ? `✅ Goed! Je krijgt de letter ${r.letter}` : r.letterMissed ? '✅ Goed! Maar geen letter: die krijg je alleen als het in één keer goed is.' : '✅ Goed zo!', 'good'); }
      else if (r.out) App.toast('❌ Helaas, door naar het volgende punt.', 'bad');
      else { App.toast(`❌ Fout (−${view.wrongPenalty} punten), nog ${r.triesLeft} ${r.triesLeft === 1 ? 'poging' : 'pogingen'}`, 'bad'); App.buzz(300); }
    } catch (e) { App.toast(e.message, 'bad'); }
  }

  // Foto verkleinen in de telefoon en dan versturen
  async function uploadPhoto(file) {
    const lbls = document.querySelectorAll('.photo-lbl');
    const labels = [...lbls].map(l => l.firstChild.textContent);
    lbls.forEach(l => { l.firstChild.textContent = '⏳ Versturen…'; });
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
      App.toast('📸 Foto verstuurd! Punten (en eventueel een letter) volgen na goedkeuring.', 'good');
    } catch (e) {
      App.toast(e.message, 'bad');
      document.querySelectorAll('.photo-lbl').forEach((l, i) => { l.firstChild.textContent = labels[i]; });
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

  // ---- keuzemenu ----
  // Toont knoppen in een venster onderin; geeft de value van de gekozen knop terug, of null.
  function choose(title, items) {
    return new Promise(done => {
      const m = $('modal'), c = $('modalCard');
      c.innerHTML = `<h3>${App.esc(title)}</h3>` + items.map((it, i) => `<button class="btn block ${it.ghost ? 'ghost' : ''} ${it.danger ? 'danger' : ''}" data-i="${i}">${App.esc(it.label)}</button>`).join('')
        + '<button class="btn block ghost" data-i="-1">Sluiten</button>';
      const close = val => { m.classList.remove('show'); done(val); };
      c.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => close(b.dataset.i < 0 ? null : items[b.dataset.i].value); });
      m.onclick = e => { if (e.target === m) close(null); };
      m.classList.add('show');
    });
  }

  // ---- spelregels: bij de eerste keer en via het menu ----
  function showRules() {
    const m = $('modal'), c = $('modalCard');
    c.innerHTML = App.rulesHtml(view && view.settings) + '<button class="btn block" id="rulesOk">👍 Begrepen, op pad!</button>';
    $('rulesOk').onclick = () => m.classList.remove('show');
    m.onclick = null;
    m.classList.add('show');
  }
  let rulesShown = false;
  function maybeShowRules() {
    if (rulesShown || !view) return;
    rulesShown = true;
    const key = 'rulesSeen:' + view.team.id;
    if (App.store.get(key) || view.finished) return;
    App.store.set(key, '1');
    showRules();
  }

  // ---- mist sturen & menu ----
  $('jokerBtn').onclick = async () => {
    if (!view.jokers) return App.toast('Win een mist-joker door als eerste bij een punt te zijn!');
    const t = await choose('Naar welk team stuur je 60 seconden mist?', view.others.map(t => ({ label: '🌫️ ' + t.name, value: t })));
    if (!t) return;
    try { await App.api('/api/mist', { teamId: t.id }); App.toast(`🌫️ Mist gestuurd naar ${t.name}!`, 'good'); }
    catch (e) { App.toast(e.message, 'bad'); }
  };
  $('menuBtn').onclick = async () => {
    const c = await choose('Menu', [
      { label: '📖 Spelregels en punten', value: 'regels' },
      ...(view.finished ? [{ label: '🏆 Scorebord', value: 'score' }] : []),
      ...(compassOn ? [] : [{ label: '🧭 Kompas aanzetten', value: 'kompas' }]),
      ...(view.settings.testMode ? [{ label: '🔄 Opnieuw beginnen (testmodus)', value: 'reset' }] : []),
      { label: '🚪 Uitloggen', value: 'uit', danger: true },
    ]);
    if (c === 'regels') showRules();
    if (c === 'score') location.href = '/scorebord';
    if (c === 'kompas') enableCompass();
    if (c === 'reset' && await choose('Alle punten en de score van jullie team wissen en opnieuw beginnen?', [{ label: '🔄 Ja, opnieuw beginnen', value: 1, danger: true }]) === 1) {
      try { await App.api('/api/restart', {}); App.toast('🔄 Jullie beginnen opnieuw bij het eerste punt', 'good'); } catch (e) { App.toast(e.message, 'bad'); }
    }
    if (c === 'uit' && await choose(`Uitloggen als ${view.team.name}? Je kunt daarna weer inloggen met het wachtwoord.`, [{ label: '🚪 Ja, uitloggen', value: 1, danger: true }]) === 1) {
      App.store.set('teamToken', null); location.href = '/';
    }
  };
})();
