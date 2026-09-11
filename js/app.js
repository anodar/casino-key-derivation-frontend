const params = new URLSearchParams(location.search);
const CONTRACT = params.get('contract') || 'casino_key_derivation2.testnet';
// Public testnet RPCs rate-limit per IP (a 429 without CORS headers shows up as a
// CORS error in the console). Rotate across independent providers on failure.
const RPCS = params.get('rpc') ? [params.get('rpc')] : [
  'https://rpc.testnet.fastnear.com',
  'https://near-testnet.drpc.org',
  'https://archival-rpc.testnet.fastnear.com',
  'https://near-testnet.gateway.tatum.io',
  'https://test.rpc.fastnear.com',
];
let rpcIndex = Math.floor(Math.random() * RPCS.length); // spread a room full of players
const RPC = RPCS[0];
const EXPLORER = 'https://testnet.nearblocks.io';
// The closing bet pays for the CKD request and for the callback that draws the
// whole round, so every bet asks for the most a transaction may prepay.
const GAS = '300000000000000';
const POLL_MS = 8000;
// A draw lands about two blocks after the request, so a round in flight is
// polled far more often than an open one: the board is the thing being watched.
const POLL_FAST_MS = 2000;
const BRAND = 'Casino Key Derivation';
// null = the lobby; a number = that game's table.
let gameId = params.has('game') ? Number(params.get('game')) : null;
let games = [];

const $ = id => document.getElementById(id);

// ---- formatting ----
const YOCTO = 10n ** 24n;
function fmtNear(yocto, digits = 2) {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = ((v % YOCTO) * 10n ** BigInt(digits)) / YOCTO;
  return `${whole}.${frac.toString().padStart(digits, '0')} Ⓝ`;
}
function toYocto(near) {
  const [w, f = ''] = String(near).split('.');
  return (BigInt(w || 0) * YOCTO + BigInt((f + '0'.repeat(24)).slice(0, 24))).toString();
}
const short = s => s.length > 28 ? s.slice(0, 14) + '…' + s.slice(-10) : s;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Stable per-account colour so the same player reads the same everywhere.
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const explorerAccount = id => `${EXPLORER}/address/${encodeURIComponent(id)}`;
// One pill for a NEAR account: colour dot, id, and a role label ("you", "contract").
function tag(id, { kind = '', role = '', text = null } = {}) {
  const mine = id === accountId && !kind;
  const cls = ['tag', kind, mine ? 'you' : ''].filter(Boolean).join(' ');
  const label = role || (mine ? 'you' : '');
  const dot = kind === 'contract' ? 'var(--gold)' : `hsl(${hue(id)} 58% 58%)`;
  return `<a class="${cls}" href="${explorerAccount(id)}" target="_blank" rel="noopener" title="${esc(id)}">`
    + `<i style="background:${dot}"></i><b>${esc(text || short(id))}</b>`
    + (label ? `<em>${esc(label)}</em>` : '') + `</a>`;
}
const label = n => { const g = game(); return g && g.labels ? g.labels[n] : String(n); };
// A value under a two-word label, instead of a sentence around it.
const meta = (k, v, kind = '') => `<span class="meta ${kind}"><i>${esc(k)}</i><b>${v}</b></span>`;
// A derived key as three swatches hued from thirds of it plus its first bytes:
// enough to see that two rounds ran on different keys without reading the hex.
function keyChip(k) {
  const w = Math.ceil(k.length / 3);
  const fp = [0, 1, 2].map(i => `<i style="background:hsl(${hue(k.slice(i * w, i * w + w))} 62% 58%)"></i>`).join('');
  return `<button type="button" class="keychip" data-key="${esc(k)}" title="${esc(k)}\nClick to copy">`
    + `${fp}<b>${esc(k.slice(0, 8))}\u2026</b></button>`;
}
document.addEventListener('click', e => {
  const c = e.target.closest('.keychip');
  if (c && navigator.clipboard) navigator.clipboard.writeText(c.dataset.key).then(() => toast('Key copied'), () => {});
});
// The numbers a round drew, as balls. A full drum is 36 of them, so a long
// round shows its opening, a count of what is elided, and the number that
// ended it — the one that actually decided the round.
const BALLS_SHOWN = 10;
function drumRow(ns, cls = 'sm') {
  const long = ns.length > BALLS_SHOWN;
  const head = (long ? ns.slice(0, BALLS_SHOWN - 1) : ns).map(x => `<span>${esc(label(x))}</span>`).join('');
  return `<span class="drum ${cls}">${head}`
    + (long ? `<em>+${ns.length - BALLS_SHOWN}</em><span class="last">${esc(label(ns[ns.length - 1]))}</span>` : '')
    + `</span>`;
}

// ---- RPC views ----
async function view(method, args = {}, account = CONTRACT) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'query', params: {
    request_type: 'call_function', finality: 'final', account_id: account, method_name: method,
    args_base64: btoa(JSON.stringify(args)) } });
  let lastErr;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[rpcIndex];
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      if (json.result.error) throw new Error(json.result.error); // contract panic: do not rotate
      return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result)));
    } catch (e) {
      lastErr = e;
      if (e.message.startsWith('wasm execution failed') || e.message.includes('panicked')) throw e;
      rpcIndex = (rpcIndex + 1) % RPCS.length;
      await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---- wallet (driven by the wallet-selector module script below) ----
let walletApi = null, accountId = null;
function setAccount(id) {
  if (id === accountId) return updateBetButton();
  accountId = id;
  renderWallet();
}
// Read once per page load (not on the poll timer): the balance is a
// convenience, and every extra RPC call risks the rate limit.
async function showBalance() {
  $('balance').textContent = '';
  if (!accountId) return;
  try {
    const res = await fetch(RPCS[rpcIndex], { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'query', params: {
        request_type: 'view_account', finality: 'final', account_id: accountId } }) });
    const json = await res.json();
    if (json.result) $('balance').textContent = fmtNear(json.result.amount);
  } catch (e) { /* leave blank */ }
}
function renderWallet() {
  $('account').innerHTML = accountId
    ? tag(accountId, { role: 'you' })
    : '<span class="tag off"><i style="background:var(--muted)"></i><b>not connected</b></span>';
  showBalance();
  $('connect').textContent = accountId ? 'Sign out' : 'Connect wallet';
  updateBetButton();
}
$('connect').onclick = () => {
  if (!walletApi) return;
  (accountId ? walletApi.signOut() : walletApi.show()).catch(e => toast(e.message || String(e), true));
};

// ---- card art ----
// Inline SVG rather than image files: the page is a single static file and the
// art has to survive being served from anywhere.
const ball = (cx, cy, r, fill, fg, n, cls) =>
  `<g class="ball ${cls}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`
  + `<ellipse cx="${cx - r * .48}" cy="${cy - r * .52}" rx="${r * .3}" ry="${r * .17}" fill="#fff" fill-opacity=".45" transform="rotate(-35 ${cx - r * .48} ${cy - r * .52})"/>`
  + `<circle cx="${cx}" cy="${cy}" r="${r * .64}" fill="#fdfbf4" fill-opacity=".92"/>`
  + `<text x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="${(r * .72).toFixed(0)}" font-weight="800" fill="${fg}">${n}</text></g>`;

// The eight-slot wheel, shared by the lobby card art and the result spinner.
// Slot i owns the arc from i*45 degrees clockwise from the top; its middle is
// what the pointer has to end up over.
const SLOTS = 8, SLICE = 360 / 8, SLOT_COLS = ['#f2c14e', '#7a4fb6', '#e05a5a', '#3ccf7a'];
// Ink per slot colour: dark reads well on all of them except the purple.
const SLOT_INK = ['#2a1748', '#f6f2ea', '#2a1748', '#2a1748'];
const slotMid = i => i * SLICE + SLICE / 2;
const onRim = (cx, cy, r, deg) => { const t = (deg - 90) * Math.PI / 180; return `${(cx + r * Math.cos(t)).toFixed(1)} ${(cy + r * Math.sin(t)).toFixed(1)}`; };
const wedge = (cx, cy, r, i, attrs) =>
  `<path d="M${cx} ${cy} L${onRim(cx, cy, r, i * SLICE)} A${r} ${r} 0 0 1 ${onRim(cx, cy, r, (i + 1) * SLICE)} Z" ${attrs}/>`;

const wheelArt = (() => {
  const cx = 100, cy = 64, r = 37;
  const slices = Array.from({ length: SLOTS }, (_, i) =>
    wedge(cx, cy, r, i, `fill="${SLOT_COLS[i % 4]}" fill-opacity=".92"`)).join('');
  return `<svg class="art" viewBox="0 0 200 120" aria-hidden="true"><g class="wheel">`
    + `<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="#2a1748"/>${slices}`
    + `<circle cx="${cx}" cy="${cy}" r="9" fill="#2a1748" stroke="#f2c14e" stroke-width="3"/></g>`
    + `<path d="M91 11 h18 l-9 20 z" fill="#f2c14e"/></svg>`;
})();

const ART = {
  CoinFlip: `<svg class="art" viewBox="0 0 200 120" aria-hidden="true">
    <defs><linearGradient id="art-coin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe6a3"/><stop offset="1" stop-color="#c8951c"/></linearGradient></defs>
    <g fill="none" stroke="#f2c14e" stroke-width="2" stroke-linecap="round" opacity=".4">
      <path d="M66 88a38 30 0 0 1 68 0" stroke-dasharray="3 8"/>
      <path d="M50 99a56 42 0 0 1 100 0" stroke-dasharray="3 10" opacity=".55"/>
    </g>
    <g class="coin">
      <circle cx="100" cy="54" r="33" fill="url(#art-coin)"/>
      <circle cx="100" cy="54" r="26" fill="none" stroke="#8a6512" stroke-opacity=".5" stroke-width="2"/>
      <text x="100" y="55" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="30" font-weight="800" fill="#7a5a0d">N</text>
    </g></svg>`,
  CrazySpinner: wheelArt,
  Bingo: `<svg class="art" viewBox="0 0 200 120" aria-hidden="true">
    ${ball(58, 78, 21, '#8f7ec4', '#2a1748', 7, 'b1')}
    ${ball(142, 78, 21, '#e05a5a', '#4a1414', 99, 'b3')}
    ${ball(100, 50, 26, '#f2c14e', '#5c4306', 42, 'b2')}</svg>`,
  _: `<svg class="art" viewBox="0 0 200 120" aria-hidden="true"><g class="ball b1">
    <rect x="68" y="28" width="64" height="64" rx="15" fill="#f4f1e8"/>
    <g fill="#3b2262"><circle cx="86" cy="46" r="6"/><circle cx="114" cy="46" r="6"/><circle cx="100" cy="60" r="6"/><circle cx="86" cy="74" r="6"/><circle cx="114" cy="74" r="6"/></g></g></svg>`,
};

// ---- games ----
const game = () => games.find(g => g.game_id === gameId);
const inLobby = () => gameId === null;

function setGames(list) {
  const key = l => JSON.stringify(l.map(g => [g.game_id, g.round_id, g.state, g.min_bet, g.threshold, g.outcomes, g.picks]));
  const changed = key(list) !== key(games);
  games = list;
  if (!inLobby() && !game()) gameId = null; // ?game= points at a game this contract does not have
  if (inLobby()) { if (changed) renderLobby(); return; }
  renderGameHeader();
  if (grid.dataset.shape !== gridShape()) buildGrid();
}

function renderLobby() {
  const el = $('game-grid');
  el.innerHTML = games.map(g => `
    <button class="game-card" data-game="${g.game_id}">
      <div class="art-wrap">${ART[g.kind] || ART._}</div>
      <div class="gc-body">
        <div class="gc-top"><h3>${esc(g.name)}</h3><span class="chip">${g.picks > 1 ? `pick ${g.picks} of ${g.outcomes}` : `${g.outcomes} outcomes`}</span>${g.default ? '<span class="chip feat">Featured</span>' : ''}</div>
        <dl class="gc-meta" title="${esc(g.rules)}">
          <div><dt>Round</dt><dd>#${g.round_id}</dd></div>
          <div><dt>Min bet</dt><dd>${fmtNear(g.min_bet)}</dd></div>
          <div><dt>Rolls at</dt><dd>${fmtNear(g.threshold)}</dd></div>
        </dl>
        <div class="gc-foot">${g.state === 'Open' ? '' : `<span class="badge ${g.state}">${g.state}</span>`}<span class="gc-play">Play</span></div>
      </div>
    </button>`).join('')
    || `<div class="empty">${snapshot ? 'This contract has no games registered.' : 'Loading games…'}</div>`;
  for (const b of el.querySelectorAll('.game-card')) b.onclick = () => go(Number(b.dataset.game));
  if (snapshot) $('house').innerHTML = meta('games', games.length)
    + meta('house cut', snapshot.cut_bps / 100 + '%')
    + meta('collected', fmtNear(snapshot.house_gains), 'gold');
}

function renderGameHeader() {
  const g = game();
  $('title-text').textContent = g ? g.name : BRAND;
  document.title = g ? `${g.name} · ${BRAND}` : BRAND;
  $('game-name').textContent = g ? g.name : '';
  $('rules').textContent = g ? g.rules : '';
  $('rules-fold').hidden = !g;
}

function renderView() {
  $('lobby').hidden = !inLobby();
  $('game').hidden = inLobby();
  $('home').hidden = inLobby();
  if (inLobby()) { $('title-text').textContent = BRAND; document.title = BRAND; return renderLobby(); }
  renderGameHeader();
  if (game()) buildGrid();
}

function urlFor(id) {
  const q = new URLSearchParams();
  if (id !== null) q.set('game', id);
  for (const k of ['contract', 'rpc']) if (params.get(k)) q.set(k, params.get(k));
  return location.pathname + (q.toString() ? '?' + q : '');
}

// Throws when the page is not on an http(s) origin (opened as file:// or data:);
// navigation still has to work there, just without the URL following along.
function setUrl(id, push) {
  try { history[push ? 'pushState' : 'replaceState']({ game: id }, '', urlFor(id)); } catch (e) { /* ignore */ }
}

// Enter a game (or the lobby, with id null) and reset everything round-scoped.
function go(id, push = true) {
  if (push && id === gameId) return;
  gameId = id; selected = []; round = null; lastResult = null; lastSeenRound = null;
  wheelLanded = null; wheelSpinning = false; clearTimeout(wheelTimer);
  $('banner').classList.remove('show');
  $('bets').innerHTML = ''; $('rolls').innerHTML = '';
  if (push) setUrl(id, true);
  scrollTo(0, 0);
  renderView();
  poll();
}
$('home').onclick = () => go(null);
addEventListener('popstate', () => {
  const p = new URLSearchParams(location.search);
  go(p.has('game') ? Number(p.get('game')) : null, false);
});

const gridShape = () => { const g = game(); return g ? `${g.game_id}:${g.outcomes}:${g.picks}` : ''; };

// The board a game is played on: the eight-slot wheel for Crazy Spinner, a
// grid of numbers for everything else. Only one of the two is ever populated,
// so everything that marks the board can address both without asking which.
const onWheel = () => { const g = game(); return !!g && g.kind === 'CrazySpinner' && g.outcomes === SLOTS; };

function buildGrid() {
  const g = game(), n = g.outcomes, wheel = onWheel();
  grid.innerHTML = ''; grid.dataset.shape = gridShape();
  wheelBoard.innerHTML = '';
  grid.hidden = wheel; wheelBoard.hidden = !wheel;
  if (wheel) buildWheel();
  else {
    // A card is a square board; a single-outcome game is one row, wrapped at ten.
    const cols = g.picks > 1 ? Math.round(Math.sqrt(n)) : Math.min(n, 10);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.classList.toggle('big', n <= 2);
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.textContent = label(i); b.dataset.i = i;
      b.onclick = () => pick(i);
      grid.appendChild(b);
    }
  }
  $('pick-tools').hidden = g.picks < 2; // one number needs no filling aids
  syncPicks(); // rebuilding the board loses the classes but not the picks
}

// The wheel is the bet form: clicking a slot is how a number is picked, so the
// slots are buttons in their own right, reachable by keyboard as well.
function buildWheel() {
  wheelBoard.className = 'res-wheel bet-wheel';
  wheelBoard.style.removeProperty('--spin');
  wheelBoard.innerHTML = wheelMarkup();
  for (const slot of wheelBoard.querySelectorAll('.slot')) {
    const i = +slot.dataset.i;
    slot.onclick = () => { if (wheelBoard.classList.contains('pickable')) pick(i); };
    slot.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); slot.onclick(); } };
  }
}

// One number for a single-outcome game, `picks` of them for a bingo card;
// clicking a chosen number takes it off again.
function pick(i) {
  const picks = game().picks;
  if (selected.includes(i)) selected = selected.filter(n => n !== i);
  else if (picks === 1) selected = [i];
  else if (selected.length < picks) selected = [...selected, i];
  else return toast(`A card holds ${picks} numbers — take one off first.`, true);
  syncPicks();
}

// Reflects `selected` onto the board. A card is kept in numeric order, so the
// bet button and the card chips read the same way the board does.
function syncPicks() {
  const g = game();
  if (g && g.picks > 1) selected.sort((a, b) => a - b);
  [...grid.children].forEach(c => c.classList.toggle('sel', selected.includes(+c.dataset.i)));
  for (const slot of wheelBoard.querySelectorAll('.slot')) slot.classList.toggle('sel', selected.includes(+slot.dataset.i));
  syncWheelCap();
  $('pick-count').innerHTML = g && g.picks > 1 ? meta('picked', `${selected.length}/${g.picks}`) : '';
  updateBetButton();
}

// Filling a card of six by hand is tedious; quick pick draws one at random.
$('quick').onclick = () => {
  const g = game();
  if (!g) return;
  const pool = [...Array(g.outcomes).keys()];
  selected = [];
  while (selected.length < g.picks && pool.length) {
    selected.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  syncPicks();
};
$('clear').onclick = () => { selected = []; syncPicks(); };

// ---- betting ----
let selected = [], round = null, lastSeenRound = null, lastResult = null, snapshot = null;
const grid = $('numbers'), wheelBoard = $('wheel-board');
// The contract takes one bet per player per round, so this is your whole stake
// in it.
const myBet = () => round && accountId ? round.bets.find(b => b.player === accountId) : null;
function updateBetButton() {
  const btn = $('bet'), picks = game() ? game().picks : 1, ready = selected.length === picks;
  const cards = ns => ns.map(label).join(picks > 1 ? '·' : ' ');
  const mine = myBet();
  btn.textContent = mine ? 'You are in this round'
    : ready ? `Bet on ${cards(selected)}`
    : picks > 1 ? `Pick ${picks - selected.length} more` : 'Bet on –';
  const open = round && round.state === 'Open';
  btn.disabled = !(walletApi && accountId && ready && open && !mine);
  btn.classList.toggle('pulse', !btn.disabled); // a heartbeat glow when a bet is one click away
  // The button says what you may do and the card above says what you already
  // hold, so this line is only ever the numbers neither of them carries.
  $('bet-hint').innerHTML = !round ? '<span class="hint">Loading round…</span>'
    : !accountId ? '<span class="hint">Connect a testnet wallet to bet.</span>'
    : !open ? meta('bets', 'closed')
    : mine ? meta('your stake', fmtNear(mine.amount), 'gold') + meta('next bet', 'when this round settles')
    : meta('min bet', fmtNear(round.min_bet), 'gold')
      + (picks > 1 ? meta('pick', `${picks} of ${game().outcomes}`) : '');
}
$('bet').onclick = async () => {
  const amount = $('amount').value;
  if (round && BigInt(toYocto(amount)) < BigInt(round.min_bet)) return toast(`Minimum bet is ${fmtNear(round.min_bet)}`, true);
  try {
    // Redirect wallets (MyNearWallet) navigate away here and return with ?transactionHashes;
    // popup wallets (Meteor) resolve in place.
    const outcome = await walletApi.bet(selected, gameId, toYocto(amount));
    if (outcome) { toast('Bet placed.'); showBalance(); poll(); }
  } catch (e) { toast(e.message || String(e), true); }
};
// ---- rendering ----
// A bingo card: its numbers in order, as chips.
const cardNums = (numbers, picks) => picks < 2
  ? esc(numbers.map(label).join(' '))
  : `<span class="card-nums">` + [...numbers].sort((a, b) => a - b)
      .map(n => `<b>${esc(label(n))}</b>`).join('') + `</span>`;

function renderRound() {
  $('round-id').textContent = round.round_id;
  const st = $('state'); st.textContent = round.state; st.className = 'badge ' + round.state;
  $('total').textContent = fmtNear(round.total_bets);
  $('carry').textContent = fmtNear(round.carry);
  $('pot').textContent = fmtNear((BigInt(round.total_bets) + BigInt(round.carry)).toString());
  const pct = Math.min(100, Number(BigInt(round.total_bets) * 100n / BigInt(round.threshold)));
  $('bar').style.width = pct + '%';
  $('pct').textContent = pct + '%';
  $('bar').parentElement.classList.toggle('hot', pct >= 80 && round.state === 'Open'); // the roll is close
  $('goal').textContent = fmtNear(round.threshold);
  if (snapshot) $('cut').innerHTML = meta('house cut', snapshot.cut_bps / 100 + '%')
    + meta('collected', fmtNear(snapshot.house_gains));
  const picks = game() ? game().picks : 1;
  $('bets-col').textContent = picks > 1 ? 'Card' : 'Number';
  const tb = $('bets'); tb.innerHTML = '';
  for (const b of round.bets) {
    const tr = document.createElement('tr');
    if (b.player === accountId) tr.className = 'mine';
    tr.innerHTML = `<td>${tag(b.player)}</td><td class="num">${cardNums(b.numbers, picks)}</td>`
      + `<td>${fmtNear(b.amount)}</td>`;
    tb.appendChild(tr);
  }
  $('bets-table').style.display = round.bets.length ? '' : 'none';
  $('no-bets').style.display = round.bets.length ? 'none' : '';
  const minNear = Number(BigInt(round.min_bet) * 10000n / YOCTO) / 10000;
  $('amount').min = minNear; $('amount').step = minNear || 0.1; // the ± buttons move one minimum bet at a time
  if (!$('amount').dataset.touched) $('amount').value = minNear;
  const counts = {}, mine = new Set();
  for (const b of round.bets) for (const n of b.numbers) {
    counts[n] = (counts[n] || 0) + 1;
    if (b.player === accountId) mine.add(n);
  }
  const open = round.state === 'Open';
  [...grid.children].forEach((c, n) => {
    c.classList.toggle('taken', !!counts[n]); c.dataset.n = counts[n] || '';
    c.classList.toggle('mine', mine.has(n));
    c.disabled = !open; // a closed round is not a bet form
  });
  grid.classList.toggle('rolling', round.state === 'Rolling');
  grid.classList.toggle('locked', !open);
  syncWheel(counts, mine, open);
  $('pick-tools').hidden = picks < 2 || !open; // nothing to pick while the drum turns
  renderBoardLive(picks);
  renderMyCards(picks);
  updateBetButton();
}

// The board's own status line, in the slot the pick tools use while betting is
// open. A closed round draws every number in one callback, so there is nothing
// to count down: it says what the round is doing and which card is yours.
function renderBoardLive(picks) {
  const el = $('board-live'), g = game();
  if (!g || round.state === 'Open') { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = `<span class="dot"></span>`
    + (round.state === 'Rolling' ? `Deriving the round key` : `Settling`);
  el.hidden = false;
}

// Your own card, called out above the table: it is what you watch a round for,
// and a row in the shared table is the wrong place to read it from.
function renderMyCards(picks) {
  const el = $('my-cards'), b = myBet();
  if (picks < 2 || !b) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="mycard"><h3>Your card · ${fmtNear(b.amount)}</h3>`
    + `<div class="row">${cardNums(b.numbers, picks)}</div></div>`;
}
$('amount').oninput = () => { $('amount').dataset.touched = '1'; };
// The ± buttons stand in for the native spinners: same steps, but visible and
// on-theme. Rounded because 0.1 + 0.2 is not 0.3 in binary floating point.
for (const [id, dir] of [['amount-down', -1], ['amount-up', 1]]) $(id).onclick = () => {
  const el = $('amount'), step = Number(el.step) || 0.1;
  el.value = String(Math.round(Math.max(Number(el.min) || 0, (Number(el.value) || 0) + dir * step) * 1e6) / 1e6);
  el.dataset.touched = '1';
};

// Crazy Spinner's wheel, which is both how a bet is placed and how the round
// is watched: while the round is open its slots are the bet form, and when the
// round runs the same wheel is thrown clockwise and comes down on the number
// the contract drew. The numbers and the pegs ride the face, so the winner
// comes to rest upright and the pointer ticks off every slot it passes.
function wheelMarkup() {
  const cx = 100, cy = 104, r = 78;
  const pt = (rad, deg) => { const t = (deg - 90) * Math.PI / 180; return [cx + rad * Math.cos(t), cy + rad * Math.sin(t)]; };
  // One group per slot, each its own button: a click anywhere in the wedge is
  // a pick, and because the group turns with the face the hit test stays right
  // however far round the wheel has come.
  const slots = Array.from({ length: SLOTS }, (_, i) => {
    const rot = `rotate(${slotMid(i)} ${cx} ${cy})`;
    const ny = (cy - r * .62).toFixed(1), by = (cy - r * .88).toFixed(1);
    return `<g class="slot" data-i="${i}" role="button" tabindex="0" aria-label="Pick ${esc(label(i))}">`
      + wedge(cx, cy, r, i, `class="wedge" fill="${SLOT_COLS[i % 4]}" stroke="#2a1748" stroke-width="1"`)
      + `<text class="num" x="${cx}" y="${ny}" transform="${rot}" text-anchor="middle" dominant-baseline="middle"`
      + ` font-family="system-ui,sans-serif" font-size="18" font-weight="800" fill="${SLOT_INK[i % 4]}">${esc(label(i))}</text>`
      // How many players are already on this slot, out by the rim where it
      // cannot be mistaken for the slot's own number.
      + `<g class="cnt" transform="${rot}">`
      + `<circle cx="${cx}" cy="${by}" r="8.5" fill="#e05a5a" stroke="#2a1748" stroke-width="1"/>`
      + `<text class="cnt-n" x="${cx}" y="${by}" text-anchor="middle" dominant-baseline="middle"`
      + ` font-family="system-ui,sans-serif" font-size="10" font-weight="800" fill="#fff"></text></g>`
      // The mark — your pick, your bet, the winner — drawn last so its stroke
      // sits over the neighbouring wedges rather than under them.
      + wedge(cx, cy, r, i, `class="ring" fill="none" stroke-width="3.5" stroke-linejoin="round"`)
      + `</g>`;
  }).join('');
  // One peg per slot divider: what the pointer ticks against, and what stops
  // the wheel. The rolled slot's middle lands under the pointer, between two.
  const pegs = Array.from({ length: SLOTS }, (_, i) => {
    const [x, y] = pt(r - 3, i * SLICE);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="#f6efdc" stroke="#2a1748" stroke-width="1"/>`;
  }).join('');
  return `<svg viewBox="0 0 200 200" role="group" aria-label="The spinner: click a slot to pick that number">`
    + `<defs>`
    + `<linearGradient id="sp-bezel" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="#ffe6a3"/><stop offset=".5" stop-color="#c8951c"/><stop offset="1" stop-color="#8a6512"/>`
    + `</linearGradient>`
    + `<radialGradient id="sp-gloss"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="sp-hub"><stop offset="0" stop-color="#ffe6a3"/><stop offset="1" stop-color="#b8890f"/></radialGradient>`
    + `</defs>`
    + `<ellipse cx="${cx}" cy="${cy + r + 14}" rx="${r * .8}" ry="7" fill="#1a0f2e" fill-opacity=".45"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r + 9}" fill="url(#sp-bezel)"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r + 3}" fill="#2a1748"/>`
    + `<g class="face">${slots}${pegs}</g>`
    // Static sheen and rim shadow: they belong to the light, not the wheel, so
    // they sit outside the spinning group and stay put as it turns. The hub is
    // drawn over the wedges, which meet under it.
    + `<ellipse cx="${cx - 26}" cy="${cy - 30}" rx="46" ry="30" fill="url(#sp-gloss)" transform="rotate(-32 ${cx - 26} ${cy - 30})" pointer-events="none"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r + 1}" fill="none" stroke="#1a0f2e" stroke-opacity=".45" stroke-width="4" pointer-events="none"/>`
    + `<circle cx="${cx}" cy="${cy}" r="15" fill="url(#sp-hub)" stroke="#2a1748" stroke-width="3"/>`
    + `<circle cx="${cx}" cy="${cy}" r="5" fill="#2a1748"/>`
    + `<path class="peg" d="M88 2 h24 l-12 30 z" fill="url(#sp-bezel)" stroke="#2a1748" stroke-width="1.5" stroke-linejoin="round"/>`
    + `</svg>`
    + `<div class="roll-cap" id="wheel-cap"></div>`;
}

// ---- the wheel's three states ----
// Open: a bet form. Closed with the numbers still to come: turning, because
// nothing yet knows where it stops. Result in: thrown onto the winning slot.
let wheelSpinning = false, wheelLanded = null, wheelTimer = null;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const setWheelCap = t => { const el = $('wheel-cap'); if (el) el.innerHTML = t; };

// The line under the wheel says what the wheel itself cannot: whose numbers
// are on it, and what it is waiting for. Left alone mid-spin, so the result is
// not given away before the wheel has come down on it.
function syncWheelCap() {
  if (wheelSpinning || !round) return;
  const b = myBet();
  setWheelCap(round.state !== 'Open' && wheelLanded !== round.round_id
      ? 'Deriving the round key'
    : b ? meta('your number', esc(label(b.numbers[0])), 'gold')
    : selected.length ? meta('picked', esc(label(selected[0])), 'gold')
    : 'Pick a slot');
}

// The wheel's marks and its motion, from the round: which slots have bets on
// them, which is yours, whether a slot can be picked at all, and whether the
// wheel should be turning. A no-op for games that are played on the grid.
function syncWheel(counts, mine, open) {
  const slots = wheelBoard.querySelectorAll('.slot');
  if (!slots.length) return;
  for (const slot of slots) {
    const n = +slot.dataset.i;
    slot.classList.toggle('taken', !!counts[n]);
    slot.classList.toggle('mine', mine.has(n));
    slot.querySelector('.cnt-n').textContent = counts[n] || '';
    slot.setAttribute('tabindex', open ? '0' : '-1'); // a closed round is not a bet form
  }
  wheelBoard.classList.toggle('pickable', open);
  if (!wheelSpinning) {
    const turning = !open && wheelLanded !== round.round_id;
    // A round of its own to run: the wheel leaves the last one's landing
    // behind rather than carrying that winner into this spin.
    if (turning && wheelBoard.classList.contains('spin')) {
      wheelBoard.classList.remove('spin');
      for (const slot of slots) slot.classList.remove('win');
    }
    wheelBoard.classList.toggle('turning', turning);
  }
  syncWheelCap();
}

// The round's result is what stops the wheel: it is thrown clockwise and runs
// down until the winning slot sits under the pointer. A refunded round drew
// nothing, so the wheel is simply let go.
function landWheel(r) {
  if (!wheelBoard.querySelector('.slot')) return;
  wheelLanded = r.round_id;
  clearTimeout(wheelTimer);
  wheelSpinning = false;
  const roll = r.refunded ? null : r.draws[0];
  if (roll == null) { wheelBoard.classList.remove('turning'); return syncWheelCap(); }
  for (const slot of wheelBoard.querySelectorAll('.slot')) slot.classList.toggle('win', +slot.dataset.i === roll);
  wheelBoard.classList.remove('turning', 'spin');
  void wheelBoard.offsetWidth; // let the landing animation play again from the top
  wheelBoard.style.setProperty('--spin', `${-slotMid(roll)}deg`);
  wheelBoard.classList.add('spin');
  wheelSpinning = true;
  setWheelCap('Spinning');
  wheelTimer = setTimeout(() => {
    wheelSpinning = false;
    setWheelCap(meta('landed on', esc(label(roll)), 'win'));
  }, reducedMotion() ? 0 : 3000);
}

// Coin Flip's result, drawn instead of printed: the coin is tossed, spins on
// its edge and lands with the rolled face up. Slot 0 is on the front of the
// coin, slot 1 on the back, so a half turn more lands tails.
function coinFlip(roll) {
  const face = (cls, n) => {
    const t = label(n);
    return `<div class="coin-face ${cls}"><div><b>${esc(t.slice(0, 1).toUpperCase())}</b>`
      + (t.length > 1 ? `<span>${esc(t)}</span>` : '') + `</div></div>`;
  };
  return `<div class="res-coin flip" style="--end:${1800 + roll * 180}deg"`
    + ` role="img" aria-label="The coin landed on ${esc(label(roll))}">`
    + `<div class="coin-shadow"></div>`
    + `<div class="toss"><div class="coin3d">${face('heads', 0)}${face('tails', 1)}</div></div></div>`;
}

// Bingo's result: the numbers in the order they came out, the one that filled
// a card ringed. The contract draws them all in one callback, so the balls pop
// in one at a time here (`--i` is the CSS animation's place in the queue) —
// otherwise a thirty-number round would arrive as a wall of numbers.
function bingoDrum(draws) {
  return `<div class="drum big">` + draws.map((n, i) => {
    const last = i === draws.length - 1;
    return `<span style="--i:${i}" class="${last ? 'last' : ''}"`
      + `${last ? ' title="The number that filled a card"' : ''}>${esc(label(n))}</span>`;
  }).join('') + `</div>`;
}

// What the old caption spelled out in a sentence, minus the sentence: the
// round's numbers as labelled pills under whatever drew the result.
function resultMetas(r, extra) {
  const won = r.payouts.find(p => p.player === accountId);
  return `<div class="metas center" style="margin:8px 0 12px">`
    + meta('round', '#' + r.round_id)
    + meta('pot', fmtNear(r.pot), 'gold')
    + (extra || '')
    + (r.payouts.length ? meta(r.payouts.length > 1 ? 'winners' : 'winner', r.payouts.length)
                        : meta('no winner', 'carried'))
    + (won ? meta('you won', fmtNear(won.amount), 'win') : '')
    + `</div>`;
}

function renderLast(r) {
  const el = $('last');
  if (!r) { el.innerHTML = '<div class="empty">No round settled yet.</div>'; return; }
  if (r.refunded) {
    el.innerHTML = `<div class="roll">—</div><div class="metas center">`
      + meta('round', '#' + r.round_id)
      + meta('timed out', fmtNear(r.pot) + ' refunded', 'warn') + `</div>`;
    return;
  }
  const rows = r.payouts.map(p => `<tr><td>${tag(p.player)}</td><td>${fmtNear(p.amount)}</td></tr>`).join('');
  // Bingo and the coin draw their result here; the spinner's own wheel above
  // has just landed on it, so this card only records the number it stopped at.
  const g = game();
  const roll = r.draws[0];
  const cap = resultMetas(r, g && g.picks > 1 ? meta('drawn', `${r.draws.length}/${g.outcomes}`) : '');
  el.innerHTML = (g && g.picks > 1
      ? bingoDrum(r.draws) + cap
    : g && g.kind === 'CoinFlip' && g.outcomes === 2
      ? coinFlip(roll) + cap
      : `<div class="roll">${label(roll)}</div>` + cap)
    + (rows ? `<div class="tscroll"><table><tbody>${rows}</tbody></table></div>` : '')
    + `<div class="metas" style="margin-top:10px">${keyChip(r.big_c)}</div>`;
}

// Check a settled round in two halves. The key: `big_c` pairing-checked as the
// MPC network's derived key for this round's path (js/ckd.js; null when that
// module could not load). The draws: every number recomputed from the stored
// preimages. The key order of the JSON is what the contract hashes, so `input`
// goes in as it came off the RPC and the three per-draw fields follow it. One
// key for the round: `draw` and `drawn` are what make each preimage its own.
const derivationPath = (g, i) => g === 0 ? `round-${i}` : `game-${g}-round-${i}`;
const verified = new Map();
// js/ckd.js is a module, so it lands after this script: wait for it a little
// rather than settle for a draws-only seal, and refresh such seals if it lands late.
const ckdReady = new Promise(r => {
  if (window.verifyKey) return r(true);
  window.addEventListener('ckd-ready', () => r(true), { once: true });
  setTimeout(() => r(false), 8000);
});
window.addEventListener('ckd-ready', () => {
  for (const [key, v] of verified) {
    if (v.key !== null) continue;
    const [g, i] = key.split(':').map(Number);
    checkKey(g, i, rollCache.get(key)).then(k => { v.key = k; const el = document.getElementById(`v-${g}-${i}`); if (el) sealFor(el, v); });
  }
});
async function checkKey(g, i, record) {
  if (!(await ckdReady) || !record) return null;
  try { return await window.verifyKey(CONTRACT, derivationPath(g, i), record.big_c); } catch (e) { return null; }
}
async function verifyRoll(g, i, record) {
  const key = `${g}:${i}`;
  const cached = verified.get(key);
  if (cached) { // only the key half is retried: the module may have loaded since
    if (cached.key === null) cached.key = await checkKey(g, i, record);
    return cached;
  }
  try {
    const input = await view('get_roll_input', { round_id: i, game_id: g });
    if (!input || !record.draws.length || !record.big_c) return null;
    const drawn = [];
    let draws = true;
    for (let d = 0; draws && d < record.draws.length; d++) {
      const preimage = JSON.stringify({ input, draw: d, drawn: [...drawn], big_c: record.big_c });
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage)));
      let r = 0n; for (const b of hash) r = (r << 8n) | BigInt(b);
      const left = [];
      for (let n = 0; n < input.outcomes; n++) if (!drawn.includes(n)) left.push(n);
      draws = left[Number(r % BigInt(left.length))] === record.draws[d];
      drawn.push(record.draws[d]);
    }
    const result = { draws, key: await checkKey(g, i, record) };
    verified.set(key, result);
    return result;
  } catch (e) { return null; }
}
// Green only when both halves hold; amber when the draws hold but the key
// could not be checked here; red when either fails.
function sealFor(el, v) {
  const ok = v.draws && v.key === true, part = v.draws && v.key === null;
  el.textContent = ok || part ? '✓' : '✗';
  el.className = 'seal ' + (ok ? 'ok' : part ? 'part' : 'bad');
  el.title = !v.draws ? 'A recomputed draw does not match!'
    : v.key === false ? 'big_c is not the MPC network\'s derived key for this round!'
    : v.key === null ? 'Every draw recomputed here; the key could not be pairing-checked (module not loaded)'
    : 'Key pairing-checked against the MPC network\'s public key, every draw recomputed from get_roll_input, in this browser';
}

const rollCache = new Map();
async function renderRolls(currentRound) {
  const g = gameId, key = i => `${g}:${i}`;
  const ids = []; for (let i = currentRound - 1; i >= 0 && ids.length < 8; i--) ids.push(i);
  for (const i of ids.filter(i => !rollCache.has(key(i)))) rollCache.set(key(i), await view('get_roll', { round_id: i, game_id: g })); // sequential: bursts get rate-limited
  if (g !== gameId) return;
  $('rolls').innerHTML = ids.map(i => { const r = rollCache.get(key(i)); const drew = r && r.draws.length;
    return `<div class="lrow"><span class="rid">#${i}</span>`
      + (drew ? `<span class="seal" id="v-${g}-${i}">✓</span>` + drumRow(r.draws) + keyChip(r.big_c)
              : `<span class="dash">—</span>`) + `</div>`; }).join('')
    || '<div class="empty">No draws yet.</div>';
  for (const i of ids) {
    const r = rollCache.get(key(i)); if (!r) continue;
    verifyRoll(g, i, r).then(v => { const el = document.getElementById(`v-${g}-${i}`); if (el && v) sealFor(el, v); });
  }
}

function showBanner(r) {
  const won = r.payouts.find(p => p.player === accountId);
  if (won) celebrate();
  const b = $('banner');
  b.className = 'banner show' + (won ? ' win' : '');
  b.innerHTML = `<div class="metas">` + meta('round', '#' + r.round_id)
    + (r.refunded ? meta('timed out', 'refunded', 'warn')
      : meta(r.draws.length > 1 ? 'filled on' : 'rolled', esc(label(r.draws[r.draws.length - 1])), 'gold')
        + (won ? meta('you won', fmtNear(won.amount), 'win')
          : r.payouts.length ? meta(r.payouts.length > 1 ? 'winners' : 'winner', `${r.payouts.length} · ${fmtNear(r.pot)}`)
          : meta('nobody hit it', fmtNear(r.pot) + ' carries')))
    + `</div>`;
  setTimeout(() => b.classList.remove('show'), 15000);
}

// ---- celebration: confetti falling for a win ----
// A canvas overlay rather than a DOM shower: a few hundred divs each animating
// their own fall is the kind of thing that jitters on a cheap laptop, one
// canvas repainting every frame is not.
function celebrate() {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999';
  canvas.width = innerWidth; canvas.height = innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const COLORS = ['#f2c14e', '#d4a72c', '#3ccf7a', '#e05a5a', '#7a4fb6', '#fff2c4'];
  const pieces = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width, y: -20 - Math.random() * canvas.height * .5,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 10,
    vx: -2.4 + Math.random() * 4.8, vy: 2 + Math.random() * 3,
    rot: Math.random() * Math.PI * 2, vr: -0.22 + Math.random() * 0.44,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));
  const start = performance.now(), DURATION = 3800;
  (function frame(t) {
    const elapsed = t - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.045; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - elapsed / DURATION);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (elapsed < DURATION) requestAnimationFrame(frame); else canvas.remove();
  })(start);
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
}

// ---- polling ----
// Self-rescheduling rather than a fixed interval, so the tick can follow the
// round: fast while the network is deriving keys, slow while bets come in, and
// backing off after failures instead of hammering a rate-limited RPC.
let failures = 0, polling = false, pollAgain = false, pollTimer = null;
function pollDelay() {
  if (failures) return POLL_MS * Math.min(failures, 7); // 8s, 16s, … ~56s
  if (document.hidden) return POLL_MS;
  const live = round && round.state !== 'Open';
  return !inLobby() && live ? POLL_FAST_MS : POLL_MS;
}
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, pollDelay());
}
async function poll() {
  clearTimeout(pollTimer);
  // One snapshot in flight at a time, so a slow reply cannot land after a newer
  // one; a poll asked for meanwhile folds into it and runs the moment it ends.
  if (polling) { pollAgain = true; return; }
  if (document.hidden && games.length) return schedulePoll(); // background tab: keep the first load
  polling = true;
  const g = gameId;
  try {
    // One call per tick: games + round + last result. In the lobby only the
    // games list is used, so it stays one call there too.
    const snap = await view('get_snapshot', g === null ? {} : { game_id: g });
    if (g !== gameId) return; // navigated away while this was in flight
    snapshot = snap; setGames(snap.games);
    if (inLobby()) { failures = 0; return; } // setGames redrew the cards if anything moved
    const r = snap.round, last = snap.last_round;
    round = r; renderRound();
    if (last && (!lastResult || last.round_id !== lastResult.round_id)) {
      if (lastResult !== null || lastSeenRound !== null) showBanner(last);
      lastResult = last; renderLast(last); landWheel(last); rollCache.delete(`${g}:${last.round_id}`);
    } else if (!last) renderLast(null);
    if (lastSeenRound !== r.round_id) { lastSeenRound = r.round_id; await renderRolls(r.round_id); }
    failures = 0; $('state').classList.remove('offline');
  } catch (e) {
    pollFailed(e);
  } finally {
    polling = false;
    if (pollAgain) { pollAgain = false; poll(); } else schedulePoll();
  }
}
function pollFailed(e) {
  failures++;
  $('state').classList.add('offline');
  if (failures === 3) toast('RPC busy (rate limited), retrying with longer pauses', true);
}

// ---- wallet redirect result ----
if (params.get('transactionHashes')) {
  const h = params.get('transactionHashes').split(',')[0];
  toast('Bet placed.'); $('last').insertAdjacentHTML('afterbegin', `<div class="hint">Your tx: <a target="_blank" href="${EXPLORER}/txns/${h}">${short(h)}</a></div>`);
  setUrl(gameId, false);
} else if (params.get('errorCode')) {
  toast('Wallet: ' + decodeURIComponent(params.get('errorMessage') || params.get('errorCode')), true);
  setUrl(gameId, false);
}

$('contract-id').innerHTML = tag(CONTRACT, { kind: 'contract', role: 'contract', text: CONTRACT });
renderWallet();
renderView();
poll();
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
