// The lobby: one card per game the contract has, each a link to that game's
// page. Loads after js/common.js.
let games = [], snapshot = null;

// ---- card art ----
// Inline SVG rather than image files: the page is a single static file and the
// art has to survive being served from anywhere.
const ball = (cx, cy, r, fill, fg, n, cls) =>
  `<g class="ball ${cls}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`
  + `<ellipse cx="${cx - r * .48}" cy="${cy - r * .52}" rx="${r * .3}" ry="${r * .17}" fill="#fff" fill-opacity=".45" transform="rotate(-35 ${cx - r * .48} ${cy - r * .52})"/>`
  + `<circle cx="${cx}" cy="${cy}" r="${r * .64}" fill="#fdfbf4" fill-opacity=".92"/>`
  + `<text x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="${(r * .72).toFixed(0)}" font-weight="800" fill="${fg}">${n}</text></g>`;

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

function renderLobby() {
  // A game of a kind this frontend has no page for gets a card that says so.
  $('game-grid').innerHTML = games.map(g => {
    const page = PAGES[g.kind];
    return `<${page ? `a class="game-card" href="${pageUrl(page)}"` : 'div class="game-card"'}>
      <div class="art-wrap">${ART[g.kind] || ART._}</div>
      <div class="gc-body">
        <div class="gc-top"><h3>${esc(g.name)}</h3><span class="chip">${g.picks > 1 ? `pick ${g.picks} of ${g.outcomes}` : `${g.outcomes} outcomes`}</span>${g.default ? '<span class="chip feat">Featured</span>' : ''}</div>
        <dl class="gc-meta" title="${esc(g.rules)}">
          <div><dt>Round</dt><dd>#${g.round_id}</dd></div>
          <div><dt>Min bet</dt><dd>${fmtNear(g.min_bet)}</dd></div>
          <div><dt>Rolls at</dt><dd>${fmtNear(g.threshold)}</dd></div>
        </dl>
        <div class="gc-foot">${g.state === 'Open' ? '' : `<span class="badge ${g.state}">${g.state}</span>`}<span class="gc-play">${page ? 'Play' : 'No table'}</span></div>
      </div>
    </${page ? 'a' : 'div'}>`;
  }).join('')
    || `<div class="empty">${snapshot ? 'This contract has no games registered.' : 'Loading games…'}</div>`;
  if (snapshot) $('house').innerHTML = meta('games', games.length)
    + meta('house cut', snapshot.cut_bps / 100 + '%')
    + meta('collected', fmtNear(snapshot.house_gains), 'gold');
}

// One call per tick, the games list; the cards are only redrawn when something
// on them moved, so a hover animation is not cut short by the poll.
startPolling(async () => {
  const snap = await view('get_snapshot', {});
  const key = l => JSON.stringify(l.map(g => [g.game_id, g.round_id, g.state, g.min_bet, g.threshold, g.outcomes, g.picks]));
  const changed = !snapshot || key(snap.games) !== key(games);
  snapshot = snap; games = snap.games;
  // The tables used to live at ?game=<id> on this page; old links still land.
  const old = params.has('game') && games.find(g => g.game_id === Number(params.get('game')));
  if (old && PAGES[old.kind]) return location.replace(pageUrl(PAGES[old.kind]));
  if (changed) renderLobby();
});
