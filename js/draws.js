// The full history of one game, back to round 0. The recent-draws ledger on a
// game's own page only ever shows its last ten; this page is where the rest of
// them live, walked backwards from the current round in batches so a long
// history does not mean one huge burst of requests. Loads after js/common.js.
const PAGE = 20;

function noGame() {
  $('title-text').textContent = 'All draws';
  $('rolls').innerHTML = `<div class="empty">Open a game from the <a href="${pageUrl('index.html')}">lobby</a> and follow its "All draws" link.</div>`;
}

async function init() {
  let snap;
  try { snap = await view('get_snapshot', {}); }
  catch (e) { $('rolls').innerHTML = '<div class="empty">Could not reach the contract.</div>'; return; }
  const gid = params.has('game') ? Number(params.get('game')) : null;
  const g = gid === null ? null : snap.games.find(x => x.game_id === gid);
  if (!g) return noGame();

  $('home').href = pageUrl(PAGES[g.kind] || 'index.html');
  document.title = `${g.name} · all draws · ${BRAND}`;
  $('game-title').textContent = g.name;
  $('draws-meta').innerHTML = meta('current round', '#' + g.round_id)
    + meta(g.picks > 1 ? 'pick' : 'outcomes', g.picks > 1 ? `${g.picks} of ${g.outcomes}` : g.outcomes);
  const label = n => g.labels ? g.labels[n] : String(n);

  let nextId = g.round_id - 1, first = true;
  if (nextId < 0) { $('rolls').innerHTML = '<div class="empty">No draws yet.</div>'; return; }
  $('rolls').innerHTML = '<div class="empty">Loading…</div>';

  const btn = $('load-more');
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Loading…';
    const batch = []; for (let i = nextId; i >= 0 && batch.length < PAGE; i--) batch.push(i);
    let html = '';
    for (const i of batch) {
      const r = await view('get_roll', { round_id: i, game_id: gid }); // sequential: bursts get rate-limited
      const drew = r && r.draws.length;
      html += `<div class="lrow"><span class="rid">#${i}</span>`
        + (drew ? drumRow(r.draws, label) + keyChip(r.ckd.key || r.ckd.big_c) : '<span class="dash">—</span>') + `</div>`;
    }
    if (first) { $('rolls').innerHTML = ''; first = false; }
    $('rolls').insertAdjacentHTML('beforeend', html);
    nextId -= batch.length;
    btn.textContent = 'Load older draws';
    btn.disabled = false;
    btn.hidden = nextId < 0;
  };
  btn.hidden = false;
  await btn.onclick();
}
init();
