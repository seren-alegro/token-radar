'use strict';
const R = window.RADAR, rows = R.rows, bySlug = {};
rows.forEach(r => { bySlug[r.slug] = r; });
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function money(v) {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
}
const pct = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
const age = d => d == null ? 'unknown' : d >= 730 ? (d / 365.25).toFixed(1) + ' yrs' : d >= 60 ? Math.round(d / 30.4) + ' mo' : d + ' days';
const fx = v => v.toFixed(4);
const svgA = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="${p}"/></svg>`;
const CH_UP = svgA('M5 14.5l7-7 7 7'), CH_DN = svgA('M5 9.5l7 7 7-7');
const ICO_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19.5 12h-15M10.5 6l-6 6 6 6"/></svg>`;

/* ---------- header stats ---------- */
(function stats() {
  const total = rows.reduce((a, r) => a + r.implied_value_usd, 0);
  const wl = rows.filter(r => r.on_watchlist).length;
  $('#stats').innerHTML =
    [['On the board', rows.length], ['Watchlist entries', wl], ['Combined implied value', money(total)],
     ['Snapshot date', R.as_of], ['TVL floor', money(R.floor_usd)]]
    .map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
})();

/* ---------- board state ---------- */
const S = { q: '', cat: '', chain: '', watch: false, sort: 'rank', dir: 1 };
let boardHash = '#/';
(function fillFilters() {
  const cats = [...new Set(rows.map(r => r.category))].sort();
  const chains = [...new Set(rows.flatMap(r => r.chains))].sort();
  $('#fCat').innerHTML += cats.map(c => `<option>${esc(c)}</option>`).join('');
  $('#fChain').innerHTML += chains.map(c => `<option>${esc(c)}</option>`).join('');
})();
function syncControls() {
  $('#q').value = S.q; $('#fCat').value = S.cat; $('#fChain').value = S.chain; $('#fWatch').checked = S.watch;
  document.querySelectorAll('th.sortable').forEach(th => {
    const a = th.querySelector('.arr');
    if (a) a.innerHTML = th.dataset.k === S.sort ? (S.dir > 0 ? CH_UP : CH_DN) : '';
  });
}
function stateHash() {
  const p = new URLSearchParams();
  if (S.q) p.set('q', S.q); if (S.cat) p.set('category', S.cat); if (S.chain) p.set('chain', S.chain);
  if (S.watch) p.set('watch', '1'); if (S.sort !== 'rank') p.set('sort', S.sort); if (S.dir < 0) p.set('dir', 'desc');
  const s = p.toString(); return '#/' + (s ? '?' + s : '');
}
function applyState(push) {
  boardHash = stateHash();
  if (push) history.replaceState(null, '', boardHash);
  syncControls(); renderBoard();
}
function filtered() {
  const q = S.q.toLowerCase();
  let out = rows.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!S.cat || r.category === S.cat) &&
    (!S.chain || r.chains.includes(S.chain)) &&
    (!S.watch || r.on_watchlist));
  const k = S.sort;
  out.sort((a, b) => {
    let x = a[k], y = b[k];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * S.dir;
  });
  return out;
}
function renderBoard() {
  const out = filtered();
  $('#count').textContent = out.length + ' of ' + rows.length + ' protocols';
  $('#tbody').innerHTML = out.map(r => `<tr data-slug="${r.slug}">
    <td class="num">${r.rank}</td>
    <td class="name">${esc(r.name)}${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : ''}<span class="slug">${r.slug}</span></td>
    <td class="cat">${esc(r.category)}</td>
    <td class="chains">${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ' +' + (r.chains.length - 2) : ''}</td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num ${r.change_7d == null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
    <td class="num val">${money(r.implied_value_usd)}</td></tr>`).join('');
}
$('#q').addEventListener('input', e => { S.q = e.target.value.trim(); applyState(true); });
$('#fCat').addEventListener('change', e => { S.cat = e.target.value; applyState(true); });
$('#fChain').addEventListener('change', e => { S.chain = e.target.value; applyState(true); });
$('#fWatch').addEventListener('change', e => { S.watch = e.target.checked; applyState(true); });
document.querySelectorAll('th.sortable').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k;
  if (S.sort === k) S.dir *= -1; else { S.sort = k; S.dir = k === 'name' ? 1 : -1; if (k === 'rank') S.dir = 1; }
  applyState(true);
}));
$('#tbody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-slug]');
  if (tr) location.hash = '#/p/' + tr.dataset.slug;
});

/* ---------- detail ---------- */
function renderDetail(slug) {
  const r = bySlug[slug];
  if (!r) { location.hash = '#/'; return; }
  const el = $('#detailView');
  el.innerHTML = `<div class="detail">
    <a class="back" href="${boardHash}">${ICO_BACK} Back to the board</a>
    <h2>${esc(r.name)}${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : ''}</h2>
    <p class="meta">Rank <b>#${r.rank}</b> of ${rows.length} · <b>${esc(r.category)}</b> · tokenless for <b>${age(r.age_days)}</b> · runs on ${r.chains.length} chain${r.chains.length > 1 ? 's' : ''}: ${esc(r.chains.join(', '))}</p>
    <div class="grid">
      ${[['Implied launch value', money(r.implied_value_usd)], ['TVL', money(r.tvl_usd)], ['TVL change, 7d', pct(r.change_7d)],
        ['Peer multiple', fx(r.peer_multiple)], ['Growth factor', fx(r.growth_factor)], ['Maturity factor', fx(r.maturity_factor)]]
        .map(([k, v]) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('')}
    </div>
    <section class="calc"><h3>How this value is worked out</h3>
      <div class="row"><span>TVL in the snapshot</span><span>${money(r.tvl_usd)}</span></div>
      <div class="row"><span>× peer multiple for ${esc(r.category)} (40th percentile of tokenized peers, ×0.85 launch discount)</span><span>× ${fx(r.peer_multiple)}</span></div>
      <div class="row"><span>× growth factor (7d TVL change ${pct(r.change_7d)}, weighted 0.45)</span><span>× ${fx(r.growth_factor)}</span></div>
      <div class="row"><span>× maturity factor (${age(r.age_days)} without a token)</span><span>× ${fx(r.maturity_factor)}</span></div>
      <div class="row total"><span>Implied launch value</span><span>${money(r.implied_value_usd)}</span></div>
      <p class="note">What a launch might be worth if the market priced this token like the cheaper half of its already-tokenized ${esc(r.category)} peers. An estimate for ranking, not a forecast — see the Method tab for the full model, including the fallback multiple used when a category has too few peers to price itself.</p>
    </section>
    <section class="farm"><h3>Farm plan — how to become an active user</h3>
      <ol>${r.farm_steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    </section></div>`;
}

/* ---------- router ---------- */
function route() {
  const h = location.hash.slice(1) || '/';
  const view = h.startsWith('/p/') ? 'detail' : h.startsWith('/method') ? 'method' : 'board';
  $('#boardView').hidden = view !== 'board';
  $('#detailView').hidden = view !== 'detail';
  $('#methodView').hidden = view !== 'method';
  document.querySelectorAll('.tabs a').forEach(a =>
    a.classList.toggle('on', a.dataset.nav === view || (view === 'detail' && a.dataset.nav === 'board')));
  if (view === 'detail') renderDetail(h.slice(3));
  if (view === 'board') {
    const p = new URLSearchParams(h.split('?')[1] || '');
    S.q = p.get('q') || ''; S.cat = p.get('category') || ''; S.chain = p.get('chain') || '';
    S.watch = p.get('watch') === '1'; S.sort = p.get('sort') || 'rank'; S.dir = p.get('dir') === 'desc' ? -1 : 1;
    boardHash = location.hash || '#/';
    syncControls(); renderBoard();
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
