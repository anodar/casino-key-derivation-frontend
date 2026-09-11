// A game's table: the board to bet from, the round around it, the last result
// and the ledger of draws. The page says which game it is for (body's
// data-kind); the game's id is looked up on the contract, so the same page
// serves any deployment (?contract=). Loads after js/common.js.
const KIND = document.body.dataset.kind;
// A draw lands about two blocks after the request, so a round in flight is
// polled far more often than an open one: the board is the thing being watched.
const POLL_FAST_MS = 2000;
let gameId = null, games = [];
const game = () => games.find(g => g.game_id === gameId);
const label = n => { const g = game(); return g && g.labels ? g.labels[n] : String(n); };

// A die face as pips rather than a numeral: outcome `n` is face `n + 1`, and
// PIPS says which of the nine spots of a 3x3 grid that face fills.
const PIPS = [[4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
function dieFace(n, cls = '') {
  const pips = PIPS[n].map(p => `<circle cx="${25 + (p % 3) * 25}" cy="${25 + Math.floor(p / 3) * 25}" r="8"/>`).join('');
  return `<svg class="die ${cls}" viewBox="0 0 100 100" aria-hidden="true"><rect x="3" y="3" width="94" height="94" rx="18"/>${pips}</svg>`;
}
const onDice = () => { const g = game(); return !!g && g.kind === 'Dice' && g.outcomes === 6; };
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
function drumRow(ns, cls = 'sm') {
  const long = ns.length > BALLS_SHOWN;
  const head = (long ? ns.slice(0, BALLS_SHOWN - 1) : ns).map(x => `<span>${esc(label(x))}</span>`).join('');
  return `<span class="drum ${cls}">${head}`
    + (long ? `<em>+${ns.length - BALLS_SHOWN}</em><span class="last">${esc(label(ns[ns.length - 1]))}</span>` : '')
    + `</span>`;
}

// ---- the game ----
function setGames(list) {
  games = list;
  renderGameHeader();
  if (grid.dataset.shape !== gridShape()) buildGrid();
}

function renderGameHeader() {
  const g = game();
  $('title-text').textContent = g ? g.name : BRAND;
  document.title = g ? `${g.name} · ${BRAND}` : BRAND;
  $('game-name').textContent = g ? g.name : '';
  $('rules').textContent = g ? g.rules : '';
  $('rules-fold').hidden = !g;
}

const gridShape = () => { const g = game(); return g ? `${g.game_id}:${g.outcomes}:${g.picks}` : ''; };

// The board a game is played on: the eight-slot wheel for Crazy Spinner, a
// grid of numbers for everything else. A page carries only the board its game
// is played on; the other is a detached element, marked and rebuilt like the
// real one and seen by nobody, so nothing that marks the board has to ask.
const onWheel = () => { const g = game(); return !!g && g.kind === 'CrazySpinner' && g.outcomes === SLOTS; };
const orDetached = id => $(id) || document.createElement('div');
const grid = orDetached('numbers'), wheelBoard = orDetached('wheel-board'), pickTools = orDetached('pick-tools');

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
    grid.classList.toggle('dice', onDice());
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.dataset.i = i;
      if (onDice()) { b.innerHTML = dieFace(i); b.setAttribute('aria-label', label(i)); }
      else b.textContent = label(i);
      b.onclick = () => pick(i);
      grid.appendChild(b);
    }
  }
  pickTools.hidden = g.picks < 2; // one number needs no filling aids
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
  const count = $('pick-count'); if (count) count.innerHTML = g && g.picks > 1 ? meta('picked', `${selected.length}/${g.picks}`) : '';
  updateBetButton();
}

// Filling a card of six by hand is tedious; quick pick draws one at random.
// Only bingo's page has the tools.
if ($('quick')) $('quick').onclick = () => {
  const g = game();
  if (!g) return;
  const pool = [...Array(g.outcomes).keys()];
  selected = [];
  while (selected.length < g.picks && pool.length) {
    selected.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  syncPicks();
};
if ($('clear')) $('clear').onclick = () => { selected = []; syncPicks(); };

// ---- betting ----
let selected = [], round = null, lastSeenRound = null, lastResult = null, snapshot = null;
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
document.addEventListener('account', updateBetButton);
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
  ? (onDice() ? numbers.map(n => dieFace(n, 'mini') + `<span class="sr">${esc(label(n))}</span>`).join('')
              : esc(numbers.map(label).join(' ')))
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
  $('bets-count').textContent = round.bets.length || '';
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
  pickTools.hidden = picks < 2 || !open; // nothing to pick while the drum turns
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

// Dice's result: the die is thrown, tumbles and comes to rest on the rolled
// face. Its pips appear as it settles, so the face reads as landed, not drawn.
function diceRoll(roll) {
  return `<div class="res-die roll" role="img" aria-label="The die shows ${esc(label(roll))}">`
    + `<div class="die-shadow"></div><div class="tumble">${dieFace(roll, 'big')}</div></div>`;
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
  // Bingo, the coin and the die draw their result here; the spinner's own wheel above
  // has just landed on it, so this card only records the number it stopped at.
  const g = game();
  const roll = r.draws[0];
  const cap = resultMetas(r, g && g.picks > 1 ? meta('drawn', `${r.draws.length}/${g.outcomes}`) : '');
  el.innerHTML = (g && g.picks > 1
      ? bingoDrum(r.draws) + cap
    : g && g.kind === 'CoinFlip' && g.outcomes === 2
      ? coinFlip(roll) + cap
    : onDice()
      ? diceRoll(roll) + cap
      : `<div class="roll">${label(roll)}</div>` + cap)
    + (rows ? `<div class="tscroll"><table><tbody>${rows}</tbody></table></div>` : '')
    + `<div class="metas" style="margin-top:10px">${meta('key', keyChip(r.ckd.key || r.ckd.big_c))}</div>`;
}

// Check a settled round on the Verify button, in four parts, none of which
// trusts either contract. The exchange: `big_c` pairing-checks as the MPC
// network's derived key for this round's path, encrypted to the round's app
// key (js/ckd.js; null when that module could not load). The secret: `sk`,
// published once the round had drawn, is the scalar behind that app key and
// opens `big_c` to the recorded `key` — the randomness itself. The draws: every
// number recomputed from the stored preimages. The request: the casino asked
// the MPC contract for this path exactly once, counted off the indexer (null
// when it cannot be reached). The key order of the JSON is what the contract
// hashes, so `input` goes in as it came off the RPC, then `draw`, `drawn` and
// the exchange field by field. One exchange for the round: `draw` and `drawn`
// are what make each preimage its own.
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
    if (v.ckd !== null) continue;
    const [g, i] = key.split(':').map(Number);
    checkKey(g, i, rollCache.get(key)).then(k => {
      Object.assign(v, k || {});
      const el = document.getElementById(`v-${g}-${i}`); if (el) sealFor(el, v);
      renderVerifySummary();
    });
  }
});
// The three cryptographic verdicts, or null when the module is not there.
async function checkKey(g, i, record) {
  if (!(await ckdReady) || !record) return null;
  try { return await window.verifyKey(CONTRACT, derivationPath(g, i), record.ckd); } catch (e) { return null; }
}
// How many times the casino asked the MPC contract for each path, over the
// account's whole history: a path asked for twice would let whoever asked pick
// between two answers. Null when the indexer cannot be reached.
async function ckdQueries() {
  const counts = new Map();
  let cursor = null;
  try {
    for (let page = 0; page < 8; page++) {
      const res = await fetch(`${INDEXER}/v1/account/${CONTRACT}/receipts?to=${MPC_CONTRACT}`
        + `&method=request_app_private_key&per_page=50${cursor ? '&cursor=' + cursor : ''}`);
      if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
      const json = await res.json();
      for (const t of json.txns || []) for (const a of t.actions || []) {
        if (a.method !== 'request_app_private_key') continue;
        try { const p = JSON.parse(a.args).request.derivation_path; counts.set(p, (counts.get(p) || 0) + 1); }
        catch (e) { /* a request this page cannot read is not one of the casino's */ }
      }
      cursor = json.cursor;
      if (!cursor) break;
    }
  } catch (e) { return null; }
  return counts;
}
async function verifyRoll(g, i, record, queries) {
  const key = `${g}:${i}`;
  const cached = verified.get(key);
  if (cached) { // only the halves that were unavailable are retried
    if (cached.ckd === null) Object.assign(cached, (await checkKey(g, i, record)) || {});
    if (cached.queries === null) cached.queries = queries;
    return cached;
  }
  try {
    const input = await view('get_roll_input', { round_id: i, game_id: g });
    if (!input || !record.draws.length || !record.ckd) return null;
    const drawn = [];
    let draws = true;
    for (let d = 0; draws && d < record.draws.length; d++) {
      const { pk1, pk2, big_y, big_c, sk, key } = record.ckd;
      const preimage = JSON.stringify({ input, draw: d, drawn: [...drawn], ckd: { pk1, pk2, big_y, big_c, sk, key } });
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage)));
      let r = 0n; for (const b of hash) r = (r << 8n) | BigInt(b);
      const left = [];
      for (let n = 0; n < input.outcomes; n++) if (!drawn.includes(n)) left.push(n);
      draws = left[Number(r % BigInt(left.length))] === record.draws[d];
      drawn.push(record.draws[d]);
    }
    const result = { draws, ckd: null, secret: null, opened: null, queries, ...((await checkKey(g, i, record)) || {}) };
    verified.set(key, result);
    return result;
  } catch (e) { return null; }
}
// Each check as a verdict: true, false, or null for one that could not run.
const CHECKS = [
  ['draws', v => v.draws, 'every number recomputed from get_roll_input and the key', 'a recomputed draw does not match!', ''],
  ['ckd', v => v.ckd, 'big_c pairing-checks as the MPC network\'s derived key for this round, encrypted to its app key',
    'big_c is not the MPC network\'s derived key for this round!', 'the pairing library did not load'],
  ['secret', v => v.secret, 'sk is the scalar behind pk1 and pk2', 'sk is not the secret of the round\'s app key!',
    'no secret on record, or the pairing library did not load'],
  ['opened', v => v.opened, 'big_c opened with sk is the recorded key', 'big_c does not open to the recorded key!',
    'no secret on record, or the pairing library did not load'],
  ['one query', v => v.queries === null ? null : v.queries === 1, 'the MPC contract was asked for this round\'s path once',
    v => `the MPC contract was asked for this round's path ${v.queries} times! The network derives the same key for the same path, `
      + 'and the earlier answer was published, so this round\'s randomness was knowable before it drew.',
    'the indexer could not be reached'],
];
const verdicts = v => CHECKS.map(([name, of, ok, bad, none]) => {
  const r = of(v);
  return { name, r, text: r === true ? ok : r === false ? (typeof bad === 'function' ? bad(v) : bad) : none };
});
// Green only when every check holds; amber when none fails but some could not
// run; red when any fails.
const mark = r => r === true ? '✓' : r === false ? '✗' : '–';
function sealFor(el, v) {
  const vs = verdicts(v);
  const bad = vs.some(x => x.r === false), part = vs.some(x => x.r === null);
  el.textContent = bad ? '✗' : '✓';
  el.className = 'seal ' + (bad ? 'bad' : part ? 'part' : 'ok');
  // The verdicts live on the seal for the tooltip below; the label carries them
  // to a screen reader, and the tabindex lets a keyboard reach them.
  el._verdicts = vs;
  el.removeAttribute('title');
  el.tabIndex = 0;
  el.setAttribute('aria-label', vs.map(x => `${mark(x.r)} ${x.name}: ${x.text}`).join('. '));
}
// One tooltip for every seal: hover or focus a seal and the five verdicts open
// under it, the failing one in red, so a cross says what did not hold. Fixed to
// the viewport so no card or scroll box can clip it.
const vtip = document.createElement('div');
vtip.id = 'vtip'; vtip.className = 'vtip'; vtip.setAttribute('role', 'tooltip'); vtip.hidden = true;
document.body.appendChild(vtip);
function showTip(el) {
  const vs = el._verdicts; if (!vs) return;
  const ok = vs.filter(x => x.r === true).length, bad = vs.filter(x => x.r === false).length;
  const round = (el.id.match(/-(\d+)$/) || [])[1];
  vtip.innerHTML = `<div class="vtip-head"><b>Round #${esc(round)}</b><span class="${bad ? 'bad' : ok === vs.length ? 'ok' : 'part'}">`
    + (bad ? `${bad} of ${vs.length} checks failed` : ok === vs.length ? 'all checks hold' : `${ok} of ${vs.length} checks hold, the rest could not run`)
    + `</span></div><ul>` + vs.map(x => `<li class="${x.r === true ? 'ok' : x.r === false ? 'bad' : 'part'}">`
    + `<i>${mark(x.r)}</i><span><b>${esc(x.name)}</b> ${esc(x.text)}</span></li>`).join('') + `</ul>`;
  vtip.hidden = false;
  const r = el.getBoundingClientRect(), pad = 8, w = vtip.offsetWidth, h = vtip.offsetHeight;
  const left = Math.max(pad, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - pad));
  const below = r.bottom + pad + h <= innerHeight || r.top - pad - h < 0;
  vtip.style.left = left + 'px';
  vtip.style.top = (below ? r.bottom + pad : r.top - pad - h) + 'px';
  vtip.classList.toggle('above', !below);
  vtip.style.setProperty('--arrow-x', Math.round(r.left + r.width / 2 - left) + 'px');
  el.setAttribute('aria-describedby', 'vtip');
}
function hideTip() {
  vtip.hidden = true;
  document.querySelectorAll('.seal[aria-describedby]').forEach(s => s.removeAttribute('aria-describedby'));
}
const sealOf = e => e.target instanceof Element ? e.target.closest('.seal') : null;
document.addEventListener('mouseover', e => { const s = sealOf(e); if (s && s._verdicts) showTip(s); });
document.addEventListener('mouseout', e => { const s = sealOf(e); if (s && !(e.relatedTarget instanceof Element && s.contains(e.relatedTarget))) hideTip(); });
document.addEventListener('focusin', e => { const s = sealOf(e); if (s) showTip(s); });
document.addEventListener('focusout', e => { if (sealOf(e)) hideTip(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
// Under the ledger, the checks across every round it shows: how many passed.
function renderVerifySummary() {
  const el = $('verify-summary'), g = gameId;
  const vs = ledger.map(i => verified.get(`${g}:${i}`)).filter(Boolean);
  if (!vs.length) { el.innerHTML = ''; return; }
  const rounds = ledger.filter(i => verified.get(`${g}:${i}`));
  el.innerHTML = CHECKS.map(([name, of]) => {
    const rs = vs.map(of), ok = rs.filter(r => r === true).length, bad = rs.some(r => r === false);
    const failed = rounds.filter((i, k) => rs[k] === false).map(i => `#${i}`), unrun = rounds.filter((i, k) => rs[k] === null).map(i => `#${i}`);
    const title = (failed.length ? `✗ failed on round ${failed.join(', ')}` : '')
      + (failed.length && unrun.length ? '\n' : '') + (unrun.length ? `– could not run on round ${unrun.join(', ')}` : '');
    return meta(name, bad ? `${ok}/${vs.length} ✗` : rs.some(r => r === null) ? `${ok}/${vs.length} –` : `${ok}/${vs.length} ✓`,
      bad ? 'warn' : ok === vs.length ? 'gold' : '').replace('<span class="meta', `<span title="${esc(title)}" class="meta`);
  }).join('');
}

const rollCache = new Map();
// Rounds the ledger shows that drew; what Verify checks.
let ledger = [];
async function renderRolls(currentRound) {
  const g = gameId, key = i => `${g}:${i}`;
  const ids = []; for (let i = currentRound - 1; i >= 0 && ids.length < 8; i--) ids.push(i);
  for (const i of ids.filter(i => !rollCache.has(key(i)))) rollCache.set(key(i), await view('get_roll', { round_id: i, game_id: g })); // sequential: bursts get rate-limited
  ledger = ids.filter(i => { const r = rollCache.get(key(i)); return r && r.draws.length; });
  $('rolls').innerHTML = ids.map(i => { const r = rollCache.get(key(i)); const drew = r && r.draws.length;
    return `<div class="lrow"><span class="rid">#${i}</span>`
      + (drew ? `<span class="seal" id="v-${g}-${i}">✓</span>` + drumRow(r.draws) + keyChip(r.ckd.key || r.ckd.big_c)
              : `<span class="dash">—</span>`) + `</div>`; }).join('')
    || '<div class="empty">No draws yet.</div>';
  // Seals stay empty until Verify; rounds it already checked keep theirs.
  for (const i of ledger) { const v = verified.get(key(i)); if (v) sealFor(document.getElementById(`v-${g}-${i}`), v); }
  renderVerifySummary();
  $('verify').disabled = !ledger.length;
}
$('verify').onclick = async () => {
  const g = gameId, btn = $('verify');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const queries = await ckdQueries(); // one pass over the indexer for every round below
    for (const i of ledger) {
      const n = queries ? queries.get(derivationPath(g, i)) || null : null; // unseen: the window ran out, not proof of anything
      const v = await verifyRoll(g, i, rollCache.get(`${g}:${i}`), n);
      const el = document.getElementById(`v-${g}-${i}`); if (el && v) sealFor(el, v);
    }
    renderVerifySummary();
  } finally { btn.textContent = 'Verify'; btn.disabled = !ledger.length; }
};

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

// ---- the tick ----
// One call per tick: games + round + last result. The first tick has one more
// to make, the games list that says which id this page's kind was registered
// under; a contract without the game leaves the table dark.
async function tick() {
  if (gameId === null) {
    const g = (await view('get_snapshot', {})).games.find(g => g.kind === KIND);
    if (!g) {
      stopPolling();
      $('stage').innerHTML = `<div class="empty">This contract has no ${esc(KIND)} table. <a href="${pageUrl('index.html')}">Back to the lobby</a>.</div>`;
      return;
    }
    gameId = g.game_id;
  }
  const snap = await view('get_snapshot', { game_id: gameId });
  snapshot = snap; setGames(snap.games);
  const r = snap.round, last = snap.last_round;
  round = r; renderRound();
  if (last && (!lastResult || last.round_id !== lastResult.round_id)) {
    if (lastResult !== null || lastSeenRound !== null) showBanner(last);
    lastResult = last; renderLast(last); landWheel(last); rollCache.delete(`${gameId}:${last.round_id}`);
  } else if (!last) renderLast(null);
  if (lastSeenRound !== r.round_id) { lastSeenRound = r.round_id; await renderRolls(r.round_id); }
}

// ---- wallet redirect result ----
// MyNearWallet comes back to this page with the outcome in the query string;
// shown once, then taken off the URL so a reload does not repeat it.
if (params.get('transactionHashes')) {
  const h = params.get('transactionHashes').split(',')[0];
  toast('Bet placed.'); $('last').insertAdjacentHTML('afterbegin', `<div class="hint">Your tx: <a target="_blank" href="${EXPLORER}/txns/${h}">${short(h)}</a></div>`);
}
if (params.get('errorCode')) toast('Wallet: ' + decodeURIComponent(params.get('errorMessage') || params.get('errorCode')), true);
// Throws when the page is not on an http(s) origin (opened as file:// or data:).
if (params.get('transactionHashes') || params.get('errorCode')) try { history.replaceState(null, '', pageUrl(location.pathname)); } catch (e) { /* ignore */ }

$('home').href = pageUrl('index.html');
updateBetButton();
startPolling(tick, () => round && round.state !== 'Open' ? POLL_FAST_MS : POLL_MS);
