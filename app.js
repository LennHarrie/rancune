'use strict';

/* ======================================================================
   Rancune Counter – houdt bij wie jou het meest schade doet in Commander.
   Alle gegevens staan lokaal op het toestel (localStorage), er is geen server.
   ====================================================================== */

/* ---------- Configuratie ---------- */
const STORE_KEY = 'rancune.v1';

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

/* ---------- Hulpjes ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const typeOf = (id) => TYPES.find((t) => t.id === id);
const fmtDate = (t) => new Date(t).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const levelOf = (score) => LEVELS.find(([min]) => score >= min)[1];

/* ---------- Opslag ---------- */
function isValid(d) {
  return !!d && Array.isArray(d.players) && Array.isArray(d.games)
    && d.players.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    && d.games.every((g) => g && typeof g.id === 'string' && typeof g.start === 'number'
      && Array.isArray(g.opponents) && Array.isArray(g.events)
      && g.events.every((e) => e && typeof e.p === 'string' && typeof e.t === 'number'
        && typeof e.n === 'number' && e.n > 0 && typeOf(e.type)));
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (isValid(d)) return d;
    }
  } catch (e) { /* kapotte of geblokkeerde opslag: begin leeg */ }
  return { v: 1, players: [], games: [] };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (e) {
    toast('Opslaan mislukt – is je opslag vol?');
  }
}

let db = load();
const ui = { tab: 'game', picked: null, newName: '' };

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

function addDamage(g, pid, type, n) {
  const last = g.events[g.events.length - 1];
  // Opeenvolgende tikken op dezelfde knop vloeien samen tot één regel in de tijdlijn.
  if (last && last.p === pid && last.type === type) {
    last.n += n;
  } else {
    g.events.push({ id: uid(), t: Date.now(), p: pid, type, n });
  }
}

function removeDamage(g, pid, type) {
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e.p === pid && e.type === type) {
      e.n -= 1;
      if (e.n <= 0) g.events.splice(i, 1);
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

/* ---------- Schermen ---------- */
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
    const rows = TYPES.map((type) => {
      const v = t[type.id];
      const lethal = type.lethal && v >= type.lethal;
      return `
        <div class="row t-${type.id}">
          <span class="lbl">${type.label}</span>
          <button class="step" data-a="dec" data-p="${pid}" data-t="${type.id}" aria-label="Eén ${type.label} minder" ${v ? '' : 'disabled'}>−</button>
          <output class="num ${lethal ? 'lethal' : ''}">${v}${type.lethal ? `<small>/${type.lethal}</small>` : ''}</output>
          <button class="step plus" data-a="inc" data-n="1" data-p="${pid}" data-t="${type.id}" aria-label="${type.label} +1">+1</button>
          <button class="step plus" data-a="inc" data-n="5" data-p="${pid}" data-t="${type.id}" aria-label="${type.label} +5">+5</button>
        </div>`;
    }).join('');
    return `
      <section class="card opp">
        <header><h3>${esc(playerName(pid))}</h3><span class="tags">${tags}</span></header>
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
        <small>Ontvangen: ${s.dmg} schade${s.toxic ? ` · ${s.toxic} toxic` : ''}</small>
        <small class="muted">Eerste: ${f ? esc(playerName(f)) : '–'} · Laatste: ${l ? esc(playerName(l)) : '–'}</small>
      </button>`;
  }).join('');
  return `<h1>Historie</h1>${items}`;
}

function viewMore() {
  const events = db.games.reduce((n, g) => n + g.events.length, 0);
  return `
    <h1>Meer</h1>
    <section class="card">
      <h3>Back-up</h3>
      <p class="muted">Alles staat alleen op deze telefoon. Maak af en toe een back-up, dan raak je niets kwijt als je browsergegevens wist.</p>
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
  const views = { game: viewGame, rancune: viewRancune, history: viewHistory, more: viewMore };
  $('#view').innerHTML = views[ui.tab]();
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === ui.tab);
    b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false');
  });
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
      <div><dt>Gewone schade</dt><dd>${st.normal}</dd></div>
      <div><dt>Commander-schade</dt><dd>${st.commander}</dd></div>
      <div><dt>Toxic-tellers</dt><dd>${st.toxic}</dd></div>
      <div><dt>Eerste klap</dt><dd>${st.first}× <small>${pct(st.first)}</small></dd></div>
      <div><dt>Laatste klap</dt><dd>${st.last}× <small>${pct(st.last)}</small></dd></div>
    </dl>
    <p class="muted calc">${st.normal}×${WEIGHT.normal} + ${st.commander}×${WEIGHT.commander} + ${st.toxic}×${WEIGHT.toxic}
      + ${st.first}×${WEIGHT.first} + ${st.last}×${WEIGHT.last} = ${st.points} punten ÷ ${st.games} potjes</p>
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
    return `<tr><td>${esc(playerName(pid))}</td><td>${t.normal}</td><td>${t.commander}</td><td>${t.toxic}</td></tr>`;
  }).join('');
  const timeline = g.events.length
    ? g.events.map((e) => `
        <li class="t-${e.type}"><time>${fmtTime(e.t)}</time>
        <span>${esc(playerName(e.p))}</span><b>${typeOf(e.type).label} ${e.n}</b></li>`).join('')
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
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
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
const actions = {
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
    addDamage(g, el.dataset.p, el.dataset.t, Number(el.dataset.n));
    if (navigator.vibrate) navigator.vibrate(12);
    save();
    render();
  },

  dec(el) {
    const g = openGame();
    if (!g) return;
    removeDamage(g, el.dataset.p, el.dataset.t);
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

  export: exportData,
  import() { $('#import-file').click(); },

  'import-confirm'() {
    if (!pendingImport) return;
    db = pendingImport;
    pendingImport = null;
    ui.picked = null;
    save();
    closeSheet();
    render();
    toast('Back-up teruggezet.');
  },

  reset() {
    confirmSheet('Alles wissen?', 'Alle spelers, potjes en statistieken worden verwijderd. Dit kan niet ongedaan worden gemaakt – maak eerst een back-up.',
      'reset-confirm', 'Ja, alles wissen');
  },

  'reset-confirm'() {
    db = { v: 1, players: [], games: [] };
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
render();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
