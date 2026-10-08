/* ETF flow tracker — shared renderer.
 *
 * Reads the JSON written by scripts/update.py and renders:
 *   - stat tiles (headline numbers, each with a one-line reading)
 *   - daily net flow (diverging bars)
 *   - cumulative flow (area + line)
 *   - shares outstanding (step line — makes the basket mechanics visible)
 *   - fund table, listing watch, session table, CSV export
 *
 * No dependencies, no dual-axis charts, hover layer on every plot.
 */
(() => {
  'use strict';

  const SRC = document.body.dataset.src;
  const ASSET = document.body.dataset.asset || '';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

  let DATA = null, RANGE = 'all', GRAIN = 'd', showTable = false;

  /* ---------- formatting ---------- */
  const fmtUSD = (v, signed = false) => {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v), s = v < 0 ? '-' : (signed && v > 0 ? '+' : '');
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
    return `${s}$${a.toFixed(0)}`;
  };
  const fmtUSDfull = v => v == null ? '—' : (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtNum = (v, d = 0) => v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPct = v => v == null ? '—' : (v * 100).toFixed(2) + '%';
  const d2 = iso => { const [y, m, d] = iso.split('-'); return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]}`; };
  const d3 = iso => { const [y, m, d] = iso.split('-'); return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y.slice(2)}`; };
  const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat';

  /* ---------- range filter ---------- */
  function visible() {
    const s = DATA.series;
    if (RANGE === 'all' || s.length === 0) return s;
    const days = { '1m': 30, '3m': 91, '6m': 182 }[RANGE] || 1e9;
    const last = new Date(s[s.length - 1].date + 'T00:00:00Z').getTime();
    return s.filter(r => (last - new Date(r.date + 'T00:00:00Z').getTime()) / 864e5 <= days);
  }

  /* ---------- weekly aggregation ----------
     235 daily bars of a series that prints on 14% of sessions is hard to read.
     Weekly buckets (Mon-start) sum the flow and carry the last session's state. */
  function weekKey(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    const back = (d.getUTCDay() + 6) % 7;          // Mon = 0
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  }

  function grained() {
    const rows = visible();
    if (GRAIN !== 'w' || rows.length < 10) return rows;
    const out = [], idx = new Map();
    for (const r of rows) {
      const k = weekKey(r.date);
      if (!idx.has(k)) {
        idx.set(k, out.length);
        out.push({ ...r, date: k, flow: 0, week_of: k, sessions: 0 });
      }
      const w = out[idx.get(k)];
      w.flow = +(w.flow + r.flow).toFixed(2);
      w.sessions++;
      // state fields follow the latest session in the bucket
      w.by_fund = r.by_fund; w.net_assets = r.net_assets;
      w.cum_flow = r.cum_flow; w.estimated = w.estimated || r.estimated;
      w.last_session = r.date;
    }
    return out;
  }

  /* n-period centred-trailing mean, for the trend line over lumpy bars */
  function movingAvg(vals, n) {
    const out = [];
    for (let i = 0; i < vals.length; i++) {
      const from = Math.max(0, i - n + 1);
      const slice = vals.slice(from, i + 1);
      out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    return out;
  }

  /* ---------- tiles ---------- */
  function tiles() {
    const s = DATA.series, host = $('#tiles');
    host.textContent = '';
    if (!s.length) return;
    const last = s[s.length - 1];
    const flows = s.map(r => r.flow);
    const maxV = Math.max(...flows), minV = Math.min(...flows);
    const maxR = s[flows.indexOf(maxV)], minR = s[flows.indexOf(minV)];
    const active = s.filter(r => Math.abs(r.flow) > 1).length;
    const recent = s.slice(-21), recentActive = recent.filter(r => Math.abs(r.flow) > 1).length;
    const sum5 = s.slice(-5).reduce((a, r) => a + r.flow, 0);
    const estCount = s.filter(r => r.estimated).length;
    const fee = (DATA.funds.find(f => f.status === 'live') || {}).fee;

    const add = (label, value, valCls, note, small) => {
      const t = el('div', 'tile');
      t.append(el('div', 'label', label));
      const v = el('div', 'value' + (small ? ' sm' : '') + (valCls ? ' ' + valCls : ''), value);
      t.append(v);
      if (note) { const n = el('div', 'note'); n.innerHTML = note; t.append(n); }
      host.append(t);
    };

    add('Latest session', fmtUSD(last.flow, true), cls(last.flow),
      `<b>${d3(last.date)}</b> — the issuer's own as-of date, not today. ${last.flow === 0 ? 'No basket was struck.' : 'Net of redemptions.'}`);

    add('Cumulative net flow', fmtUSD(DATA.series[DATA.series.length - 1].cum_flow, true),
      cls(last.cum_flow), `Every creation since launch, <b>price excluded</b>. Compare with net assets to read the mark-to-market.`);

    add('Net assets', fmtUSD(last.net_assets), '',
      `What the complex is worth today. Diverges from cumulative flow by ${ASSET} price moves minus fees.`);

    add('Largest session', fmtUSD(maxV, true), cls(maxV),
      `<b>${d3(maxR.date)}</b>${maxR.estimated ? ' (estimated)' : ''}. Creation units land in lumps — cadence beats any single record.`);

    const pct = 100 * active / s.length;
    add('Sessions with a print', `${active} / ${s.length}`, '',
      `${pct < 50 ? 'Only ' : ''}<b>${pct.toFixed(0)}%</b> of sessions moved share count. ` +
      `${recentActive} of the last ${recent.length}.`, true);

    add('Last 5 sessions', fmtUSD(sum5, true), cls(sum5), 'A rolling sum reads demand better than one day does.', true);

    if (minV < 0) add('Worst session', fmtUSD(minV, true), 'neg',
      `<b>${d3(minR.date)}</b>. Redemptions, not price — shares were actually retired.`, true);

    // Days since the last creation/redemption — the cadence stat as a countdown.
    let since = null;
    for (let i = s.length - 1; i >= 0; i--) {
      if (Math.abs(s[i].flow) > 1) { since = s.length - 1 - i; break; }
    }
    if (since !== null) add('Sessions since a print', String(since), since > 5 ? 'neg' : '',
      since === 0 ? 'The latest session moved share count.'
        : `No basket struck in <b>${since}</b> session${since === 1 ? '' : 's'}. Long gaps are this complex's normal state, not a stall.`, true);

    // The gap between cumulative flow and net assets, named rather than implied.
    const effect = last.net_assets - last.cum_flow;
    add('Price & fee effect', fmtUSD(effect, true), cls(effect),
      `Net assets minus cumulative flow. This is what ${ASSET} price moves and the sponsor fee have done to money that was already in — <b>not</b> flow.`, true);

    if (DATA.coins_total && DATA.coins_total.amount)
      add(`${ASSET} held`, fmtNum(DATA.coins_total.amount), '',
        `Coins in custody across the complex${DATA.coins_total.as_of ? `, as of ${d3(DATA.coins_total.as_of)}` : ''}. Rises with creations, falls with the fee.`, true);

    if (fee != null) add('Sponsor fee', fmtPct(fee), '',
      (DATA.funds.find(f => f.status === 'live') || {}).stakes
        ? 'Plus a share of staking rewards taken as a staking expense.'
        : 'Accrues daily against assets, so flat flow still erodes the coin count.', true);

    if (estCount) add('Estimated sessions', `${estCount}`, '',
      'Reconstructed from on-chain custody balances because the issuer series does not exist. Indicative only.', true);
  }

  /* ---------- chart helpers ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (t, attrs = {}) => { const n = document.createElementNS(NS, t); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

  const fmtUnit = (v, hi) => hi >= 1e6 ? (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M'
    : hi >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(Math.round(v));

  function ticks(lo, hi, n = 4) {
    const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function dateTicks(rows, n = 6) {
    if (rows.length <= n) return rows.map((_, i) => i);
    const step = Math.ceil(rows.length / n), out = [];
    for (let i = rows.length - 1; i >= 0; i -= step) out.push(i);
    return out.reverse();
  }

  function tooltip(host) {
    const tip = el('div', 'tip'); host.append(tip);
    return {
      show(x, y, html) {
        tip.innerHTML = html; tip.style.opacity = 1;
        const w = tip.offsetWidth, hostW = host.clientWidth;
        tip.style.left = Math.max(2, Math.min(hostW - w - 2, x - w / 2)) + 'px';
        tip.style.top = Math.max(0, y) + 'px';
      },
      hide() { tip.style.opacity = 0; }
    };
  }

  const tipRows = r => {
    const head = r.week_of
      ? `<div class="t-date">week of ${d3(r.week_of)} · ${r.sessions} sessions</div>` : '';
    const f = DATA.live_tickers.length > 1
      ? DATA.live_tickers.map(t => r.by_fund[t] ? `<div class="t-row"><span>${t}</span><span class="${cls(r.by_fund[t].flow)}">${fmtUSD(r.by_fund[t].flow, true)}</span></div>` : '').join('')
      : '';
    return (head || `<div class="t-date">${d3(r.date)}</div>`) + f +
      `<div class="t-row"><span>Net flow</span><span class="${cls(r.flow)}">${fmtUSDfull(r.flow)}</span></div>` +
      `<div class="t-row"><span>Cumulative</span><span>${fmtUSD(r.cum_flow, true)}</span></div>` +
      `<div class="t-row"><span>Net assets</span><span>${fmtUSD(r.net_assets)}</span></div>` +
      (r.estimated ? '<div class="t-est">estimated from on-chain</div>' : '');
  };

  /* ---------- chart 1: daily net flow bars ---------- */
  function flowChart() {
    const rows = grained(), host = $('#c-flow');
    host.textContent = '';
    if (!rows.length) return;
    const W = 1000, H = 260, m = { t: 8, r: 8, b: 22, l: 52 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vals = rows.map(r => r.flow);
    let hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
    const pad = (hi - lo) * 0.08 || 1; hi += pad; lo -= lo < 0 ? pad : 0;
    const y = v => m.t + ih - (v - lo) / (hi - lo) * ih;
    const bw = Math.max(1.4, Math.min(16, iw / rows.length * 0.68));
    const xc = i => m.l + (i + 0.5) * (iw / rows.length);

    const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily net flow' });
    const g = mk('g', { class: 'axis' });
    for (const t of ticks(lo, hi, 4)) {
      g.append(mk('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      const lab = mk('text', { x: m.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' });
      lab.textContent = fmtUSD(t, true); g.append(lab);
    }
    svg.append(g);
    svg.append(mk('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));

    const tip = tooltip(host);
    rows.forEach((r, i) => {
      const h = Math.abs(y(r.flow) - y(0));
      const rect = mk('rect', {
        class: 'bar ' + (r.flow < 0 ? 'bar-out' : 'bar-in'),
        x: xc(i) - bw / 2, y: Math.min(y(r.flow), y(0)),
        width: bw, height: Math.max(r.flow === 0 ? 0 : 1.5, h), rx: Math.min(2, bw / 3),
        opacity: r.estimated ? 0.55 : 1
      });
      svg.append(rect);
      const hit = mk('rect', { class: 'hit', x: xc(i) - (iw / rows.length) / 2, y: m.t, width: iw / rows.length, height: ih });
      hit.addEventListener('pointerenter', () => {
        rect.setAttribute('stroke', 'var(--text-1)'); rect.setAttribute('stroke-width', '1');
        tip.show(xc(i) / W * host.clientWidth, 6, tipRows(r));
      });
      hit.addEventListener('pointerleave', () => { rect.removeAttribute('stroke'); tip.hide(); });
      svg.append(hit);
    });

    // Trend line: same units as the bars, so it shares the one axis. Daily
    // view only — the weekly buckets already are the smoothing.
    if (GRAIN === 'd' && rows.length >= 20) {
      const N = 10, ma = movingAvg(rows.map(r => r.flow), N);
      svg.append(mk('path', {
        class: 'ma-line',
        d: ma.map((v, i) => `${i ? 'L' : 'M'}${xc(i).toFixed(2)},${y(v).toFixed(2)}`).join('')
      }));
    }

    const ax = mk('g', { class: 'axis' });
    for (const i of dateTicks(rows)) {
      const t = mk('text', { x: xc(i), y: H - 6, 'text-anchor': 'middle' });
      t.textContent = rows.length > 70 ? d3(rows[i].date) : d2(rows[i].date); ax.append(t);
    }
    svg.append(ax);
    host.append(svg);
    const leg = $('#ma-legend');
    if (leg) leg.hidden = !(GRAIN === 'd' && rows.length >= 20);
  }

  /* ---------- chart 2: cumulative flow ---------- */
  function cumChart() {
    const rows = visible(), host = $('#c-cum');
    host.textContent = '';
    if (rows.length < 2) return;
    const W = 1000, H = 190, m = { t: 8, r: 8, b: 22, l: 52 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vals = rows.map(r => r.cum_flow);
    let hi = Math.max(...vals), lo = Math.min(0, ...vals);
    const pad = (hi - lo) * 0.1 || 1; hi += pad;
    const x = i => m.l + i * (iw / (rows.length - 1));
    const y = v => m.t + ih - (v - lo) / (hi - lo) * ih;

    const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Cumulative net flow' });
    const g = mk('g', { class: 'axis' });
    for (const t of ticks(lo, hi, 3)) {
      g.append(mk('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      const lab = mk('text', { x: m.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' });
      lab.textContent = fmtUSD(t, true); g.append(lab);
    }
    svg.append(g);

    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(r.cum_flow).toFixed(2)}`).join('');
    svg.append(mk('path', { class: 'cum-area', d: `${d}L${x(rows.length - 1)},${y(lo)}L${x(0)},${y(lo)}Z` }));
    svg.append(mk('path', { class: 'cum-line', d }));

    const ch = mk('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, opacity: 0 });
    const dot = mk('circle', { class: 'dot', r: 4, opacity: 0 });
    svg.append(ch); svg.append(dot);
    const tip = tooltip(host);
    const hit = mk('rect', { class: 'hit', x: m.l, y: m.t, width: iw, height: ih });
    hit.addEventListener('pointermove', ev => {
      const bb = svg.getBoundingClientRect();
      const px = (ev.clientX - bb.left) / bb.width * W;
      const i = Math.max(0, Math.min(rows.length - 1, Math.round((px - m.l) / (iw / (rows.length - 1)))));
      ch.setAttribute('x1', x(i)); ch.setAttribute('x2', x(i)); ch.setAttribute('opacity', 1);
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(rows[i].cum_flow)); dot.setAttribute('opacity', 1);
      tip.show(x(i) / W * host.clientWidth, 4, tipRows(rows[i]));
    });
    hit.addEventListener('pointerleave', () => { ch.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.hide(); });
    svg.append(hit);

    const ax = mk('g', { class: 'axis' });
    for (const i of dateTicks(rows)) {
      const t = mk('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' });
      t.textContent = d3(rows[i].date); ax.append(t);
    }
    svg.append(ax);
    host.append(svg);
  }

  /* ---------- chart 3: shares outstanding (step) ---------- */
  function sharesChart() {
    const rows = visible(), host = $('#c-shares');
    host.textContent = '';
    const tk = DATA.live_tickers[0];
    const pts = rows.filter(r => r.by_fund[tk]).map(r => ({ date: r.date, v: r.by_fund[tk].shares, est: r.estimated }));
    if (pts.length < 2) return;
    const W = 1000, H = 150, m = { t: 8, r: 8, b: 22, l: 52 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let hi = Math.max(...pts.map(p => p.v)), lo = Math.min(...pts.map(p => p.v));
    const pad = (hi - lo) * 0.12 || hi * 0.05; hi += pad; lo = Math.max(0, lo - pad);
    const x = i => m.l + i * (iw / (pts.length - 1));
    const y = v => m.t + ih - (v - lo) / (hi - lo) * ih;

    const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Shares outstanding' });
    const g = mk('g', { class: 'axis' });
    for (const t of ticks(lo, hi, 4)) {
      g.append(mk('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      const lab = mk('text', { x: m.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' });
      lab.textContent = fmtUnit(t, hi); g.append(lab);
    }
    svg.append(g);

    let d = '';
    pts.forEach((p, i) => {
      if (!i) d += `M${x(0).toFixed(2)},${y(p.v).toFixed(2)}`;
      else d += `L${x(i).toFixed(2)},${y(pts[i - 1].v).toFixed(2)}L${x(i).toFixed(2)},${y(p.v).toFixed(2)}`;
    });
    svg.append(mk('path', { class: 'step', d }));

    const tip = tooltip(host);
    const ch = mk('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, opacity: 0 });
    svg.append(ch);
    const hit = mk('rect', { class: 'hit', x: m.l, y: m.t, width: iw, height: ih });
    hit.addEventListener('pointermove', ev => {
      const bb = svg.getBoundingClientRect();
      const px = (ev.clientX - bb.left) / bb.width * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((px - m.l) / (iw / (pts.length - 1)))));
      ch.setAttribute('x1', x(i)); ch.setAttribute('x2', x(i)); ch.setAttribute('opacity', 1);
      const prev = i ? pts[i - 1].v : null;
      const baskets = prev != null ? (pts[i].v - prev) / ((DATA.funds.find(f => f.ticker === tk) || {}).basket_shares || 1) : null;
      tip.show(x(i) / W * host.clientWidth, 4,
        `<div class="t-date">${d3(pts[i].date)}</div>` +
        `<div class="t-row"><span>Shares out</span><span>${fmtNum(pts[i].v)}</span></div>` +
        (baskets != null ? `<div class="t-row"><span>Baskets</span><span class="${cls(baskets)}">${baskets > 0 ? '+' : ''}${baskets}</span></div>` : '') +
        (pts[i].est ? '<div class="t-est">estimated</div>' : ''));
    });
    hit.addEventListener('pointerleave', () => { ch.setAttribute('opacity', 0); tip.hide(); });
    svg.append(hit);

    const ax = mk('g', { class: 'axis' });
    for (const i of dateTicks(pts)) {
      const t = mk('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' });
      t.textContent = d3(pts[i].date); ax.append(t);
    }
    svg.append(ax);
    host.append(svg);
  }

  /* ---------- chart 4: on-chain custody (only if the page has a slot and the
       data file carries an `onchain` series) ---------- */
  function onchainChart() {
    const sec = $('#onchain-sec'), host = $('#c-onchain');
    if (!sec || !host) return;
    const pts = (DATA.onchain || []).filter(p => p.total_near > 0);
    if (pts.length < 2) { sec.hidden = true; return; }
    sec.hidden = false;
    host.textContent = '';
    const W = 1000, H = 170, m = { t: 8, r: 8, b: 22, l: 58 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let hi = Math.max(...pts.map(p => p.total_near)), lo = 0;
    hi *= 1.08;
    const x = i => m.l + i * (iw / (pts.length - 1));
    const y = v => m.t + ih - (v - lo) / (hi - lo) * ih;

    const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'NEAR held in custody' });
    const g = mk('g', { class: 'axis' });
    for (const t of ticks(lo, hi, 3)) {
      g.append(mk('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      const lab = mk('text', { x: m.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' });
      lab.textContent = fmtUnit(t, hi);
      g.append(lab);
    }
    svg.append(g);
    svg.append(mk('path', {
      class: 'step',
      d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p.total_near).toFixed(2)}`).join('')
    }));

    const ch = mk('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, opacity: 0 });
    svg.append(ch);
    const tip = tooltip(host);
    const hit = mk('rect', { class: 'hit', x: m.l, y: m.t, width: iw, height: ih });
    hit.addEventListener('pointermove', ev => {
      const bb = svg.getBoundingClientRect();
      const px = (ev.clientX - bb.left) / bb.width * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((px - m.l) / (iw / (pts.length - 1)))));
      const p = pts[i], prev = i ? pts[i - 1] : null;
      ch.setAttribute('x1', x(i)); ch.setAttribute('x2', x(i)); ch.setAttribute('opacity', 1);
      tip.show(x(i) / W * host.clientWidth, 4,
        `<div class="t-date">${d3(p.date)}</div>` +
        `<div class="t-row"><span>Total held</span><span>${fmtNum(p.total_near)}</span></div>` +
        `<div class="t-row"><span>Staked</span><span>${fmtNum(p.staked_near)}</span></div>` +
        `<div class="t-row"><span>Liquid</span><span>${fmtNum(p.liquid_near)}</span></div>` +
        (prev ? `<div class="t-row"><span>Change</span><span class="${cls(p.total_near - prev.total_near)}">${(p.total_near - prev.total_near) > 0 ? '+' : ''}${fmtNum(p.total_near - prev.total_near)}</span></div>` : '') +
        (p.near_usd ? `<div class="t-row"><span>At ${'$' + p.near_usd.toFixed(2)}</span><span>${fmtUSD(p.total_near * p.near_usd)}</span></div>` : ''));
    });
    hit.addEventListener('pointerleave', () => { ch.setAttribute('opacity', 0); tip.hide(); });
    svg.append(hit);

    const ax = mk('g', { class: 'axis' });
    for (const i of dateTicks(pts)) {
      const t = mk('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' });
      t.textContent = d3(pts[i].date); ax.append(t);
    }
    svg.append(ax);
    host.append(svg);
  }

  /* ---------- fund table ---------- */
  function fundTable() {
    const host = $('#funds'); host.textContent = '';
    const last = DATA.series[DATA.series.length - 1] || { by_fund: {} };
    const tbl = el('table');
    tbl.innerHTML = '<thead><tr><th>Fund</th><th>Ticker</th><th>Venue</th><th>Status</th><th>Fee</th>' +
      '<th>Stakes</th><th>Listed</th><th>Net assets</th><th>Cum. flow</th></tr></thead>';
    const tb = el('tbody');
    for (const f of DATA.funds) {
      if (f.status === 'not_single_asset') continue;
      const tr = el('tr');
      const cum = DATA.series.reduce((a, r) => a + (r.by_fund[f.ticker] ? r.by_fund[f.ticker].flow : 0), 0);
      const live = f.status === 'live';
      const STATUS = {
        pending_19b4: '19b-4 pending',
        filed_s1: 'S-1 filed',
        filed: 'filed',
        not_single_asset: 'not spot',
      };
      const chip = live ? '<span class="chip live">live</span>'
        : `<span class="chip pending">${STATUS[f.status] || f.status.replace(/_/g, ' ')}</span>`;
      tr.innerHTML =
        `<td class="name">${f.issuer}</td><td>${f.ticker}</td><td class="name">${f.exchange}</td>` +
        `<td class="name">${chip}</td><td>${fmtPct(f.fee)}</td><td>${f.stakes ? 'yes' : 'no'}</td>` +
        `<td>${f.first_trade ? d3(f.first_trade) : '—'}</td>` +
        `<td>${live && last.by_fund[f.ticker] ? fmtUSD(last.by_fund[f.ticker].net_assets) : '—'}</td>` +
        `<td class="${live ? cls(cum) : ''}">${live ? fmtUSD(cum, true) : '—'}</td>`;
      tb.append(tr);
      if (f.note) {
        const nr = el('tr');
        const td = el('td'); td.colSpan = 9; td.className = 'name';
        td.style.color = 'var(--text-3)'; td.style.whiteSpace = 'normal'; td.style.fontSize = '11.5px';
        td.textContent = f.note; nr.append(td); tb.append(nr);
      }
    }
    tbl.append(tb); host.append(tbl);
  }

  /* ---------- corporate actions (only if the page has a slot) ---------- */
  function actions() {
    const sec = $('#actions-sec'), host = $('#actions');
    if (!sec || !host) return;
    host.textContent = '';
    const sp = DATA.splits || {};
    const items = [];
    for (const tk of Object.keys(sp)) {
      for (const d of (sp[tk].declared || []))
        items.push(`<b>${tk}</b> — ${d.note}, effective ${d3(d.date)}. Declared in the registry; flow suppressed for that session.`);
      for (const d of (sp[tk].detected_in_data || []))
        items.push(`<b>${tk}</b> — <span class="chip pending">detected</span> ${d3(d.date)}: shares ×${d.share_ratio}, NAV ×${d.nav_ratio}. Treated as a split, not a creation.`);
    }
    if (!items.length) { sec.hidden = true; return; }
    sec.hidden = false;
    const ul = el('ul', 'notes');
    for (const t of items) { const li = el('li'); li.innerHTML = t; ul.append(li); }
    host.append(ul);
  }

  /* ---------- listing watch ---------- */
  function watch() {
    const host = $('#watch'), rows = DATA.listing_watch || [];
    host.textContent = '';
    if (!rows.length) { $('#watch-sec').hidden = true; return; }
    const ul = el('ul', 'notes');
    for (const w of rows) {
      const li = el('li');
      if (w.error) li.innerHTML = `<b>${w.ticker}</b> — EDGAR check failed (${w.error})`;
      else li.innerHTML = `<b>${w.ticker}</b> (CIK ${w.cik}) — ${w.has_8a
        ? '<span class="chip pending">Form 8-A on file: listing imminent</span>'
        : 'no Form 8-A yet'}; latest filing <b>${w.latest_form}</b> on ${d3(w.latest_form_date)}; EDGAR lists it on ${(w.exchanges || []).join(', ') || 'no exchange'}.`;
      ul.append(li);
    }
    host.append(ul);
  }

  /* ---------- session table ---------- */
  function sessionTable() {
    const host = $('#sessions'); host.textContent = '';
    const rows = visible().slice().reverse();
    const tk = DATA.live_tickers[0];
    const tbl = el('table');
    tbl.innerHTML = '<thead><tr><th>Session</th><th>Net flow</th><th>Cumulative</th><th>Shares out</th>' +
      '<th>NAV</th><th>Net assets</th><th>Prem/disc</th></tr></thead>';
    const tb = el('tbody');
    for (const r of rows) {
      const f = r.by_fund[tk] || {};
      const tr = el('tr');
      tr.innerHTML = `<td>${d3(r.date)}${r.estimated ? ' <span class="chip est">est</span>' : ''}</td>` +
        `<td class="${cls(r.flow)}">${fmtUSDfull(r.flow)}</td><td>${fmtUSD(r.cum_flow, true)}</td>` +
        `<td>${fmtNum(f.shares)}</td><td>${f.nav != null ? '$' + f.nav.toFixed(4) : '—'}</td>` +
        `<td>${fmtUSD(r.net_assets)}</td>` +
        `<td>${f.premium_discount != null ? (f.premium_discount * (Math.abs(f.premium_discount) < 1 ? 100 : 1)).toFixed(2) + '%' : '—'}</td>`;
      tb.append(tr);
    }
    tbl.append(tb); host.append(tbl);
  }

  function csv() {
    const tk = DATA.live_tickers[0];
    const head = ['date', 'net_flow_usd', 'cumulative_usd', 'shares_outstanding', 'nav', 'net_assets_usd', 'estimated'];
    const lines = [head.join(',')];
    for (const r of DATA.series) {
      const f = r.by_fund[tk] || {};
      lines.push([r.date, r.flow, r.cum_flow, f.shares ?? '', f.nav ?? '', r.net_assets, r.estimated ? 1 : 0].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = el('a'); a.href = URL.createObjectURL(blob);
    a.download = `${DATA.asset.toLowerCase()}_etf_flows.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------- notes ---------- */
  function notes() {
    const ul = $('#caveats'); ul.textContent = '';
    for (const c of DATA.caveats || []) ul.append(el('li', null, c));
    $('#method').textContent = DATA.method || '';
  }

  function renderAll() { tiles(); flowChart(); cumChart(); sharesChart(); onchainChart(); fundTable(); actions(); watch(); sessionTable(); notes(); }

  /* ---------- boot ---------- */
  function wire() {
    $('#ranges').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      RANGE = b.dataset.range;
      [...$('#ranges').children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      flowChart(); cumChart(); sharesChart(); sessionTable();
    });
    const gr = $('#grain');
    if (gr) gr.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      GRAIN = b.dataset.grain;
      [...gr.children].forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      flowChart();
    });
    $('#toggle-table').addEventListener('click', () => {
      showTable = !showTable;
      $('#sessions-sec').hidden = !showTable;
      $('#toggle-table').textContent = showTable ? 'Hide table' : 'Table view';
      if (showTable) $('#sessions-sec').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('#dl').addEventListener('click', csv);
    $('#theme').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme;
      const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch (e) {}
      renderAll();
    });
    try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
    addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(renderAll, 160); });
  }

  fetch(SRC + '?t=' + Date.now())
    .then(r => { if (!r.ok) throw new Error(`${SRC} → HTTP ${r.status}`); return r.json(); })
    .then(j => {
      DATA = j;
      if (!DATA.series || !DATA.series.length) throw new Error('no sessions in data file');
      $('#updated').textContent = `data as of ${DATA.series[DATA.series.length - 1].date} · file refreshed ${DATA.updated_utc.replace('T', ' ').replace('+00:00', '')} UTC`;
      wire(); renderAll();
    })
    .catch(e => {
      $('#tiles').innerHTML = `<div class="tile"><div class="label">Load failed</div><div class="err">${e.message}</div>` +
        `<div class="note">Run <code>python scripts/update.py</code> and commit the data file.</div></div>`;
    });
})();
