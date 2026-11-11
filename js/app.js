/* 占比系统 interactive SPA. Vanilla canvas. No 口径 recomputation. */
(() => {
  "use strict";

  const C = {
    bg: "#0b0e14",
    panel: "#10141c",
    grid: "#2a3140",
    text: "#e8edf2",
    muted: "#8b95a5",
    gold: "#f0c14b",
    cyan: "#6ec6c1",
    red: "#e06c75",
    blue: "#61afef",
    official: "#ffffff",
    annoBg: "#1a2230",
    annoBorder: "#3a4558",
    legendBg: "#151b26",
    split: "#7a8494",
  };

  const FONT = '"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
  const DRAG_THRESH = 6;
  const MIN_SPAN_MS = 14 * 86400000;
  const WHEEL_HIDE_MS = 180;
  const RATIO_START = "2024-12-31";
  const DAY = 86400000;

  const BASKET_FIELDS = [
    { code: "510300", short: "华泰柏瑞", key: "aum_510300_yi" },
    { code: "510310", short: "易方达", key: "aum_510310_yi" },
    { code: "510330", short: "华夏", key: "aum_510330_yi" },
    { code: "159919", short: "嘉实", key: "aum_159919_yi" },
    { code: "515330", short: "天弘", key: "aum_515330_yi" },
  ];

  let meta = null;
  let rows = [];
  let events = [];
  let times = [];
  let officialIdx = [];
  let ratioStartT = 0;
  let full0 = 0;
  let full1 = 0;
  let view0 = 0;
  let view1 = 0;

  let pinned = null;
  let hover = null;
  let wheelHide = false;
  let wheelTimer = 0;
  let rubber = null;
  let layout = null;
  let raf = 0;

  let lastPt = null;

  const ptr = {
    down: false,
    x0: 0,
    y0: 0,
    t0: 0,
    mode: null,
    area: null,
    shifted: false,
    lastX: 0,
    view0AtDown: 0,
    view1AtDown: 0,
  };

  const el = {
    get canvas() { return document.getElementById("chart"); },
    get wrap() { return document.getElementById("chart-wrap"); },
    get tooltip() { return document.getElementById("tooltip"); },
    get footer() { return document.getElementById("footer"); },
    get reset() { return document.getElementById("btn-reset"); },
    get slider() { return document.getElementById("slider"); },
    get track() { return document.getElementById("slider-track"); },
    get range() { return document.getElementById("slider-range"); },
    get handleLo() { return document.getElementById("handle-lo"); },
    get handleHi() { return document.getElementById("handle-hi"); },
    get rangeLabel() { return document.getElementById("range-label"); },
    get status() { return document.getElementById("status"); },
  };

  function parseDay(s) {
    const [y, m, d] = String(s).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function fmtDay(ms) {
    const d = new Date(ms);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${d.getUTCFullYear()}-${mm}-${dd}`;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function mapFlag(f) {
    if (f === "interpolated_from_prior_official") return "interpolated";
    return f == null || f === "" ? null : f;
  }

  function num(v) {
    if (v == null || v === "" || v === "NaN") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmtPct(v, d) {
    return v == null ? "—" : `${v.toFixed(d)}%`;
  }

  function fmtNum(v, d) {
    if (v == null) return "—";
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function showStatus(msg) {
    const s = el.status;
    s.hidden = !msg;
    s.textContent = msg || "";
  }

  async function tryApi(url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const text = await res.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }

  async function loadFile(rel) {
    const url = new URL(rel, window.location.href);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`无法读取 ${rel}（HTTP ${res.status}）`);
    return res.json();
  }

  async function loadAll() {
    const [fileMeta, fileDaily, fileEvents] = await Promise.all([
      loadFile("data/meta.json"),
      loadFile("data/daily.json"),
      loadFile("data/events.json"),
    ]);
    const apiMeta = await tryApi("/api/meta");
    const start = (apiMeta && (apiMeta.window_start || (apiMeta.window && apiMeta.window.start)))
      || (fileMeta.window && fileMeta.window.start)
      || "2023-11-01";
    const end = (apiMeta && (apiMeta.window_end || (apiMeta.window && apiMeta.window.end)))
      || (fileMeta.window && fileMeta.window.end)
      || "2026-11-06";
    let apiDaily = await tryApi("/api/daily");
    if (!apiDaily) apiDaily = await tryApi(`/api/series?start=${start}&end=${end}`);
    const apiEvents = await tryApi("/api/events");
    const apiAnchors = await tryApi("/api/anchors");
    return { fileMeta, fileDaily, fileEvents, apiMeta, apiDaily, apiEvents, apiAnchors, start, end };
  }

  function unwrap(payload, keys) {
    if (payload == null) return payload;
    if (Array.isArray(payload)) return payload;
    for (const k of keys) {
      if (Array.isArray(payload[k])) return payload[k];
    }
    return payload;
  }

  function normalizeRow(r) {
    const flag = mapFlag(r.denom_flag);
    return {
      date: r.date,
      aum_510300_yi: num(r.aum_510300_yi),
      aum_510310_yi: num(r.aum_510310_yi),
      aum_510330_yi: num(r.aum_510330_yi),
      aum_159919_yi: num(r.aum_159919_yi),
      aum_515330_yi: num(r.aum_515330_yi),
      aum_sum_yi: num(r.aum_sum_yi),
      calc_mkv_yi: num(r.calc_mkv_yi),
      denom_flag: flag,
      anchor_date: r.anchor_date || null,
      ratio_pct: num(r.ratio_pct),
      sse_comp: num(r.sse_comp),
      csi300: num(r.csi300),
      sse_rebased: num(r.sse_rebased ?? r["sse_rebased_20231101=100"] ?? r.sse_rebased_20231101),
      csi_rebased: num(r.csi_rebased ?? r["csi300_rebased_20231101=100"] ?? r.csi300_rebased_20231101 ?? r.csi_rebased_20231101),
    };
  }

  function normalizeDaily(daily) {
    let list = unwrap(daily, ["rows", "data", "daily", "items"]);
    if (!Array.isArray(list)) throw new Error("daily 数据格式无法识别");
    if (list.length && Array.isArray(list[0]) && daily.columns) {
      list = list.map((arr) => {
        const o = {};
        daily.columns.forEach((c, i) => { o[c] = arr[i]; });
        return o;
      });
    }
    return list.map(normalizeRow);
  }

  function normalizeEvents(payload) {
    const list = unwrap(payload, ["events", "data", "items"]) || [];
    if (!Array.isArray(list)) return [];
    // Local snapshot events carry panel / lines / placement for the static chart.
    // API key-date items (event_type/note) do not; only use them if they already look like layout events.
    return list.filter((e) => e && (e.panel || e.lines || e.kind));
  }

  function mergeMeta(local, api, rows, anchors, windowStart, windowEnd) {
    const m = Object.assign({}, local || {});
    const a = (api && api.meta) ? api.meta : (api || null);
    m.window = {
      start: windowStart || (m.window && m.window.start) || "2023-11-01",
      end: windowEnd || (m.window && m.window.end) || "2026-11-06",
    };
    if (a) {
      if (a.first_official_anchor || a.first_official_date || a.ratio_from) {
        m.first_official_anchor = a.first_official_anchor || a.first_official_date || a.ratio_from;
      }
      if (a.title) m.title = a.title;
      if (a.footer) m.footer = a.footer;
      if (a.basket && a.basket.line) m.basket = a.basket;
      if (a.note && a.note.indexOf("≠") >= 0) m.note = a.note;
      if (a.formula && a.formula.indexOf("计算用股本口径") >= 0) m.formula = a.formula;
      if (a.labels) m.labels = a.labels;
      if (a.gap_note) m.gap_note = a.gap_note;
      // as_of / latest official anchor come from the live series, not the seed window.end
      if (a.as_of || a.latest_trade_date) m.as_of = a.as_of || a.latest_trade_date;
      if (a.latest_official_anchor) m.latest_official_anchor = a.latest_official_anchor;
    }
    const lastRow = rows && rows.length ? rows[rows.length - 1].date : null;
    if (!m.as_of) m.as_of = lastRow || m.window.end;
    // Latest official anchor = last official point actually applied in the displayed series
    // (after daily update this may be after the original seed window, e.g. 2026-11-10).
    let latest = m.latest_official_anchor || null;
    if (!latest && anchors) {
      const items = unwrap(anchors, ["items", "anchors", "data"]) || [];
      const hi = m.as_of || lastRow || m.window.end;
      for (const it of items) {
        const d = it.date;
        const used = it.used_for_interpolation;
        const inSeries = d && d <= hi;
        const isUsed = used === 1 || used === true || used === "1";
        if (inSeries && (isUsed || used == null)) latest = (!latest || d > latest) ? d : latest;
      }
    }
    if (!latest) {
      for (const r of rows) {
        if (r.denom_flag === "official") {
          if (!latest || r.date > latest) latest = r.date;
        }
      }
    }
    m.latest_official_anchor = latest || "2026-10-30";
    const ws = (m.window && m.window.start) || "2023-11-01";
    const we = m.as_of || (m.window && m.window.end) || "2026-11-06";
    m.basket = Object.assign({}, m.basket || {});
    m.basket.window_line = `区间：${ws}至${we}（A股交易日）`;
    return m;
  }

  function denomText(row) {
    if (!row || row.denom_flag === "pre_first_official") {
      return "尚无官方分母时点，不计算";
    }
    if (row.denom_flag === "official") return "官方时点（未插值）";
    if (row.denom_flag === "interpolated") {
      return row.anchor_date ? `由 ${row.anchor_date} 官方锚点按点位插值` : "由官方锚点按点位插值";
    }
    return "—";
  }

  function nearestIndex(t) {
    const n = times.length;
    if (n === 0) return 0;
    if (t <= times[0]) return 0;
    if (t >= times[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    return (t - times[lo - 1] <= times[lo] - t) ? lo - 1 : lo;
  }

  function firstVisibleIndex() {
    let lo = 0, hi = times.length - 1, ans = hi;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] >= view0) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return Math.max(0, ans);
  }

  function lastVisibleIndex() {
    let lo = 0, hi = times.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= view1) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return Math.min(times.length - 1, ans);
  }

  function visibleSlice() {
    let a = firstVisibleIndex();
    let b = lastVisibleIndex();
    if (a > 0 && times[a] > view0) a -= 1;
    if (b < times.length - 1 && times[b] < view1) b += 1;
    return [a, b];
  }

  function setView(a, b, opts) {
    const minSpan = Math.min(MIN_SPAN_MS, full1 - full0);
    let n0 = a, n1 = b;
    if (n1 - n0 < minSpan) {
      const mid = (n0 + n1) / 2;
      n0 = mid - minSpan / 2;
      n1 = mid + minSpan / 2;
    }
    if (n0 < full0) { n1 += full0 - n0; n0 = full0; }
    if (n1 > full1) { n0 -= n1 - full1; n1 = full1; }
    n0 = Math.max(full0, n0);
    n1 = Math.min(full1, n1);
    if (n1 < n0) { const t = n0; n0 = n1; n1 = t; }
    view0 = n0;
    view1 = n1;
    syncSlider();
    if (!opts || !opts.silent) requestDraw();
  }

  function resetView() {
    setView(full0, full1);
  }

  function isFullView() {
    return Math.abs(view0 - full0) < 1000 && Math.abs(view1 - full1) < 1000;
  }

  function zoomAround(anchor, factor) {
    const span = view1 - view0;
    if (span <= 0) return;
    let newSpan = span * factor;
    newSpan = clamp(newSpan, Math.min(MIN_SPAN_MS, full1 - full0), full1 - full0);
    const leftFrac = clamp((anchor - view0) / span, 0, 1);
    let n0 = anchor - newSpan * leftFrac;
    let n1 = n0 + newSpan;
    setView(n0, n1);
  }

  function niceTicks(min, max, count) {
    const span = max - min;
    if (!(span > 0)) return [min];
    const raw = span / Math.max(1, count - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const t0 = Math.ceil((min - 1e-12) / step) * step;
    const out = [];
    for (let v = t0; v <= max + step * 1e-9; v += step) out.push(v);
    return out.length ? out : [min, max];
  }

  function xOf(t) {
    const r = layout.plot;
    const span = view1 - view0 || 1;
    return r.x + ((t - view0) / span) * r.w;
  }

  function tOf(x) {
    const r = layout.plot;
    const span = view1 - view0 || 1;
    return view0 + ((x - r.x) / r.w) * span;
  }

  function yMap(min, max, rect) {
    const span = max - min || 1;
    return (v) => rect.y + rect.h - ((v - min) / span) * rect.h;
  }

  function cssPoint(ev, node) {
    const rec = (node || el.canvas).getBoundingClientRect();
    return { x: ev.clientX - rec.left, y: ev.clientY - rec.top };
  }

  function hitArea(pt) {
    if (!layout) return "blank";
    const { top, bot, plot } = layout;
    if (pt.x >= plot.x && pt.x <= plot.x + plot.w) {
      if (pt.y >= top.y && pt.y <= top.y + top.h) return "plot-top";
      if (pt.y >= bot.y && pt.y <= bot.y + bot.h) return "plot-bot";
      if (pt.y > top.y + top.h && pt.y < bot.y) return "gap";
    }
    const inCanvas = pt.x >= 0 && pt.y >= 0 && pt.x <= layout.w && pt.y <= layout.h;
    return inCanvas ? "margin" : "blank";
  }

  function inDateStrip(pt) {
    const a = hitArea(pt);
    return a === "plot-top" || a === "plot-bot" || a === "gap";
  }

  function computeLayout(w, h) {
    const left = 60, right = 64, topPad = 8, gap = 12, xh = 22, botPad = 4;
    const innerH = Math.max(80, h - topPad - botPad - xh - gap);
    const topH = Math.floor(innerH * (1.12 / 2.0));
    const botH = innerH - topH;
    const plotW = Math.max(40, w - left - right);
    const top = { x: left, y: topPad, w: plotW, h: Math.max(40, topH) };
    const bot = { x: left, y: topPad + top.h + gap, w: plotW, h: Math.max(40, botH) };
    return { w, h, left, right, top, bot, plot: { x: left, y: top.y, w: plotW, h: 0 }, xAxisY: bot.y + bot.h };
  }

  function visibleExtrema() {
    const [a0, b0] = visibleSlice();
    let rMin = Infinity, rMax = -Infinity, aMax = 0, aMin = Infinity;
    let iMin = Infinity, iMax = -Infinity;
    let anyR = false;
    for (let i = a0; i <= b0; i++) {
      const r = rows[i];
      if (times[i] < view0 || times[i] > view1) continue;
      if (r.aum_sum_yi != null) {
        aMax = Math.max(aMax, r.aum_sum_yi);
        aMin = Math.min(aMin, r.aum_sum_yi);
      }
      if (r.ratio_pct != null && times[i] >= ratioStartT) {
        rMin = Math.min(rMin, r.ratio_pct);
        rMax = Math.max(rMax, r.ratio_pct);
        anyR = true;
      }
      if (r.sse_rebased != null) {
        iMin = Math.min(iMin, r.sse_rebased);
        iMax = Math.max(iMax, r.sse_rebased);
      }
      if (r.csi_rebased != null) {
        iMin = Math.min(iMin, r.csi_rebased);
        iMax = Math.max(iMax, r.csi_rebased);
      }
    }
    if (!anyR) {
      for (const r of rows) {
        if (r.ratio_pct != null) {
          rMin = Math.min(rMin, r.ratio_pct);
          rMax = Math.max(rMax, r.ratio_pct);
        }
      }
    }
    if (!Number.isFinite(rMin) || !Number.isFinite(rMax)) { rMin = 0; rMax = 6; }
    if (rMax <= rMin) { rMin -= 0.3; rMax += 0.3; }
    const rPad = (rMax - rMin) * 0.28;
    rMin = Math.max(0, rMin - rPad);
    rMax = rMax + rPad;

    if (!(aMax > 0)) aMax = 1;
    const aLo = 0;
    const aHi = aMax * 1.22;

    if (!Number.isFinite(iMin) || !Number.isFinite(iMax)) { iMin = 90; iMax = 140; }
    if (iMax <= iMin) { iMin -= 2; iMax += 2; }
    const iPad = (iMax - iMin) * 0.16;
    iMin -= iPad;
    iMax += iPad;

    return { rMin, rMax, aLo, aHi, iMin, iMax };
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawPanelBg(ctx, rect) {
    ctx.fillStyle = C.panel;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y);
    ctx.lineTo(rect.x, rect.y + rect.h);
    ctx.lineTo(rect.x + rect.w, rect.y + rect.h);
    ctx.stroke();
  }

  function drawHGrid(ctx, rect, ticks, yfn) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 0.6;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (const v of ticks) {
      const y = yfn(v);
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawVGrid(ctx, y0, y1, xticks) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 0.6;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (const t of xticks) {
      const x = xOf(t);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function monthStart(y, m) { return Date.UTC(y, m, 1); }

  function xTicks() {
    const spanDays = (view1 - view0) / DAY;
    const ticks = [];
    const labels = [];
    const d0 = new Date(view0);
    let y = d0.getUTCFullYear();
    let m = d0.getUTCMonth();
    if (spanDays > 500) {
      const months = [0, 3, 6, 9];
      while (monthStart(y, m) < view0 - DAY) {
        m++;
        if (m > 11) { m = 0; y++; }
      }
      while (true) {
        const t = monthStart(y, m);
        if (t > view1 + DAY) break;
        if (months.includes(m) && t >= view0 - DAY && t <= view1 + DAY) {
          ticks.push(t);
          labels.push(`${y}-${String(m + 1).padStart(2, "0")}`);
        }
        m++;
        if (m > 11) { m = 0; y++; }
      }
    } else if (spanDays > 90) {
      while (monthStart(y, m) < view0 - DAY) {
        m++;
        if (m > 11) { m = 0; y++; }
      }
      while (true) {
        const t = monthStart(y, m);
        if (t > view1 + DAY) break;
        if (t >= view0 - DAY) {
          ticks.push(t);
          labels.push(`${y}-${String(m + 1).padStart(2, "0")}`);
        }
        m++;
        if (m > 11) { m = 0; y++; }
      }
    } else if (spanDays > 21) {
      const start = times[firstVisibleIndex()];
      for (let t = start; t <= view1 + DAY; t += 7 * DAY) {
        const i = nearestIndex(t);
        const tt = times[i];
        if (tt >= view0 && tt <= view1) {
          ticks.push(tt);
          labels.push(fmtDay(tt).slice(5));
        }
      }
    } else {
      const [a, b] = [firstVisibleIndex(), lastVisibleIndex()];
      const step = Math.max(1, Math.ceil((b - a) / 8));
      for (let i = a; i <= b; i += step) {
        ticks.push(times[i]);
        labels.push(fmtDay(times[i]).slice(5));
      }
    }
    return { ticks, labels };
  }

  function clipPlot(ctx, rect) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
  }

  function strokeSeries(ctx, yfn, key, from, to, skipNull, startT) {
    ctx.beginPath();
    let open = false;
    for (let i = from; i <= to; i++) {
      const v = rows[i][key];
      if (v == null || (startT != null && times[i] < startT)) {
        open = false;
        continue;
      }
      const x = xOf(times[i]);
      const y = yfn(v);
      if (!open) { ctx.moveTo(x, y); open = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function fillAum(ctx, yfn, from, to, yBase) {
    ctx.beginPath();
    let started = false;
    let lastX = 0;
    for (let i = from; i <= to; i++) {
      const v = rows[i].aum_sum_yi;
      if (v == null) continue;
      const x = xOf(times[i]);
      const y = yfn(v);
      if (!started) { ctx.moveTo(x, yBase); ctx.lineTo(x, y); started = true; }
      else ctx.lineTo(x, y);
      lastX = x;
    }
    if (started) {
      ctx.lineTo(lastX, yBase);
      ctx.closePath();
      ctx.fill();
    }
  }

  function yLabel(ctx, text, color, x, y, align) {
    ctx.fillStyle = color;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    const lines = String(text).split("\n");
    const lh = 13;
    const y0 = y - (lines.length - 1) * lh / 2;
    lines.forEach((s, i) => ctx.fillText(s, x, y0 + i * lh));
  }

  function tickLabelY(ctx, text, color, x, y, align) {
    ctx.fillStyle = color;
    ctx.font = `10.5px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

  function drawLegend(ctx, rect, labels) {
    const items = [
      { type: "line", color: C.gold, lw: 2, text: labels.ratio || "占比（分母=官方计算用市值）" },
      { type: "line", color: C.cyan, lw: 1.4, text: labels.aum || "头部5只合计规模（左全样本）" },
      { type: "dot", text: labels.official || "官方计算用市值时点（未插值）" },
    ];
    ctx.font = `11px ${FONT}`;
    const lineH = 15;
    const padX = 8, padY = 6, iconW = 22;
    const tw = Math.max(...items.map((it) => ctx.measureText(it.text).width));
    const bw = tw + iconW + padX * 2;
    const bh = items.length * lineH + padY * 2;
    const bx = rect.x + 8;
    const by = rect.y + 8;
    layout.legendBox = { x: bx, y: by, w: bw, h: bh };
    roundRect(ctx, bx, by, bw, bh, 3);
    ctx.fillStyle = "rgba(21, 27, 38, 0.92)";
    ctx.fill();
    ctx.strokeStyle = C.annoBorder;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    items.forEach((it, i) => {
      const iy = by + padY + i * lineH + lineH / 2;
      if (it.type === "line") {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = it.lw;
        ctx.beginPath();
        ctx.moveTo(bx + padX, iy);
        ctx.lineTo(bx + padX + 16, iy);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(bx + padX + 8, iy, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = C.official;
        ctx.fill();
        ctx.strokeStyle = C.gold;
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
      ctx.fillStyle = C.text;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `11px ${FONT}`;
      ctx.fillText(it.text, bx + padX + iconW, iy);
    });
    return { x: bx, y: by, w: bw, h: bh };
  }

  function drawGapNote(ctx, rect, legendBox) {
    layout.gapNoteBox = null;
    if (view0 >= ratioStartT) return;
    const text = (meta && meta.gap_note) || "2023-11-01 至 2024-12-30\n无公开官方计算用市值时点，\n占比不绘制（青色为合计规模）。";
    const lines = text.split("\n");
    ctx.font = `11px ${FONT}`;
    const tw = Math.max(...lines.map((s) => ctx.measureText(s).width));
    const lineH = 14, padX = 7, padY = 5;
    const bw = tw + padX * 2;
    const bh = lines.length * lineH + padY * 2;
    const bx = rect.x + 8;
    const by = (legendBox ? legendBox.y + legendBox.h + 6 : rect.y + 8);
    if (by + bh > rect.y + rect.h - 4) return;
    roundRect(ctx, bx, by, bw, bh, 3);
    ctx.fillStyle = "rgba(21, 27, 38, 0.92)";
    ctx.fill();
    ctx.strokeStyle = C.annoBorder;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((s, i) => ctx.fillText(s, bx + padX, by + padY + i * lineH));
    layout.gapNoteBox = { x: bx, y: by, w: bw, h: bh };
  }

  function measureAnno(ctx, lines, style) {
    ctx.font = style === "text" ? `10px ${FONT}` : `10.5px ${FONT}`;
    const widths = lines.map((s) => ctx.measureText(s).width);
    const tw = Math.max(...widths);
    const lineH = 12.5;
    const padX = 5, padY = 3;
    return { tw, lineH, padX, padY, bw: tw + padX * 2, bh: lines.length * lineH + padY * 2 };
  }

  function preferredAnnoBox(x, y, m, dx, dy, ha, bounds) {
    // Keep a visible gap from the anchor point, using (dx, dy, ha) as the preferred side.
    const gapX = Math.max(8, Math.abs(dx));
    const gapY = Math.abs(dy) >= 8 ? dy : (dy < 0 ? -18 : 18);
    let bx = ha === "right" ? x - gapX - m.bw : (ha === "center" ? x - m.bw / 2 : x + gapX);
    let by = y + gapY - (gapY < 0 ? m.bh : 0);
    // If the preferred box leaves the panel, flip once on the overflowing axis.
    if (by < bounds.y + 2) by = y + 10;
    if (by + m.bh > bounds.y + bounds.h - 2) by = y - 10 - m.bh;
    if (bx < bounds.x + 2) bx = x + 8;
    if (bx + m.bw > bounds.x + bounds.w - 2) bx = x - 8 - m.bw;
    bx = clamp(bx, 3, layout.w - m.bw - 3);
    by = clamp(by, 3, layout.h - m.bh - 3);
    return { x: bx, y: by, w: m.bw, h: m.bh };
  }

  function boxesOverlap(a, b, pad) {
    const p = pad == null ? 4 : pad;
    return a.x < b.x + b.w + p && a.x + a.w + p > b.x && a.y < b.y + b.h + p && a.y + a.h + p > b.y;
  }

  function resolveAnnoOverlaps(boxes, reserved, bounds) {
    const all = reserved.concat(boxes);
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      for (let i = reserved.length; i < all.length; i++) {
        const a = all[i];
        for (let j = 0; j < i; j++) {
          const b = all[j];
          if (!boxesOverlap(a, b, 4)) continue;
          // Nudge the later box away vertically, then clamp.
          if (a.y + a.h / 2 >= b.y + b.h / 2) a.y = b.y + b.h + 4;
          else a.y = b.y - a.h - 4;
          a.y = clamp(a.y, 3, layout.h - a.h - 3);
          // If still colliding, try the other side of the reserved/earlier box.
          if (boxesOverlap(a, b, 4)) {
            a.y = b.y - a.h - 4;
            if (a.y < 3) a.y = b.y + b.h + 4;
            a.y = clamp(a.y, 3, layout.h - a.h - 3);
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  function paintAnno(ctx, item) {
    const { x, y, lines, color, style, box } = item;
    if (style !== "text") {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = C.bg;
      ctx.stroke();
    }
    if (style !== "text") {
      const ax = clamp(x, box.x, box.x + box.w);
      const ay = clamp(y, box.y, box.y + box.h);
      // Connect to the nearer box edge rather than through the box.
      let cx = box.x, cy = box.y + box.h / 2;
      if (x > box.x + box.w) cx = box.x + box.w;
      else if (x >= box.x && x <= box.x + box.w) {
        cx = x;
        cy = y < box.y ? box.y : box.y + box.h;
      }
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = C.muted;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    ctx.font = style === "text" ? `10px ${FONT}` : `10.5px ${FONT}`;
    if (style === "box") {
      roundRect(ctx, box.x, box.y, box.w, box.h, 3);
      ctx.fillStyle = "rgba(26, 34, 48, 0.92)";
      ctx.fill();
      ctx.strokeStyle = C.annoBorder;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    ctx.fillStyle = style === "text" ? C.muted : (style === "plain" ? C.muted : C.text);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const m = item.m;
    lines.forEach((s, i) => ctx.fillText(s, box.x + m.padX, box.y + m.padY + i * m.lineH));
  }

  function dateVisible(t) {
    const x = xOf(t);
    return x >= layout.plot.x - 1 && x <= layout.plot.x + layout.plot.w + 1;
  }

  function drawEvents(ctx, yRatio, yAum, yIndex, reserved) {
    const pending = [];
    for (const ev of events) {
      const t = parseDay(ev.date);
      if (!dateVisible(t)) continue;
      const i = nearestIndex(t);
      const row = rows[i];
      if (!row || row.date !== ev.date) continue;
      const x = xOf(t);
      const ha = ev.ha || "left";
      const dx = ev.dx != null ? ev.dx : 8;
      const dy = ev.dy != null ? ev.dy : 16;
      const lines = ev.lines || [ev.title || ev.date];
      if (ev.kind === "share_split") {
        clipPlot(ctx, layout.top);
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = C.split;
        ctx.lineWidth = 0.7;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(x, layout.top.y);
        ctx.lineTo(x, layout.top.y + layout.top.h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.restore();
        const y = yAum(row.aum_sum_yi);
        const m = measureAnno(ctx, lines, "text");
        const box = preferredAnnoBox(x, y, m, dx, dy, ha, layout.top);
        pending.push({ x, y, lines, color: C.muted, style: "text", box, m, reservedPanel: "top" });
        continue;
      }
      if (ev.panel === "aum") {
        const y = yAum(row.aum_sum_yi);
        const m = measureAnno(ctx, lines, "box");
        const box = preferredAnnoBox(x, y, m, dx, dy, ha, layout.top);
        pending.push({ x, y, lines, color: C.cyan, style: "box", box, m });
      } else if (ev.panel === "ratio") {
        if (row.ratio_pct == null) continue;
        const y = yRatio(row.ratio_pct);
        const m = measureAnno(ctx, lines, "box");
        const box = preferredAnnoBox(x, y, m, dx, dy, ha, layout.top);
        pending.push({ x, y, lines, color: C.gold, style: "box", box, m });
      } else if (ev.panel === "index") {
        let y;
        if (ev.kind === "index_start") y = yIndex(100);
        else if (row.csi_rebased != null) y = yIndex(row.csi_rebased);
        else y = yIndex(100);
        const m = measureAnno(ctx, lines, "plain");
        const box = preferredAnnoBox(x, y, m, dx, dy, ha, layout.bot);
        pending.push({ x, y, lines, color: C.muted, style: "plain", box, m });
      }
    }
    resolveAnnoOverlaps(pending.map((p) => p.box), reserved || [], layout.top);
    pending.forEach((item) => paintAnno(ctx, item));
    layout.annoBoxes = pending.map((p) => p.box);
  }

  function drawAxisTag(ctx, text, x, y, bg, fg, align) {
    ctx.font = `10px ${FONT}`;
    const w = ctx.measureText(text).width + 8;
    const h = 14;
    const bx = align === "right" ? x - w : x;
    const by = y - h / 2;
    ctx.fillStyle = bg;
    ctx.fillRect(bx, by, w, h);
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + w / 2, y);
  }

  function drawCrosshair(ctx, idx, yRatio, yAum, yIndex) {
    if (idx == null || wheelHide) return;
    const t = times[idx];
    if (!dateVisible(t)) return;
    const x = xOf(t);
    const row = rows[idx];
    ctx.save();
    ctx.strokeStyle = "rgba(232, 237, 242, 0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, layout.top.y);
    ctx.lineTo(x, layout.bot.y + layout.bot.h);
    ctx.stroke();
    ctx.setLineDash([]);

    const dots = [];
    if (row.ratio_pct != null && t >= ratioStartT) {
      dots.push({ y: yRatio(row.ratio_pct), fill: C.gold, panel: "top", tag: fmtPct(row.ratio_pct, 2), side: "left" });
    }
    if (row.aum_sum_yi != null) {
      dots.push({ y: yAum(row.aum_sum_yi), fill: C.cyan, panel: "top", tag: fmtNum(row.aum_sum_yi, 0), side: "right" });
    }
    if (row.sse_rebased != null) {
      dots.push({ y: yIndex(row.sse_rebased), fill: C.red, panel: "bot", tag: row.sse_rebased.toFixed(1), side: "left" });
    }
    if (row.csi_rebased != null) {
      dots.push({ y: yIndex(row.csi_rebased), fill: C.blue, panel: "bot", tag: row.csi_rebased.toFixed(1), side: "left" });
    }
    for (const d of dots) {
      const rect = d.panel === "top" ? layout.top : layout.bot;
      if (d.y < rect.y - 2 || d.y > rect.y + rect.h + 2) continue;
      ctx.beginPath();
      ctx.arc(x, d.y, 3.3, 0, Math.PI * 2);
      ctx.fillStyle = d.fill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.bg;
      ctx.stroke();
      if (d.side === "left") drawAxisTag(ctx, d.tag, layout.plot.x - 2, d.y, d.fill, C.bg, "right");
      else drawAxisTag(ctx, d.tag, layout.plot.x + layout.plot.w + 2, d.y, d.fill, C.bg, "left");
    }
    ctx.restore();
  }

  function drawRubber(ctx) {
    if (!rubber) return;
    const x0 = Math.min(rubber.x0, rubber.x1);
    const x1 = Math.max(rubber.x0, rubber.x1);
    const top = layout.top, bot = layout.bot;
    const xL = clamp(x0, top.x, top.x + top.w);
    const xR = clamp(x1, top.x, top.x + top.w);
    if (xR - xL < 1) return;
    ctx.fillStyle = "rgba(240, 193, 75, 0.12)";
    ctx.fillRect(xL, top.y, xR - xL, top.h);
    ctx.fillRect(xL, bot.y, xR - xL, bot.h);
    ctx.strokeStyle = "rgba(240, 193, 75, 0.7)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 2]);
    ctx.strokeRect(xL, top.y, xR - xL, top.h);
    ctx.strokeRect(xL, bot.y, xR - xL, bot.h);
    ctx.setLineDash([]);
  }

  function draw() {
    const canvas = el.canvas;
    const wrap = el.wrap;
    if (!canvas || !rows.length) return;
    const cssW = Math.max(200, wrap.clientWidth);
    const cssH = Math.max(200, wrap.clientHeight);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    layout = computeLayout(cssW, cssH);
    const ext = visibleExtrema();
    const yRatio = yMap(ext.rMin, ext.rMax, layout.top);
    const yAum = yMap(ext.aLo, ext.aHi, layout.top);
    const yIndex = yMap(ext.iMin, ext.iMax, layout.bot);
    layout.yRatio = yRatio;
    layout.yAum = yAum;
    layout.yIndex = yIndex;

    const rTicks = niceTicks(ext.rMin, ext.rMax, 6);
    const aTicks = niceTicks(ext.aLo, ext.aHi, 6);
    const iTicks = niceTicks(ext.iMin, ext.iMax, 5);
    const xt = xTicks();
    const [i0, i1] = visibleSlice();
    const labels = (meta && meta.labels) || {};

    drawPanelBg(ctx, layout.top);
    drawPanelBg(ctx, layout.bot);
    // right spine for AUM
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(layout.top.x + layout.top.w, layout.top.y);
    ctx.lineTo(layout.top.x + layout.top.w, layout.top.y + layout.top.h);
    ctx.stroke();

    drawHGrid(ctx, layout.top, rTicks, yRatio);
    drawHGrid(ctx, layout.bot, iTicks, yIndex);
    drawVGrid(ctx, layout.top.y, layout.top.y + layout.top.h, xt.ticks);
    drawVGrid(ctx, layout.bot.y, layout.bot.y + layout.bot.h, xt.ticks);

    if (dateVisible(ratioStartT)) {
      const x = xOf(ratioStartT);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = C.gold;
      ctx.lineWidth = 0.8;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(x, layout.top.y);
      ctx.lineTo(x, layout.top.y + layout.top.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    clipPlot(ctx, layout.top);
    ctx.fillStyle = "rgba(110, 198, 193, 0.10)";
    fillAum(ctx, yAum, i0, i1, yAum(0));
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 1.15;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    strokeSeries(ctx, yAum, "aum_sum_yi", i0, i1);
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 1.8;
    strokeSeries(ctx, yRatio, "ratio_pct", i0, i1, true, ratioStartT);
    ctx.restore();

    // official dots
    ctx.save();
    for (const i of officialIdx) {
      const r = rows[i];
      if (r.ratio_pct == null || !dateVisible(times[i])) continue;
      const x = xOf(times[i]);
      const y = yRatio(r.ratio_pct);
      if (y < layout.top.y - 2 || y > layout.top.y + layout.top.h + 2) continue;
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = C.official;
      ctx.fill();
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = C.gold;
      ctx.stroke();
    }
    ctx.restore();

    // bottom series
    clipPlot(ctx, layout.bot);
    if (ext.iMin < 100 && ext.iMax > 100) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = C.muted;
      ctx.lineWidth = 0.6;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(layout.bot.x, yIndex(100));
      ctx.lineTo(layout.bot.x + layout.bot.w, yIndex(100));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = C.red;
    ctx.lineWidth = 1.35;
    strokeSeries(ctx, yIndex, "sse_rebased", i0, i1);
    ctx.strokeStyle = C.blue;
    ctx.lineWidth = 1.35;
    strokeSeries(ctx, yIndex, "csi_rebased", i0, i1);
    ctx.restore();

    // y tick labels
    for (const v of rTicks) {
      tickLabelY(ctx, v.toFixed(2), C.gold, layout.top.x - 6, yRatio(v), "right");
    }
    for (const v of aTicks) {
      tickLabelY(ctx, fmtNum(v, 0), C.cyan, layout.top.x + layout.top.w + 6, yAum(v), "left");
    }
    for (const v of iTicks) {
      tickLabelY(ctx, v.toFixed(0), C.text, layout.bot.x - 6, yIndex(v), "right");
    }

    ctx.save();
    ctx.translate(13, layout.top.y + layout.top.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = C.gold;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(labels.y_ratio || "占比（%）", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(layout.w - 13, layout.top.y + layout.top.h / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = C.cyan;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(labels.y_aum || "合计基金规模（亿元，全样本）", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(13, layout.bot.y + layout.bot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = C.text;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const yl = (labels.y_index || "再基准=100（2023-11-01）").replace("\n", " ");
    ctx.fillText(yl, 0, 0);
    ctx.restore();

    // x labels
    ctx.fillStyle = C.text;
    ctx.font = `10.5px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let k = 0; k < xt.ticks.length; k++) {
      const x = xOf(xt.ticks[k]);
      if (x < layout.plot.x - 4 || x > layout.plot.x + layout.plot.w + 4) continue;
      ctx.fillText(xt.labels[k], x, layout.xAxisY + 5);
    }

    // bottom legend
    {
      const items = [
        { color: C.red, text: labels.sse || "上证综指（000001）" },
        { color: C.blue, text: labels.csi || "沪深300（000300）" },
      ];
      ctx.font = `11px ${FONT}`;
      const lineH = 16, padX = 8, padY = 5, iconW = 20;
      const tw = items.reduce((s, it) => s + iconW + ctx.measureText(it.text).width + 14, 0);
      const bw = tw + padX;
      const bh = lineH + padY * 2 - 2;
      const bx = layout.bot.x + 8;
      const by = layout.bot.y + 8;
      layout.botLegendBox = { x: bx, y: by, w: bw, h: bh };
      roundRect(ctx, bx, by, bw, bh, 3);
      ctx.fillStyle = "rgba(21, 27, 38, 0.9)";
      ctx.fill();
      ctx.strokeStyle = C.annoBorder;
      ctx.lineWidth = 0.6;
      ctx.stroke();
      let ix = bx + padX;
      items.forEach((it) => {
        const iy = by + bh / 2;
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(ix, iy);
        ctx.lineTo(ix + 14, iy);
        ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(it.text, ix + iconW, iy);
        ix += iconW + ctx.measureText(it.text).width + 14;
      });
    }

    const legendBox = drawLegend(ctx, layout.top, labels);
    drawGapNote(ctx, layout.top, legendBox);
    const reserved = [];
    if (legendBox) reserved.push(legendBox);
    if (layout.gapNoteBox) reserved.push(layout.gapNoteBox);
    drawEvents(ctx, yRatio, yAum, yIndex, reserved);

    const active = wheelHide ? null : (pinned != null ? pinned : hover);
    drawCrosshair(ctx, active, yRatio, yAum, yIndex);
    drawRubber(ctx);
    updateTooltip(active);
  }

  function requestDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function tooltipHTML(idx) {
    const row = rows[idx];
    const pinMark = pinned === idx ? '<span class="t-pin">已钉住</span>' : "";
    const noRatio = row.denom_flag === "pre_first_official" || row.ratio_pct == null;
    const ratio = noRatio ? "尚无官方分母时点，不计算" : fmtPct(row.ratio_pct, 4);
    const parts = BASKET_FIELDS.map((b) => {
      return `<div class="row"><span class="lab">${b.code} ${b.short}</span><span class="val">${fmtNum(row[b.key], 2)}</span></div>`;
    }).join("");
    const hint = pinned === idx
      ? "再点同一日 / 图区空白 / Esc 解钉"
      : "点击钉住该日";
    return `
      <div class="t-date"><span>${row.date}</span>${pinMark}</div>
      <div class="row"><span class="lab">占比</span><span class="val gold">${ratio}</span></div>
      <div class="row"><span class="lab">合计规模（亿元）</span><span class="val cyan">${fmtNum(row.aum_sum_yi, 2)}</span></div>
      <div class="row"><span class="lab">计算用市值（亿元）</span><span class="val">${fmtNum(row.calc_mkv_yi, 2)}</span></div>
      <div class="row"><span class="lab">分母性质</span><span class="val">${row.denom_flag || "—"}</span></div>
      <div class="row"><span class="lab">锚点日</span><span class="val">${row.anchor_date || "—"}</span></div>
      <div class="sub">${denomText(row)}</div>
      <div class="row"><span class="lab">上证综指</span><span class="val red">${fmtNum(row.sse_comp, 2)}（${row.sse_rebased != null ? row.sse_rebased.toFixed(2) : "—"}）</span></div>
      <div class="row"><span class="lab">沪深300</span><span class="val blue">${fmtNum(row.csi300, 2)}（${row.csi_rebased != null ? row.csi_rebased.toFixed(2) : "—"}）</span></div>
      <hr />
      ${parts}
      <div class="hint">${hint}</div>
    `;
  }

  function overlapArea(a, b, pad) {
    const p = pad == null ? 8 : pad;
    const x0 = Math.max(a.x, b.x - p);
    const y0 = Math.max(a.y, b.y - p);
    const x1 = Math.min(a.x + a.w, b.x + b.w + p);
    const y1 = Math.min(a.y + a.h, b.y + b.h + p);
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  }

  function placeTooltip(idx) {
    const tip = el.tooltip;
    const wrap = el.wrap;
    if (!layout || idx == null) return;
    const t = times[idx];
    const x = xOf(t);
    const wr = wrap.getBoundingClientRect();
    const tipW = tip.offsetWidth || 220;
    const tipH = tip.offsetHeight || 200;
    const row = rows[idx];
    const margin = 8;

    const seriesY = [];
    if (row.ratio_pct != null && t >= ratioStartT) seriesY.push(layout.yRatio(row.ratio_pct));
    if (row.aum_sum_yi != null) seriesY.push(layout.yAum(row.aum_sum_yi));
    if (row.sse_rebased != null) seriesY.push(layout.yIndex(row.sse_rebased));
    if (row.csi_rebased != null) seriesY.push(layout.yIndex(row.csi_rebased));
    const midY = seriesY.length ? seriesY.reduce((a, b) => a + b, 0) / seriesY.length : layout.h / 2;

    const avoid = [];
    if (layout.legendBox) avoid.push(layout.legendBox);
    if (layout.botLegendBox) avoid.push(layout.botLegendBox);
    if (layout.gapNoteBox) avoid.push(layout.gapNoteBox);
    if (layout.annoBoxes) {
      for (const b of layout.annoBoxes) avoid.push(b);
    }

    const maxL = Math.max(margin, wr.width - tipW - margin);
    const maxT = Math.max(margin, wr.height - tipH - margin);
    const xs = [x + 16, x - 16 - tipW];
    const ys = [
      margin,
      midY + 18,
      midY - tipH - 18,
      layout.top.y + 8,
      layout.top.y + layout.top.h - tipH - 8,
      layout.bot.y + 8,
      (layout.botLegendBox ? layout.botLegendBox.y + layout.botLegendBox.h + 10 : layout.bot.y + 40),
      layout.bot.y + layout.bot.h - tipH - 8,
      wr.height - tipH - margin,
    ];
    const cands = [];
    for (const rawL of xs) {
      for (const rawT of ys) {
        cands.push({ left: clamp(rawL, margin, maxL), top: clamp(rawT, margin, maxT) });
      }
    }
    cands.push(
      { left: margin, top: margin },
      { left: maxL, top: margin },
      { left: margin, top: maxT },
      { left: maxL, top: maxT }
    );

    let best = null;
    let bestScore = Infinity;
    for (const c of cands) {
      const box = { x: c.left, y: c.top, w: tipW, h: tipH };
      let score = 0;
      for (const a of avoid) {
        const area = overlapArea(box, a, 8);
        if (area > 0) score += 10000 + area;
      }
      if (box.x <= x && box.x + box.w >= x) score += 80;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      score += Math.abs(cx - x) * 0.05 + Math.abs(cy - midY) * 0.04;
      for (const sy of seriesY) {
        if (sy >= box.y - 6 && sy <= box.y + box.h + 6) score += 30;
      }
      if (score < bestScore) {
        bestScore = score;
        best = box;
      }
    }
    tip.style.left = `${best ? best.x : clamp(x + 16, margin, maxL)}px`;
    tip.style.top = `${best ? best.y : clamp(midY + 18, margin, maxT)}px`;
  }

  function updateTooltip(idx) {
    const tip = el.tooltip;
    if (idx == null || wheelHide || rubber) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.innerHTML = tooltipHTML(idx);
    placeTooltip(idx);
  }

  function pin(i) { pinned = i; hover = i; requestDraw(); }
  function unpin() {
    pinned = null;
    if (lastPt && layout && inDateStrip(lastPt)) hover = nearestIndex(tOf(lastPt.x));
    requestDraw();
  }

  function handleClick(pt) {
    if (inDateStrip(pt)) {
      const i = nearestIndex(tOf(pt.x));
      if (pinned === i) unpin();
      else pin(i);
    } else if (hitArea(pt) === "margin") {
      if (pinned != null) unpin();
    }
  }

  function hideCrosshairForWheel() {
    wheelHide = true;
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelHide = false;
      requestDraw();
    }, WHEEL_HIDE_MS);
  }

  function onPointerDown(ev) {
    if (ev.button != null && ev.button !== 0) return;
    const pt = cssPoint(ev);
    ptr.down = true;
    ptr.x0 = pt.x;
    ptr.y0 = pt.y;
    ptr.lastX = pt.x;
    ptr.t0 = tOf(pt.x);
    ptr.view0AtDown = view0;
    ptr.view1AtDown = view1;
    ptr.shifted = ev.shiftKey;
    ptr.mode = null;
    ptr.area = hitArea(pt);
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (_) {}
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    const pt = cssPoint(ev);
    lastPt = pt;
    if (ptr.down) {
      const dist = Math.hypot(pt.x - ptr.x0, pt.y - ptr.y0);
      if (!ptr.mode && dist >= DRAG_THRESH) {
        if (ptr.area === "plot-top" || ptr.area === "plot-bot" || ptr.area === "gap") {
          ptr.mode = (ptr.shifted || ev.shiftKey) ? "pan" : "zoom";
        } else {
          ptr.mode = "ignore";
        }
      }
      if (ptr.mode === "zoom") {
        rubber = { x0: ptr.x0, x1: pt.x };
        requestDraw();
        return;
      }
      if (ptr.mode === "pan") {
        const r = layout.plot;
        const s = ptr.view1AtDown - ptr.view0AtDown || 1;
        const tNow = ptr.view0AtDown + ((pt.x - r.x) / r.w) * s;
        const tStart = ptr.view0AtDown + ((ptr.x0 - r.x) / r.w) * s;
        setView(ptr.view0AtDown - (tNow - tStart), ptr.view1AtDown - (tNow - tStart));
        rubber = null;
        return;
      }
      return;
    }
    if (wheelHide) return;
    if (pinned != null) return;
    if (inDateStrip(pt)) {
      hover = nearestIndex(tOf(pt.x));
    } else {
      hover = null;
    }
    requestDraw();
  }

  function onPointerUp(ev) {
    if (!ptr.down) return;
    const pt = cssPoint(ev);
    ptr.down = false;
    if (ptr.mode === "zoom" && rubber) {
      const xa = Math.min(rubber.x0, rubber.x1);
      const xb = Math.max(rubber.x0, rubber.x1);
      rubber = null;
      if (xb - xa >= DRAG_THRESH) {
        let t0 = tOf(xa), t1 = tOf(xb);
        if (t1 < t0) { const tmp = t0; t0 = t1; t1 = tmp; }
        setView(t0, t1);
      } else {
        requestDraw();
      }
    } else if (ptr.mode === "pan") {
      rubber = null;
      requestDraw();
    } else if (!ptr.mode) {
      rubber = null;
      handleClick(pt);
    } else {
      rubber = null;
      requestDraw();
    }
    ptr.mode = null;
  }

  function onPointerLeave(ev) {
    if (ptr.down) return;
    if (pinned == null) {
      hover = null;
      requestDraw();
    }
  }

  function onWheelChart(ev) {
    ev.preventDefault();
    hideCrosshairForWheel();
    const pt = cssPoint(ev);
    let anchor;
    if (inDateStrip(pt) || (layout && pt.x >= layout.plot.x && pt.x <= layout.plot.x + layout.plot.w)) {
      anchor = times[nearestIndex(tOf(pt.x))];
    } else {
      anchor = (view0 + view1) / 2;
    }
    const factor = ev.deltaY < 0 ? 0.82 : 1 / 0.82;
    zoomAround(anchor, factor);
  }

  function onKey(ev) {
    if (ev.key === "Escape") {
      if (ptr.down) {
        ptr.down = false;
        ptr.mode = null;
        rubber = null;
      }
      if (pinned != null) unpin();
      else requestDraw();
    }
  }

  /* ---------- slider ---------- */
  const sliderPtr = { mode: null, startX: 0, v0: 0, v1: 0 };

  function syncSlider() {
    const track = el.track;
    const range = el.range;
    if (!track || !range || !(full1 > full0)) return;
    const w = track.clientWidth || 1;
    const left = ((view0 - full0) / (full1 - full0)) * 100;
    const right = ((view1 - full0) / (full1 - full0)) * 100;
    range.style.left = `${left}%`;
    range.style.width = `${Math.max(0, right - left)}%`;
    const a = fmtDay(times[nearestIndex(view0)]);
    const b = fmtDay(times[nearestIndex(view1)]);
    el.rangeLabel.textContent = `${a} — ${b}`;
  }

  function tFromSliderClientX(clientX) {
    const r = el.track.getBoundingClientRect();
    const p = clamp((clientX - r.left) / (r.width || 1), 0, 1);
    return full0 + p * (full1 - full0);
  }

  function onSliderDown(mode, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    sliderPtr.mode = mode;
    sliderPtr.startX = ev.clientX;
    sliderPtr.v0 = view0;
    sliderPtr.v1 = view1;
    el.range.classList.add("grabbing");
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (_) {}
  }

  function onSliderMove(ev) {
    if (!sliderPtr.mode) return;
    const t = tFromSliderClientX(ev.clientX);
    const minSpan = Math.min(MIN_SPAN_MS, full1 - full0);
    if (sliderPtr.mode === "lo") {
      setView(Math.min(t, sliderPtr.v1 - minSpan), sliderPtr.v1);
    } else if (sliderPtr.mode === "hi") {
      setView(sliderPtr.v0, Math.max(t, sliderPtr.v0 + minSpan));
    } else if (sliderPtr.mode === "pan") {
      const t0 = tFromSliderClientX(sliderPtr.startX);
      const dt = t - t0;
      setView(sliderPtr.v0 + dt, sliderPtr.v1 + dt);
    }
  }

  function onSliderUp(ev) {
    if (!sliderPtr.mode) return;
    sliderPtr.mode = null;
    el.range.classList.remove("grabbing");
  }

  function onTrackDown(ev) {
    if (ev.target === el.handleLo || ev.target === el.handleHi || ev.target === el.range) return;
    ev.preventDefault();
    const t = tFromSliderClientX(ev.clientX);
    const span = view1 - view0;
    setView(t - span / 2, t + span / 2);
  }

  function onSliderWheel(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    hideCrosshairForWheel();
    const anchor = tFromSliderClientX(ev.clientX);
    const snapped = times[nearestIndex(anchor)];
    const factor = ev.deltaY < 0 ? 0.82 : 1 / 0.82;
    zoomAround(snapped, factor);
  }

  function bindSlider() {
    el.handleLo.addEventListener("pointerdown", (e) => onSliderDown("lo", e));
    el.handleHi.addEventListener("pointerdown", (e) => onSliderDown("hi", e));
    el.range.addEventListener("pointerdown", (e) => {
      if (e.target === el.handleLo || e.target === el.handleHi) return;
      onSliderDown("pan", e);
    });
    window.addEventListener("pointermove", onSliderMove);
    window.addEventListener("pointerup", onSliderUp);
    window.addEventListener("pointercancel", onSliderUp);
    el.track.addEventListener("pointerdown", onTrackDown);
    el.slider.addEventListener("wheel", onSliderWheel, { passive: false });
  }

  function fillHeader() {
    const title = (meta && meta.title) || document.getElementById("title").textContent;
    document.getElementById("title").textContent = title;
    document.title = title.replace(/\s+/g, " ").trim();
    const asOf = (meta && meta.as_of) || (meta && meta.window && meta.window.end) || "2026-11-06";
    const anchor = (meta && meta.latest_official_anchor) || "2026-10-30";
    document.getElementById("pill-asof").textContent = asOf;
    document.getElementById("pill-anchor").textContent = anchor;
    const start = (meta && meta.window && meta.window.start) || (rows[0] && rows[0].date) || "2023-11-01";
    if (el.reset) el.reset.title = `恢复 ${start} 至 ${asOf} 全窗口`;
    if (meta && meta.basket) {
      const line = meta.basket.line || "";
      const win = `区间：${start}至${asOf}（A股交易日）`;
      document.getElementById("line-basket").textContent = line ? `${line}　　${win}` : win;
    }
    if (meta && meta.formula) document.getElementById("line-formula").textContent = meta.formula;
    if (meta && meta.note) document.getElementById("line-note").textContent = meta.note;
    if (meta && meta.footer) el.footer.textContent = meta.footer;
  }

  function bindChart() {
    const c = el.canvas;
    c.addEventListener("pointerdown", onPointerDown);
    c.addEventListener("pointermove", onPointerMove);
    c.addEventListener("pointerup", onPointerUp);
    c.addEventListener("pointercancel", onPointerUp);
    c.addEventListener("pointerleave", onPointerLeave);
    c.addEventListener("wheel", onWheelChart, { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", onKey);
    el.reset.addEventListener("click", () => resetView());
    const ro = new ResizeObserver(() => requestDraw());
    ro.observe(el.wrap);
    window.addEventListener("resize", () => requestDraw());
  }

  async function main() {
    try {
      const pack = await loadAll();
      let list = normalizeDaily(pack.apiDaily || pack.fileDaily);
      const w0 = pack.start || "2023-11-01";
      // Include daily-update rows after the original seed window.end (e.g. 11-09, 11-10).
      const apiAsOf = pack.apiMeta && (pack.apiMeta.as_of || pack.apiMeta.latest_trade_date);
      const fileAsOf = pack.fileMeta && pack.fileMeta.as_of;
      const lastDate = list.length ? list[list.length - 1].date : null;
      const w1 = apiAsOf || fileAsOf || lastDate || pack.end || "2026-11-06";
      list = list.filter((r) => r.date >= w0);
      if (!list.length) throw new Error("日频序列为空");
      const evLocal = normalizeEvents(pack.fileEvents);
      const evApi = normalizeEvents(pack.apiEvents);
      // Prefer live /api/events so 窗口末/期末 follow as_of; keep local snapshot as fallback only.
      events = evApi.length ? evApi : evLocal;
      rows = list;
      meta = mergeMeta(pack.fileMeta, pack.apiMeta, rows, pack.apiAnchors, w0, w1);
      times = rows.map((r) => parseDay(r.date));
      ratioStartT = parseDay((meta && meta.first_official_anchor) || RATIO_START);
      officialIdx = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].denom_flag === "official") officialIdx.push(i);
      }
      full0 = times[0];
      full1 = times[times.length - 1];
      view0 = full0;
      view1 = full1;
      fillHeader();
      bindChart();
      bindSlider();
      syncSlider();
      showStatus("");
      window.__share = {
        meta, rows, events,
        get view() { return [fmtDay(view0), fmtDay(view1)]; },
      };
      draw();
    } catch (err) {
      console.error(err);
      showStatus(`数据加载失败：${err.message || err}。请在 web/ 目录下用本地静态服务打开（见 README）。`);
    }
  }

  main();
})();
