'use strict';

/* ======================================================================
   Rancune Counter – houdt bij wie jou het meest schade doet in Commander.
   Alle gegevens staan lokaal op het toestel (localStorage), er is geen server.
   ====================================================================== */

/* ---------- Configuratie ---------- */
const TYPES = [
  { id: 'normal',    label: 'Gewoon',    lethal: null },
  { id: 'commander', label: 'Commander', lethal: 21 },
  { id: 'toxic',     label: 'Toxic',     lethal: 10 },
];

// Rancune-score = gemiddelde punten per potje dat je samen speelde.
const WEIGHT = { normal: 1, commander: 2, toxic: 3, first: 10, last: 15 };
const LEVELS = [
  [70, 'Aartsvijand'],
  [45, 'Vendetta'],
  [25, 'Wrokkig'],
  [10, 'Lichte irritatie'],
  [0,  'Vredelievend'],
];
const BAR_MAX = 80; // score waarbij de balk vol is

const OUTCOMES = { won: 'Gewonnen', lost: 'Verloren', stopped: 'Gestopt' };

const API = 'api/index.php';
const SYNC_RETRY_MS = 15000;
const REFRESH_MIN_MS = 60000; // minimaal zo lang tussen twee verversingen vanaf de server

/* ---------- Hulpjes ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const typeOf = (id) => TYPES.find((t) => t.id === id);
const fmtDate = (t) => new Date(t).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const levelOf = (score) => LEVELS.find(([min]) => score >= min)[1];
// Gedeelde schade geeft halve getallen: die tonen we met een komma, hele getallen zonder.
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

/* ---------- Opslag ---------- */
function isValid(d) {
  return !!d && Array.isArray(d.players) && Array.isArray(d.games)
    && d.players.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    && d.games.every((g) => g && typeof g.id === 'string' && typeof g.start === 'number'
      && Array.isArray(g.opponents) && Array.isArray(g.events)
      && g.events.every((e) => e && typeof e.p === 'string' && typeof e.t === 'number'
        && typeof e.n === 'number' && e.n > 0 && typeOf(e.type)));
}

const lsGet = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
};
const lsSet = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
};
const lsDel = (key) => { try { localStorage.removeItem(key); } catch (e) { /* geblokkeerd */ } };

// De server is leidend; lokaal staat een kopie per account (zodat de app ook zonder bereik werkt)
// plus de lijst met wijzigingen die nog niet online staan.
const LS = {
  last: 'rancune.last',
  settings: 'rancune.settings',
  data: (uid) => `rancune.data.${uid}`,
  pending: (uid) => `rancune.pending.${uid}`,
  prank: (uid) => `rancune.prank.${uid}`,
};

let db = { players: [], games: [] };
const ui = { tab: 'game', picked: null, newName: '', sync: 'idle', syncMsg: '', authUser: '' };

// De admin-grap: namen (kleine letters) waarvan de schade door 2 gedeeld wordt, en voor een admin
// de eigen instelling. Komt van de server en wordt bewaard zodat het ook offline werkt.
let prank = { names: [], mine: null };

/* ---------- Instellingen en scherm aanhouden ---------- */
// Voorkeuren van dit toestel; ze horen niet bij het account en gaan dus niet online.
const settings = () => {
  const s = lsGet(LS.settings);
  return { keepAwake: true, ...(s || {}) };
};
const setSetting = (key, value) => lsSet(LS.settings, { ...settings(), [key]: value });

let wakeLock = null;
let wakeLockPending = false;

/** Houdt het scherm aan zolang er een potje open staat (en de schakelaar aan is). */
async function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const want = settings().keepAwake && auth.status === 'in' && !!openGame() && document.visibilityState === 'visible';
  if (want && !wakeLock && !wakeLockPending) {
    wakeLockPending = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      // Android geeft de blokkade vrij zodra de app naar de achtergrond gaat; dan opnieuw aanvragen bij terugkomst.
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null; // bijvoorbeeld energiebesparing aan: dan gaat het scherm gewoon uit
    } finally {
      wakeLockPending = false;
    }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', syncWakeLock);

/* ---------- Domeinlogica ---------- */
const playerName = (id) => (db.players.find((p) => p.id === id) || { name: '?' }).name;
const openGame = () => db.games.find((g) => !g.end);
const firstHit = (g) => (g.events.length ? g.events[0].p : null);
const lastHit = (g) => (g.events.length ? g.events[g.events.length - 1].p : null);

/** Schade per tegenstander in één potje: { pid: { normal, commander, toxic } } */
function gameTotals(g) {
  const out = {};
  g.opponents.forEach((pid) => { out[pid] = { normal: 0, commander: 0, toxic: 0 }; });
  g.events.forEach((e) => {
    if (!out[e.p]) out[e.p] = { normal: 0, commander: 0, toxic: 0 };
    out[e.p][e.type] += e.n;
  });
  return out;
}

function addPlayer(name) {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const existing = db.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const p = { id: uid(), name: clean };
  db.players.push(p);
  return p;
}

/** Telt de schade van deze tegenstander maar half (admin-grap)? */
const prankApplies = (pid) => prank.names.includes(playerName(pid).trim().toLowerCase());

function addDamage(g, pid, type, n) {
  const last = g.events[g.events.length - 1];
  // Opeenvolgende tikken op dezelfde knop vloeien samen tot één regel in de tijdlijn.
  if (last && last.p === pid && last.type === type) {
    last.n += n;
  } else {
    g.events.push({ id: uid(), t: Date.now(), p: pid, type, n });
  }
}

function removeDamage(g, pid, type, step = 1) {
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e.p === pid && e.type === type) {
      e.n -= step;
      if (e.n <= 0.0001) g.events.splice(i, 1);
      return;
    }
  }
}

/** Statistieken per tegenstander over alle potjes. */
function computeStats() {
  const map = new Map();
  db.players.forEach((p) => map.set(p.id, {
    player: p, games: 0, normal: 0, commander: 0, toxic: 0, first: 0, last: 0, points: 0, score: 0,
  }));

  db.games.forEach((g) => {
    if (!g.end && !g.events.length) return; // net gestart, nog niets gebeurd
    g.opponents.forEach((pid) => { if (map.has(pid)) map.get(pid).games += 1; });
    g.events.forEach((e) => { if (map.has(e.p)) map.get(e.p)[e.type] += e.n; });
    const f = firstHit(g);
    const l = lastHit(g);
    if (f && map.has(f)) map.get(f).first += 1;
    if (l && map.has(l)) map.get(l).last += 1;
  });

  map.forEach((s) => {
    s.points = s.normal * WEIGHT.normal + s.commander * WEIGHT.commander + s.toxic * WEIGHT.toxic
      + s.first * WEIGHT.first + s.last * WEIGHT.last;
    s.score = s.games ? Math.round(s.points / s.games) : 0;
  });
  return [...map.values()];
}

/* ---------- Account en online synchronisatie ---------- */
const auth = { status: 'loading', user: null, expiresAt: 0, error: '', busy: false, expired: false };
const SYNC_BATCH = 100;

async function api(action, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}?action=${action}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* geen JSON, bijvoorbeeld een serverfout */ }
  return { status: res.status, data };
}

// Wijzigingen die nog niet op de server staan. Elke wijziging krijgt een volgnummer, zodat een
// wijziging tijdens het versturen niet per ongeluk als "klaar" wordt afgevinkt.
const emptyPending = () => ({ seq: 0, players: {}, games: {}, delPlayers: [], delGames: [] });
let pending = emptyPending();
let snapshot = new Map(); // 'p:<id>' / 'g:<id>' -> JSON zoals laatst gezien, om wijzigingen te herkennen
const pendingCount = () => Object.keys(pending.players).length + Object.keys(pending.games).length
  + pending.delPlayers.length + pending.delGames.length;

function loadPending(uid) {
  const p = lsGet(LS.pending(uid));
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  if (!p) return emptyPending();
  return {
    seq: Number(p.seq) || 0, players: obj(p.players), games: obj(p.games),
    delPlayers: arr(p.delPlayers), delGames: arr(p.delGames),
  };
}

function rebuildSnapshot() {
  snapshot = new Map();
  db.players.forEach((p) => snapshot.set(`p:${p.id}`, JSON.stringify(p)));
  db.games.forEach((g) => snapshot.set(`g:${g.id}`, JSON.stringify(g)));
}

/** Vergelijkt de huidige gegevens met de laatst geziene stand en noteert wat er nieuw, gewijzigd of weg is. */
function markChanges() {
  const seen = new Set();
  const check = (prefix, item, bucket, delList) => {
    const key = `${prefix}:${item.id}`;
    const json = JSON.stringify(item);
    seen.add(key);
    if (snapshot.get(key) === json) return;
    snapshot.set(key, json);
    pending[bucket][item.id] = ++pending.seq;
    pending[delList] = pending[delList].filter((id) => id !== item.id);
  };
  db.players.forEach((p) => check('p', p, 'players', 'delPlayers'));
  db.games.forEach((g) => check('g', g, 'games', 'delGames'));
  [...snapshot.keys()].forEach((key) => {
    if (seen.has(key)) return;
    snapshot.delete(key);
    const id = key.slice(2);
    const [bucket, delList] = key[0] === 'p' ? ['players', 'delPlayers'] : ['games', 'delGames'];
    delete pending[bucket][id];
    if (!pending[delList].includes(id)) pending[delList].push(id);
  });
}

function persistLocal() {
  if (!auth.user) return;
  const ok = lsSet(LS.data(auth.user.id), db) && lsSet(LS.pending(auth.user.id), pending);
  if (!ok) toast('Opslaan op dit toestel mislukt.');
}

/** Wordt na elke wijziging aangeroepen: lokaal bewaren en online zetten. */
function save() {
  if (!auth.user) return;
  markChanges();
  persistLocal();
  scheduleFlush(300);
}

let flushTimer = null;
let retryTimer = null;
let flushPromise = null;
let flushAgain = false;
let lastPull = 0;

const scheduleFlush = (delay) => { clearTimeout(flushTimer); flushTimer = setTimeout(flush, delay); };
const scheduleRetry = () => { clearTimeout(retryTimer); retryTimer = setTimeout(refresh, SYNC_RETRY_MS); };

function setSync(state, msg = '') {
  if (ui.sync === state && ui.syncMsg === msg) return;
  ui.sync = state;
  ui.syncMsg = msg;
  if (auth.status === 'in') render();
}

function flush() {
  if (flushPromise) { flushAgain = true; return flushPromise; }
  flushPromise = doFlush().finally(() => {
    flushPromise = null;
    if (flushAgain) { flushAgain = false; scheduleFlush(0); }
  });
  return flushPromise;
}

async function doFlush() {
  if (auth.status !== 'in' || !auth.user) return;
  if (!pendingCount()) { setSync('idle'); return; }

  const take = (obj) => Object.fromEntries(Object.entries(obj).slice(0, SYNC_BATCH));
  const sent = {
    players: take(pending.players),
    games: take(pending.games),
    delPlayers: pending.delPlayers.slice(0, SYNC_BATCH * 4),
    delGames: pending.delGames.slice(0, SYNC_BATCH * 4),
  };
  const pick = (list, ids) => Object.keys(ids).map((id) => list.find((x) => x.id === id)).filter(Boolean);

  let res = null;
  try {
    res = await api('sync', {
      method: 'POST',
      body: {
        players: pick(db.players, sent.players),
        games: pick(db.games, sent.games),
        deletePlayers: sent.delPlayers,
        deleteGames: sent.delGames,
      },
    });
  } catch (e) { /* geen verbinding */ }

  if (!res || res.status >= 500) { setSync('offline'); scheduleRetry(); return; }
  if (res.status === 401) { sessionExpired(); return; }
  if (res.status !== 200) { setSync('error', res.data.error || 'Onbekende fout.'); return; }

  Object.entries(sent.players).forEach(([id, seq]) => { if (pending.players[id] === seq) delete pending.players[id]; });
  Object.entries(sent.games).forEach(([id, seq]) => { if (pending.games[id] === seq) delete pending.games[id]; });
  pending.delPlayers = pending.delPlayers.filter((id) => !sent.delPlayers.includes(id));
  pending.delGames = pending.delGames.filter((id) => !sent.delGames.includes(id));
  persistLocal();
  setSync('idle');
  if (pendingCount()) flushAgain = true;
}

const cleanNames = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function normalizePrank(p) {
  if (!p || typeof p !== 'object') return { names: [], mine: null };
  const mine = p.mine && typeof p.mine === 'object'
    ? { enabled: !!p.mine.enabled, names: cleanNames(p.mine.names) } : null;
  return { names: cleanNames(p.names), mine };
}

function setPrank(p) {
  prank = normalizePrank(p);
  if (auth.user) lsSet(LS.prank(auth.user.id), prank);
}

/** Voegt de serverlijst en de lokale, nog niet verstuurde wijzigingen samen (lokaal wint). */
function mergeList(serverList, localList, pend, dels) {
  const out = serverList.filter((x) => !dels.includes(x.id));
  const index = new Map(out.map((x, i) => [x.id, i]));
  Object.keys(pend).forEach((id) => {
    const local = localList.find((x) => x.id === id);
    if (!local) return;
    if (index.has(id)) out[index.get(id)] = local;
    else { index.set(id, out.length); out.push(local); }
  });
  return out;
}

async function pull() {
  let res;
  try { res = await api('data'); } catch (e) { setSync('offline'); scheduleRetry(); return; }
  if (res.status === 401) { sessionExpired(); return; }
  if (res.status !== 200 || !isValid(res.data)) {
    if (res.status >= 500) { setSync('offline'); scheduleRetry(); } else setSync('error', 'Gegevens ophalen is mislukt.');
    return;
  }
  lastPull = Date.now();
  setPrank(res.data.prank);
  db = {
    players: mergeList(res.data.players, db.players, pending.players, pending.delPlayers),
    games: mergeList(res.data.games, db.games, pending.games, pending.delGames).sort((a, b) => a.start - b.start),
  };
  rebuildSnapshot();
  persistLocal();
  ui.sync = 'idle';
  ui.syncMsg = '';
  render();
}

/** Eerst wat lokaal nog open staat versturen, dan de actuele stand van de server ophalen. */
async function refresh() {
  if (auth.status !== 'in') return;
  await flush();
  if (auth.status === 'in') await pull();
}

function sessionExpired() {
  if (auth.status !== 'in') return;
  auth.status = 'out';
  auth.expired = true;
  auth.error = '';
  closeSheet();
  render();
}

async function enterSession(user, expiresAt, { offline = false } = {}) {
  auth.user = user;
  auth.expiresAt = expiresAt;
  auth.status = 'in';
  auth.expired = false;
  auth.error = '';
  auth.busy = false;
  lsSet(LS.last, { user, expiresAt });

  const cached = lsGet(LS.data(user.id));
  db = cached && isValid(cached) ? { players: cached.players, games: cached.games } : { players: [], games: [] };
  pending = loadPending(user.id);
  prank = normalizePrank(lsGet(LS.prank(user.id)));
  rebuildSnapshot();
  ui.picked = null;
  ui.sync = offline ? 'offline' : 'idle';
  ui.syncMsg = '';
  render();
  if (offline) scheduleRetry(); else await refresh();
}

function showLogin(expired) {
  auth.status = 'out';
  auth.expired = expired;
  render();
}

async function boot() {
  const last = lsGet(LS.last);
  let res = null;
  try { res = await api('me'); } catch (e) { /* geen verbinding */ }

  if (res && res.status === 200) { await enterSession(res.data.user, res.data.expiresAt); return; }
  if (res && res.status === 401) { showLogin(!!last); return; }

  // Server niet bereikbaar: werk door als de laatst bekende sessie nog geldig is.
  if (last && last.user && Date.now() < last.expiresAt * 1000) {
    await enterSession(last.user, last.expiresAt, { offline: true });
  } else {
    auth.error = 'De server is niet bereikbaar. Probeer het later opnieuw.';
    showLogin(!!last);
  }
}

async function logout() {
  await flush();
  try {
    await api('logout', { method: 'POST', body: {} });
  } catch (e) {
    toast('Geen verbinding: uitloggen is niet gelukt.');
    return;
  }
  const uid = auth.user && auth.user.id;
  lsDel(LS.last);
  if (uid) lsDel(LS.prank(uid));
  prank = { names: [], mine: null };
  // Wijzigingen die nog niet online staan blijven bewaard tot dit account weer inlogt.
  if (uid && !pendingCount()) { lsDel(LS.data(uid)); lsDel(LS.pending(uid)); }
  auth.user = null;
  auth.status = 'out';
  auth.expired = false;
  auth.error = '';
  db = { players: [], games: [] };
  pending = emptyPending();
  snapshot = new Map();
  Object.assign(ui, { tab: 'game', picked: null, newName: '', sync: 'idle', syncMsg: '', prankNames: undefined });
  closeSheet();
  render();
}

/* ---------- Schermen ---------- */
function viewLogin() {
  const notice = auth.expired
    ? '<p class="notice">Je sessie is verlopen. Log opnieuw in om verder te gaan; wat nog niet online stond blijft op dit toestel bewaard.</p>'
    : '';
  return `
    <div class="auth">
      <img class="logo" src="icons/icon-192.png" alt="" width="72" height="72">
      <h1>Rancune Counter</h1>
      <p class="muted">Log in met je Exploding Kraken-account. Je blijft 24 uur ingelogd.</p>
      ${notice}
      <form id="auth-form" novalidate>
        <label>E-mailadres of gebruikersnaam (beheerder)
          <input name="identifier" type="text" inputmode="email" autocomplete="username" autocapitalize="none"
                 spellcheck="false" maxlength="180" required value="${esc(ui.authUser || '')}">
        </label>
        <label>Wachtwoord
          <input name="password" type="password" autocomplete="current-password" maxlength="200" required>
        </label>
        ${auth.error ? `<p class="error" role="alert">${esc(auth.error)}</p>` : ''}
        <button class="primary wide" type="submit" ${auth.busy ? 'disabled' : ''}>${auth.busy ? 'Bezig…' : 'Inloggen'}</button>
      </form>
    </div>`;
}

function syncBanner() {
  const n = pendingCount();
  if (ui.sync === 'offline') {
    return `<p class="banner warn">Geen verbinding. Je werkt verder op dit toestel${n
      ? `; ${n} wijziging${n === 1 ? ' wordt' : 'en worden'} opgeslagen zodra je weer online bent` : ''}.</p>`;
  }
  if (ui.sync === 'error') return `<p class="banner err">Online opslaan lukt niet: ${esc(ui.syncMsg)}</p>`;
  return '';
}

function viewGame() {
  const g = openGame();
  return g ? viewActiveGame(g) : viewNewGame();
}

function viewNewGame() {
  if (!ui.picked) {
    const prev = db.games[db.games.length - 1];
    ui.picked = new Set(prev ? prev.opponents.filter((id) => db.players.some((p) => p.id === id)) : []);
  }
  const chips = db.players.length
    ? db.players.map((p) =>
      `<button class="chip ${ui.picked.has(p.id) ? 'on' : ''}" data-a="toggle" data-id="${p.id}">${esc(p.name)}</button>`).join('')
    : '<p class="muted">Nog geen spelers. Voeg hieronder de mensen aan tafel toe.</p>';
  const n = ui.picked.size;

  return `
    <h1>Nieuw potje</h1>
    <p class="muted">Wie zitten er aan tafel, behalve jij?</p>
    <div class="chips">${chips}</div>
    <div class="add-row">
      <input id="new-name" type="text" maxlength="24" placeholder="Nieuwe speler" autocomplete="off" value="${esc(ui.newName)}">
      <button data-a="add-player">Toevoegen</button>
    </div>
    <button class="primary wide" data-a="start" ${n ? '' : 'disabled'}>
      ${n ? `Start potje met ${n} tegenstander${n === 1 ? '' : 's'}` : 'Kies minstens één tegenstander'}
    </button>`;
}

function viewActiveGame(g) {
  const totals = gameTotals(g);
  const f = firstHit(g);
  const l = lastHit(g);

  const cards = g.opponents.map((pid) => {
    const t = totals[pid];
    const tags = (pid === f ? '<span class="tag first">Eerste klap</span>' : '')
      + (pid === l ? '<span class="tag last">Laatste klap</span>' : '');
    const half = prankApplies(pid);
    const d = half ? 2 : 1;
    const rows = TYPES.map((type) => {
      const v = t[type.id];
      const lethal = type.lethal && v >= type.lethal;
      return `
        <div class="row t-${type.id}">
          <span class="lbl">${type.label}</span>
          <button class="step" data-a="dec" data-p="${pid}" data-t="${type.id}" aria-label="Eén ${type.label} minder" ${v ? '' : 'disabled'}>−</button>
          <output class="num ${lethal ? 'lethal' : ''}">${fmtNum(v)}${type.lethal ? `<small>/${type.lethal}</small>` : ''}</output>
          <button class="step plus" data-a="inc" data-n="1" data-p="${pid}" data-t="${type.id}" aria-label="${type.label} +${fmtNum(1 / d)}">+${fmtNum(1 / d)}</button>
          <button class="step plus" data-a="inc" data-n="5" data-p="${pid}" data-t="${type.id}" aria-label="${type.label} +${fmtNum(5 / d)}">+${fmtNum(5 / d)}</button>
        </div>`;
    }).join('');
    const rule = half
      ? `<p class="prank-note">⚖️ <b>Admin-regel:</b> alle schade van ${esc(playerName(pid))} wordt door 2 gedeeld.</p>`
      : '';
    return `
      <section class="card opp ${half ? 'prank' : ''}">
        <header><h3>${esc(playerName(pid))}</h3><span class="tags">${tags}</span></header>
        ${rule}
        ${rows}
      </section>`;
  }).join('');

  return `
    <div class="topline">
      <div>
        <h1>Potje bezig</h1>
        <p class="muted">Gestart om ${fmtTime(g.start)} · schade die jij ontvangt</p>
      </div>
      <button class="primary" data-a="finish-open">Afronden</button>
    </div>
    <p class="summary">
      <span>Eerste klap: <b>${f ? esc(playerName(f)) : '–'}</b></span>
      <span>Laatste klap: <b>${l ? esc(playerName(l)) : '–'}</b></span>
    </p>
    ${cards}`;
}

function viewRancune() {
  const rows = computeStats().filter((s) => s.games > 0)
    .sort((a, b) => b.score - a.score || b.points - a.points);

  if (!rows.length) {
    return `<h1>Rancune</h1>
      <div class="empty">Nog geen data.<br>Speel een potje en tik de schade aan die je ontvangt.</div>`;
  }

  const top = rows[0];
  const list = rows.map((s, i) => `
    <button class="card rank" data-a="player" data-id="${s.player.id}">
      <div class="rank-head">
        <span class="pos">${i + 1}</span>
        <span class="who"><b>${esc(s.player.name)}</b><small>${levelOf(s.score)}</small></span>
        <span class="score">${s.score}</span>
      </div>
      <div class="bar"><i style="width:${Math.min(100, (s.score / BAR_MAX) * 100)}%"></i></div>
      <small class="muted">${s.games} potje${s.games === 1 ? '' : 's'} · eerste klap ${s.first}× · laatste klap ${s.last}×</small>
    </button>`).join('');

  return `
    <h1>Rancune</h1>
    <div class="hero">
      <small>Grootste haatzaaier</small>
      <strong>${esc(top.player.name)}</strong>
      <span>rancune-score ${top.score} · ${levelOf(top.score)}</span>
    </div>
    ${list}
    <details class="info">
      <summary>Hoe wordt de score berekend?</summary>
      <p>Per potje dat je samen speelde krijgt een tegenstander punten voor de schade die hij jou doet:
      gewoon ×${WEIGHT.normal}, commander ×${WEIGHT.commander}, toxic ×${WEIGHT.toxic}.
      Daarbovenop ${WEIGHT.first} punten voor de eerste klap en ${WEIGHT.last} voor de laatste klap in een potje.
      De rancune-score is het gemiddelde aantal punten per potje.</p>
    </details>`;
}

function sumTypes(events) {
  const s = { dmg: 0, toxic: 0 };
  events.forEach((e) => { if (e.type === 'toxic') s.toxic += e.n; else s.dmg += e.n; });
  return s;
}

function viewHistory() {
  const games = [...db.games].reverse();
  if (!games.length) {
    return `<h1>Historie</h1><div class="empty">Nog geen potjes gespeeld.</div>`;
  }
  const items = games.map((g) => {
    const s = sumTypes(g.events);
    const f = firstHit(g);
    const l = lastHit(g);
    const badge = g.end
      ? `<span class="badge ${g.outcome || 'stopped'}">${OUTCOMES[g.outcome] || 'Afgerond'}</span>`
      : '<span class="badge live">Bezig</span>';
    return `
      <button class="card hist" data-a="game" data-id="${g.id}">
        <div class="hist-head"><b>${fmtDate(g.start)}</b>${badge}</div>
        <small class="muted">${g.opponents.map((id) => esc(playerName(id))).join(', ')}</small>
        <small>Ontvangen: ${fmtNum(s.dmg)} schade${s.toxic ? ` · ${fmtNum(s.toxic)} toxic` : ''}</small>
        <small class="muted">Eerste: ${f ? esc(playerName(f)) : '–'} · Laatste: ${l ? esc(playerName(l)) : '–'}</small>
      </button>`;
  }).join('');
  return `<h1>Historie</h1>${items}`;
}

/** De grap-instelling: alleen zichtbaar voor beheerders (de server dwingt dit ook af). */
function viewPrankCard() {
  if (!auth.user || auth.user.role !== 'admin') return '';
  const mine = prank.mine || { enabled: false, names: [] };
  const draft = ui.prankNames !== undefined ? ui.prankNames
    : (mine.names.length ? mine.names.join(', ') : auth.user.name.split(' ')[0]);
  return `
    <section class="card prank-card">
      <div class="switch-row">
        <div>
          <h3>Grap: schade door 2</h3>
          <p class="muted">Zolang dit aan staat telt schade die anderen voor jou invoeren maar half, en zien ze dat heel duidelijk. Alleen beheerders zien dit.</p>
        </div>
        <button class="switch ${mine.enabled ? 'on' : ''}" role="switch" aria-checked="${mine.enabled}" aria-label="Grap aan of uit" data-a="prank-toggle"><i></i></button>
      </div>
      <label class="field">Zo noemen anderen jou (gescheiden door komma's)
        <input id="prank-names" type="text" maxlength="120" autocomplete="off" value="${esc(draft)}">
      </label>
      <div class="btns"><button data-a="prank-save">Namen opslaan</button></div>
      <p class="muted">${mine.enabled
    ? `Staat <b>aan</b> voor: ${mine.names.map(esc).join(', ')}`
    : 'Staat uit.'}</p>
    </section>`;
}

function viewMore() {
  const events = db.games.reduce((n, g) => n + g.events.length, 0);
  const awake = settings().keepAwake;
  const awakeNote = 'wakeLock' in navigator
    ? 'Het scherm gaat niet uit zolang er een potje bezig is. Kost wat extra batterij.'
    : 'Deze browser ondersteunt dit niet; het scherm gaat gewoon uit volgens je telefooninstellingen.';
  const n = pendingCount();
  const syncLine = ui.sync === 'offline' ? 'Geen verbinding.'
    : ui.sync === 'error' ? `Online opslaan lukt niet: ${esc(ui.syncMsg)}`
      : n ? 'Bezig met opslaan…' : 'Alles staat online.';
  const until = new Date(auth.expiresAt * 1000)
    .toLocaleString('nl-NL', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  return `
    <h1>Meer</h1>
    <section class="card">
      <h3>Account</h3>
      <p>Ingelogd als <b>${esc(auth.user.name)}</b></p>
      <p class="muted">Je sessie verloopt ${until}. ${syncLine}${n ? ` (${n} wijziging${n === 1 ? '' : 'en'} wachten)` : ''}</p>
      <button data-a="logout">Uitloggen</button>
    </section>
    ${viewPrankCard()}
    <section class="card">
      <div class="switch-row">
        <div>
          <h3>Scherm aanhouden</h3>
          <p class="muted">${awakeNote}</p>
        </div>
        <button class="switch ${awake ? 'on' : ''}" role="switch" aria-checked="${awake}" aria-label="Scherm aanhouden" data-a="toggle-awake"><i></i></button>
      </div>
    </section>
    <section class="card">
      <h3>Back-up</h3>
      <p class="muted">Je gegevens staan online bij je account. Een back-up is optioneel, bijvoorbeeld om te bewaren of mee te nemen.</p>
      <div class="btns">
        <button data-a="export">Back-up opslaan</button>
        <button data-a="import">Back-up terugzetten</button>
      </div>
    </section>
    <section class="card">
      <h3>Opgeslagen</h3>
      <p class="muted">${db.players.length} spelers · ${db.games.length} potjes · ${events} schade-registraties</p>
      <button class="danger" data-a="reset">Alles wissen</button>
    </section>`;
}

function render() {
  document.body.classList.toggle('locked', auth.status !== 'in');
  if (auth.status !== 'in') {
    $('#view').innerHTML = auth.status === 'loading' ? '<div class="empty">Laden…</div>' : viewLogin();
    syncWakeLock();
    return;
  }
  const views = { game: viewGame, rancune: viewRancune, history: viewHistory, more: viewMore };
  $('#view').innerHTML = syncBanner() + views[ui.tab]();
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === ui.tab);
    b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false');
  });
  syncWakeLock();
}

/* ---------- Sheets (pop-ups onderin) ---------- */
function openSheet(html) {
  $('#sheet-root').innerHTML = `<div class="backdrop" data-a="close-sheet"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const input = $('#sheet-root input');
  if (input) { input.focus(); input.select(); }
}
const closeSheet = () => { $('#sheet-root').innerHTML = ''; };

function confirmSheet(title, text, action, label, data = '') {
  openSheet(`
    <h2>${title}</h2>
    <p class="muted">${text}</p>
    <div class="btns">
      <button class="danger" data-a="${action}" ${data}>${label}</button>
      <button data-a="close-sheet">Annuleren</button>
    </div>`);
}

function sheetPlayer(id) {
  const st = computeStats().find((s) => s.player.id === id);
  if (!st) return;
  const pct = (n) => (st.games ? `${Math.round((100 * n) / st.games)}%` : '–');
  openSheet(`
    <h2>${esc(st.player.name)}</h2>
    <p class="muted">${levelOf(st.score)}</p>
    <div class="big">${st.score}<small>rancune-score</small></div>
    <dl class="grid">
      <div><dt>Potjes samen</dt><dd>${st.games}</dd></div>
      <div><dt>Gewone schade</dt><dd>${fmtNum(st.normal)}</dd></div>
      <div><dt>Commander-schade</dt><dd>${fmtNum(st.commander)}</dd></div>
      <div><dt>Toxic-tellers</dt><dd>${fmtNum(st.toxic)}</dd></div>
      <div><dt>Eerste klap</dt><dd>${st.first}× <small>${pct(st.first)}</small></dd></div>
      <div><dt>Laatste klap</dt><dd>${st.last}× <small>${pct(st.last)}</small></dd></div>
    </dl>
    <p class="muted calc">${fmtNum(st.normal)}×${WEIGHT.normal} + ${fmtNum(st.commander)}×${WEIGHT.commander} + ${fmtNum(st.toxic)}×${WEIGHT.toxic}
      + ${st.first}×${WEIGHT.first} + ${st.last}×${WEIGHT.last} = ${fmtNum(st.points)} punten ÷ ${st.games} potjes</p>
    <div class="btns">
      <button data-a="rename" data-id="${id}">Naam wijzigen</button>
      <button data-a="close-sheet">Sluiten</button>
    </div>`);
}

function sheetGame(id) {
  const g = db.games.find((x) => x.id === id);
  if (!g) return;
  const totals = gameTotals(g);
  const f = firstHit(g);
  const l = lastHit(g);
  const table = g.opponents.map((pid) => {
    const t = totals[pid];
    return `<tr><td>${esc(playerName(pid))}</td><td>${fmtNum(t.normal)}</td><td>${fmtNum(t.commander)}</td><td>${fmtNum(t.toxic)}</td></tr>`;
  }).join('');
  const timeline = g.events.length
    ? g.events.map((e) => `
        <li class="t-${e.type}"><time>${fmtTime(e.t)}</time>
        <span>${esc(playerName(e.p))}</span><b>${typeOf(e.type).label} ${fmtNum(e.n)}</b></li>`).join('')
    : '<li class="muted">Geen schade ontvangen.</li>';
  openSheet(`
    <h2>${fmtDate(g.start)}</h2>
    <p class="muted">${fmtTime(g.start)}${g.end ? ` – ${fmtTime(g.end)}` : ' · bezig'}${g.outcome ? ` · ${OUTCOMES[g.outcome]}` : ''}</p>
    <p class="summary">
      <span>Eerste klap: <b>${f ? esc(playerName(f)) : '–'}</b></span>
      <span>Laatste klap: <b>${l ? esc(playerName(l)) : '–'}</b></span>
    </p>
    <table><thead><tr><th>Speler</th><th>Gewoon</th><th>Cmdr</th><th>Toxic</th></tr></thead><tbody>${table}</tbody></table>
    <h3>Verloop</h3>
    <ol class="timeline">${timeline}</ol>
    <div class="btns">
      <button class="danger" data-a="delete-game" data-id="${id}">Verwijderen</button>
      <button data-a="close-sheet">Sluiten</button>
    </div>`);
}

function sheetFinish() {
  openSheet(`
    <h2>Potje afronden</h2>
    <p class="muted">Hoe liep het af?</p>
    <div class="btns col">
      <button class="primary" data-a="finish" data-outcome="won">Gewonnen</button>
      <button data-a="finish" data-outcome="lost">Verloren</button>
      <button data-a="finish" data-outcome="stopped">Gestopt / geen winnaar</button>
      <button class="danger" data-a="discard">Potje weggooien</button>
      <button data-a="close-sheet">Terug naar het potje</button>
    </div>`);
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- Back-up ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify({ v: 1, players: db.players, games: db.games }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rancune-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let pendingImport = null;
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!isValid(d)) throw new Error('ongeldig');
      pendingImport = d;
      confirmSheet('Back-up terugzetten?',
        `Dit bestand bevat ${d.players.length} spelers en ${d.games.length} potjes. `
        + 'Je huidige gegevens op deze telefoon worden daarmee vervangen.',
        'import-confirm', 'Vervang mijn gegevens');
    } catch (e) {
      toast('Dat is geen geldige back-up.');
    }
  };
  reader.readAsText(file);
}

/* ---------- Acties ---------- */
const parseNames = (s) => s.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);

async function savePrankSettings(enabled, names) {
  if (enabled && !names.length) { toast('Vul eerst minstens één naam in.'); return; }
  try {
    const res = await api('prank', { method: 'POST', body: { enabled, names } });
    if (res.status === 401) { sessionExpired(); return; }
    if (res.status !== 200) { toast(res.data.error || 'Opslaan mislukt.'); return; }
    setPrank({ names: prank.names, mine: res.data.mine });
    ui.prankNames = undefined;
    render();
    toast(enabled ? 'De grap staat AAN.' : 'De grap staat uit.');
  } catch (e) {
    toast('Geen verbinding: opslaan mislukt.');
  }
}

const actions = {
  'prank-toggle'() {
    const mine = prank.mine || { enabled: false };
    return savePrankSettings(!mine.enabled, parseNames($('#prank-names').value));
  },

  'prank-save'() {
    const mine = prank.mine || { enabled: false };
    return savePrankSettings(mine.enabled, parseNames($('#prank-names').value));
  },

  tab(el) {
    ui.tab = el.dataset.tab;
    render();
    window.scrollTo(0, 0);
  },

  toggle(el) {
    const id = el.dataset.id;
    if (ui.picked.has(id)) ui.picked.delete(id); else ui.picked.add(id);
    render();
  },

  'add-player'() {
    const p = addPlayer(ui.newName);
    if (!p) { toast('Vul eerst een naam in.'); return; }
    ui.picked = ui.picked || new Set();
    ui.picked.add(p.id);
    ui.newName = '';
    save();
    render();
  },

  start() {
    if (!ui.picked || !ui.picked.size) return;
    db.games.push({
      id: uid(), start: Date.now(), end: null, outcome: null,
      opponents: [...ui.picked], events: [],
    });
    ui.picked = null;
    save();
    render();
  },

  inc(el) {
    const g = openGame();
    if (!g) return;
    const amount = Number(el.dataset.n);
    const half = prankApplies(el.dataset.p);
    addDamage(g, el.dataset.p, el.dataset.t, half ? amount / 2 : amount);
    if (half) toast(`Admin-regel: ${amount} schade telt als ${fmtNum(amount / 2)}`);
    if (navigator.vibrate) navigator.vibrate(half ? [12, 60, 12] : 12);
    save();
    render();
  },

  dec(el) {
    const g = openGame();
    if (!g) return;
    removeDamage(g, el.dataset.p, el.dataset.t, prankApplies(el.dataset.p) ? 0.5 : 1);
    save();
    render();
  },

  'finish-open': sheetFinish,

  finish(el) {
    const g = openGame();
    if (!g) return;
    g.end = Date.now();
    g.outcome = el.dataset.outcome;
    save();
    closeSheet();
    ui.tab = 'rancune';
    render();
    toast('Potje opgeslagen.');
  },

  discard() {
    confirmSheet('Potje weggooien?', 'Alle schade van dit potje wordt verwijderd en telt niet mee in de statistieken.',
      'discard-confirm', 'Ja, weggooien');
  },

  'discard-confirm'() {
    db.games = db.games.filter((g) => g.end);
    save();
    closeSheet();
    render();
  },

  player(el) { sheetPlayer(el.dataset.id); },

  rename(el) {
    const id = el.dataset.id;
    openSheet(`
      <h2>Naam wijzigen</h2>
      <input id="rename-input" type="text" maxlength="24" autocomplete="off" value="${esc(playerName(id))}">
      <div class="btns">
        <button class="primary" data-a="rename-save" data-id="${id}">Opslaan</button>
        <button data-a="close-sheet">Annuleren</button>
      </div>`);
  },

  'rename-save'(el) {
    const name = $('#rename-input').value.trim().replace(/\s+/g, ' ');
    const clash = db.players.some((p) => p.id !== el.dataset.id && p.name.toLowerCase() === name.toLowerCase());
    if (!name) { toast('Een naam mag niet leeg zijn.'); return; }
    if (clash) { toast('Die naam bestaat al.'); return; }
    db.players.find((p) => p.id === el.dataset.id).name = name;
    save();
    closeSheet();
    render();
  },

  game(el) { sheetGame(el.dataset.id); },

  'delete-game'(el) {
    confirmSheet('Potje verwijderen?', 'Dit potje verdwijnt uit de historie en uit de statistieken.',
      'delete-game-confirm', 'Ja, verwijderen', `data-id="${el.dataset.id}"`);
  },

  'delete-game-confirm'(el) {
    db.games = db.games.filter((g) => g.id !== el.dataset.id);
    save();
    closeSheet();
    render();
  },

  'toggle-awake'() {
    setSetting('keepAwake', !settings().keepAwake);
    render();
  },

  logout,

  export: exportData,
  import() { $('#import-file').click(); },

  'import-confirm'() {
    if (!pendingImport) return;
    db = { players: pendingImport.players, games: pendingImport.games };
    pendingImport = null;
    ui.picked = null;
    save();
    closeSheet();
    render();
    toast('Back-up teruggezet.');
  },

  reset() {
    confirmSheet('Alles wissen?', 'Alle spelers, potjes en statistieken worden verwijderd, ook online. Dit kan niet ongedaan worden gemaakt – maak eerst een back-up.',
      'reset-confirm', 'Ja, alles wissen');
  },

  'reset-confirm'() {
    db = { players: [], games: [] };
    ui.picked = null;
    save();
    closeSheet();
    render();
  },

  'close-sheet': closeSheet,
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  // Een tik op de donkere achtergrond sluit de sheet; een tik in de sheet niet.
  if (el.classList.contains('backdrop') && e.target !== el) return;
  if (el.disabled) return;
  const fn = actions[el.dataset.a];
  if (fn) fn(el, e);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'new-name') ui.newName = e.target.value;
  if (e.target.name === 'identifier') ui.authUser = e.target.value;
  if (e.target.id === 'prank-names') ui.prankNames = e.target.value;
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'auth-form') return;
  e.preventDefault();
  if (auth.busy) return;
  const form = new FormData(e.target);
  const identifier = String(form.get('identifier') || '').trim();
  const password = String(form.get('password') || '');
  ui.authUser = identifier;
  if (!identifier || !password) {
    auth.error = 'Vul je e-mailadres en wachtwoord in.';
    render();
    return;
  }
  auth.busy = true;
  auth.error = '';
  render();
  try {
    const res = await api('login', { method: 'POST', body: { identifier, password } });
    if (res.status === 200) { await enterSession(res.data.user, res.data.expiresAt); return; }
    auth.error = res.data.error || 'Inloggen is niet gelukt.';
  } catch (err) {
    auth.error = 'Geen verbinding. Probeer het opnieuw.';
  }
  auth.busy = false;
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'new-name') actions['add-player']();
  if (e.target.id === 'rename-input') actions['rename-save']($('[data-a="rename-save"]'));
});

$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importData(file);
});

/* ---------- Start ---------- */
// Terug online, of de app komt weer in beeld: wijzigingen versturen en de stand van de server ophalen.
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || auth.status !== 'in') return;
  if (Date.now() >= auth.expiresAt * 1000) { sessionExpired(); return; }
  if (pendingCount() || Date.now() - lastPull > REFRESH_MIN_MS) refresh();
});
// De login verloopt na 24 uur, ook als de app open blijft staan of geen verbinding heeft.
setInterval(() => {
  if (auth.status === 'in' && Date.now() >= auth.expiresAt * 1000) sessionExpired();
}, 30000);

render();
boot();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
