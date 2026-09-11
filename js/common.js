// What every page of the casino shares: the contract and its RPCs, the
// formatting, the wallet in the header, the toast and the poll loop. The lobby
// (js/lobby.js) and a game's table (js/game.js) each load this first.
const params = new URLSearchParams(location.search);
const CONTRACT = params.get('contract') || 'casino_key_derivation.testnet';
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
const EXPLORER = 'https://testnet.nearblocks.io';
// Where the casino's receipts to the MPC contract are counted from: the one
// check that needs more than the two contracts' own views.
const INDEXER = params.get('indexer') || 'https://api-testnet.nearblocks.io';
const MPC_CONTRACT = 'v1.signer-prod.testnet';
// The closing bet pays for the CKD request and for the callback that draws the
// whole round, so every bet asks for the most a transaction may prepay.
const GAS = '300000000000000';
// A deposit or a withdrawal is a balance update and one transfer.
const BANK_GAS = '30000000000000';
const POLL_MS = 8000;
const BRAND = 'Casino Key Derivation';
// One page per game, by kind: a game's id is a contract detail, its kind is
// what the board is built for.
const PAGES = { Bingo: 'bingo.html', CrazySpinner: 'spinner.html', CoinFlip: 'coinflip.html', Dice: 'dice.html' };
// Links between pages carry the contract and RPC overrides along.
const carried = new URLSearchParams();
for (const k of ['contract', 'rpc']) if (params.get(k)) carried.set(k, params.get(k));
const pageUrl = file => file + (carried.toString() ? '?' + carried : '');
// A link to a specific game's own history page, carrying the same overrides.
const gamePageUrl = (file, gameId) => { const u = new URLSearchParams(carried); u.set('game', gameId); return `${file}?${u}`; };

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
// A value under a two-word label, instead of a sentence around it.
const meta = (k, v, kind = '') => `<span class="meta ${kind}"><i>${esc(k)}</i><b>${v}</b></span>`;

// ---- shared game rendering: dice, key chips, draw ledgers ----
// A die face as pips rather than a numeral: outcome `n` is face `n + 1`, and
// PIPS says which of the nine spots of a 3x3 grid that face fills.
const PIPS = [[4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
function dieFace(n, cls = '') {
  const pips = PIPS[n].map(p => `<circle cx="${25 + (p % 3) * 25}" cy="${25 + Math.floor(p / 3) * 25}" r="8"/>`).join('');
  return `<svg class="die ${cls}" viewBox="0 0 100 100" aria-hidden="true"><rect x="3" y="3" width="94" height="94" rx="18"/>${pips}</svg>`;
}
// A derived key as three swatches hued from thirds of it plus its first bytes:
// enough to see that two rounds ran on different keys without reading the hex.
function keyChip(k) {
  const w = Math.ceil(k.length / 3);
  const fp = [0, 1, 2].map(i => `<i style="background:hsl(${hue(k.slice(i * w, i * w + w))} 62% 58%)"></i>`).join('');
  return `<button type="button" class="keychip" data-key="${esc(k)}" title="${esc(k)}\nClick to copy">`
    + `${fp}<b>${esc(k.slice(0, 8))}…</b></button>`;
}
document.addEventListener('click', e => {
  const c = e.target.closest('.keychip');
  if (c && navigator.clipboard) navigator.clipboard.writeText(c.dataset.key).then(() => toast('Key copied'), () => {});
});
// The numbers a round drew, as balls. A full drum is 36 of them, so a long
// round shows its opening, a count of what is elided, and the number that
// ended it — the one that actually decided the round.
const BALLS_SHOWN = 10;
function drumRow(ns, label, cls = 'sm') {
  const long = ns.length > BALLS_SHOWN;
  const head = (long ? ns.slice(0, BALLS_SHOWN - 1) : ns).map(x => `<span>${esc(label(x))}</span>`).join('');
  return `<span class="drum ${cls}">${head}`
    + (long ? `<em>+${ns.length - BALLS_SHOWN}</em><span class="last">${esc(label(ns[ns.length - 1]))}</span>` : '')
    + `</span>`;
}

// The eight-slot wheel's geometry, shared by the lobby card art and the table's
// spinner. Slot i owns the arc from i*45 degrees clockwise from the top; its
// middle is what the pointer has to end up over.
const SLOTS = 8, SLICE = 360 / 8, SLOT_COLS = ['#f2c14e', '#7a4fb6', '#e05a5a', '#3ccf7a'];
// Ink per slot colour: dark reads well on all of them except the purple.
const SLOT_INK = ['#2a1748', '#f6f2ea', '#2a1748', '#2a1748'];
const slotMid = i => i * SLICE + SLICE / 2;
const onRim = (cx, cy, r, deg) => { const t = (deg - 90) * Math.PI / 180; return `${(cx + r * Math.cos(t)).toFixed(1)} ${(cy + r * Math.sin(t)).toFixed(1)}`; };
const wedge = (cx, cy, r, i, attrs) =>
  `<path d="M${cx} ${cy} L${onRim(cx, cy, r, i * SLICE)} A${r} ${r} 0 0 1 ${onRim(cx, cy, r, (i + 1) * SLICE)} Z" ${attrs}/>`;

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

// ---- wallet (driven by the wallet-selector module script, js/wallet.js) ----
// A page that cares who is signed in listens for `account` on the document:
// fired on every sync, since the wallet API arriving matters as much as an id.
let walletApi = null, accountId = null;
function setAccount(id) {
  if (id !== accountId) { accountId = id; renderWallet(); }
  document.dispatchEvent(new Event('account'));
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
}
$('connect').onclick = () => {
  if (!walletApi) return;
  (accountId ? walletApi.signOut() : walletApi.show()).catch(e => toast(e.message || String(e), true));
};

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
}

// ---- polling ----
// Self-rescheduling rather than a fixed interval, so the tick can follow the
// round: fast while the network is deriving keys, slow while bets come in, and
// backing off after failures instead of hammering a rate-limited RPC. The page
// supplies the tick and, if it has one, a faster delay for a round in flight.
let failures = 0, polling = false, pollAgain = false, pollTimer = null, loaded = false, stopped = false;
let pollTick = async () => {}, liveDelay = () => POLL_MS;
function pollDelay() {
  if (failures) return POLL_MS * Math.min(failures, 7); // 8s, 16s, … ~56s
  return document.hidden ? POLL_MS : liveDelay();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!stopped) pollTimer = setTimeout(poll, pollDelay());
}
async function poll() {
  clearTimeout(pollTimer);
  // One snapshot in flight at a time, so a slow reply cannot land after a newer
  // one; a poll asked for meanwhile folds into it and runs the moment it ends.
  if (stopped) return;
  if (polling) { pollAgain = true; return; }
  if (document.hidden && loaded) return schedulePoll(); // background tab: keep the first load
  polling = true;
  try {
    await pollTick();
    loaded = true; failures = 0;
    const st = $('state'); if (st) st.classList.remove('offline');
  } catch (e) {
    failures++;
    const st = $('state'); if (st) st.classList.add('offline');
    if (failures === 3) toast('RPC busy (rate limited), retrying with longer pauses', true);
  } finally {
    polling = false;
    if (pollAgain) { pollAgain = false; poll(); } else schedulePoll();
  }
}
function startPolling(fn, delay) {
  pollTick = fn; if (delay) liveDelay = delay;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
}
// For a page whose game this contract does not have: nothing left to ask.
const stopPolling = () => { stopped = true; clearTimeout(pollTimer); };

$('contract-id').innerHTML = tag(CONTRACT, { kind: 'contract', role: 'contract', text: CONTRACT });
renderWallet();
