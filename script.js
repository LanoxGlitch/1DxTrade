/* ============================================================
   Deriv Synthetic Indices Scanner
   Data source: Deriv WebSocket API (wss://ws.derivws.com/websockets/v3?app_id=1089)
   No API key needed for public market data (ticks_history / candles).
   ============================================================ */

const APP_ID = 1089; // Deriv's public demo app_id, fine for market-data-only use
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

// We match by the human-readable Deriv display name rather than hardcoding
// symbol codes, because Deriv's internal codes for Jump and Step indices
// vary/change. The app calls `active_symbols` on connect and resolves the
// correct code for each name automatically.
const WANTED_NAMES = [
  "Volatility 10 Index",
  "Volatility 10 (1s) Index",
  "Volatility 15 (1s) Index",
  "Volatility 25 Index",
  "Volatility 25 (1s) Index",
  "Volatility 50 Index",
  "Volatility 50 (1s) Index",
  "Volatility 75 Index",
  "Volatility 75 (1s) Index",
  "Volatility 100 Index",
  "Volatility 100 (1s) Index",
  "Jump 10 Index",
  "Jump 50 Index",
  "Jump 75 Index",
  "Step 100 Index",
  "Step 200 Index",
  "Step 300 Index",
  "Step 400 Index",
  "Step 500 Index",
];

// Populated at runtime from the active_symbols response: [{ code, name }]
let SYMBOLS = [];

const GRANULARITY = { H1: 3600, H4: 14400, M15: 900 };
const CANDLE_COUNT = 250; // enough for 200 EMA to stabilize

// ---------- State ----------
// Populated once SYMBOLS is resolved from active_symbols (see resolveSymbols())
const state = {};
function initStateFor(symbolList) {
  symbolList.forEach(s => {
    if (state[s.code]) return;
    state[s.code] = {
      name: s.name,
      code: s.code,
      price: null,
      candles: { H1: [], H4: [], M15: [] },
      bias: { H1: "None", H4: "None" },
      priceVs50: "None",
      signal: "None",
      signalTime: null,
      lastUpdate: null,
      connected: false,
      impulseBreach: { direction: null, active: false, brokeBias: false },
      lastSignalCandleTime: null,
    };
  });
}

let ws = null;
let reconnectAttempts = 0;
let soundEnabled = true;
let notifPermission = (typeof Notification !== "undefined") ? Notification.permission : "denied";
let currentFilter = "all";
let currentSort = "alpha";
let searchTerm = "";
const signalHistory = [];

// ---------- EMA ----------
function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// returns array of EMA values aligned to the tail of `values` (same length output as input, nulls until warmed up)
function calcEMASeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function getBias(candles) {
  if (!candles || candles.length < 200) return "Mixed";
  const closes = candles.map(c => c.close);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const lastClose = closes[closes.length - 1];
  if (ema20 === null || ema50 === null || ema200 === null) return "Mixed";

  if (lastClose > ema200 && ema20 > ema50 && ema50 > ema200) return "Bullish";
  if (lastClose < ema200 && ema20 < ema50 && ema50 < ema200) return "Bearish";
  return "Mixed";
}

// ---------- Signal engine (15m) ----------
// Implements:
// Sell: H1 Bearish & H4 Bearish, price below 50EMA(15m), bullish impulse pushes
//       above 50EMA WITHOUT changing H1/H4 bias, price pulls back, a 15m candle
//       closes back below 50EMA -> trigger SELL on that close.
// Buy: mirror logic.
function evaluateSignal(sym) {
  const s = state[sym];
  const m15 = s.candles.M15;
  if (m15.length < 60) return; // need enough history for stable 50EMA

  const closes = m15.map(c => c.close);
  const ema50Series = calcEMASeries(closes, 50);
  const lastIdx = closes.length - 1;
  const ema50Now = ema50Series[lastIdx];
  if (ema50Now === null) return;

  const lastClose = closes[lastIdx];
  const lastCandleTime = m15[lastIdx].epoch;

  s.priceVs50 = lastClose > ema50Now ? "Above" : "Below";

  const h1 = s.bias.H1;
  const h4 = s.bias.H4;

  // Look back over the recent window (last ~12 candles / 3 hours) to detect
  // impulse-above-then-reclaim-below (sell) or impulse-below-then-reclaim-above (buy)
  const lookback = Math.min(16, lastIdx);
  let sawOppositeImpulse = false;

  if (h1 === "Bearish" && h4 === "Bearish") {
    // Need: was below 50EMA, then a candle closed above 50EMA (impulse), bias unchanged,
    // then current candle closes back below 50EMA => SELL
    for (let i = lastIdx - lookback; i < lastIdx; i++) {
      if (i < 1 || ema50Series[i] === null || ema50Series[i - 1] === null) continue;
      const wasBelow = closes[i - 1] < ema50Series[i - 1];
      const isAbove = closes[i] > ema50Series[i];
      if (wasBelow && isAbove) { sawOppositeImpulse = true; break; }
    }
    const justClosedBelow = lastClose < ema50Now && closes[lastIdx - 1] >= ema50Series[lastIdx - 1];

    if (sawOppositeImpulse && justClosedBelow && s.lastSignalCandleTime !== lastCandleTime) {
      triggerSignal(sym, "Sell", lastCandleTime, lastClose);
      return;
    }
  }

  if (h1 === "Bullish" && h4 === "Bullish") {
    // Need: was above 50EMA, then a candle closed below 50EMA (impulse), bias unchanged,
    // then current candle closes back above 50EMA => BUY
    for (let i = lastIdx - lookback; i < lastIdx; i++) {
      if (i < 1 || ema50Series[i] === null || ema50Series[i - 1] === null) continue;
      const wasAbove = closes[i - 1] > ema50Series[i - 1];
      const isBelow = closes[i] < ema50Series[i];
      if (wasAbove && isBelow) { sawOppositeImpulse = true; break; }
    }
    const justClosedAbove = lastClose > ema50Now && closes[lastIdx - 1] <= ema50Series[lastIdx - 1];

    if (sawOppositeImpulse && justClosedAbove && s.lastSignalCandleTime !== lastCandleTime) {
      triggerSignal(sym, "Buy", lastCandleTime, lastClose);
      return;
    }
  }
}

function triggerSignal(symCode, type, candleTime, price) {
  const s = state[symCode];
  s.signal = type;
  s.signalTime = candleTime * 1000;
  s.lastSignalCandleTime = candleTime; // prevents duplicate alert for same candle

  const entry = {
    name: s.name,
    type,
    time: candleTime * 1000,
    h1: s.bias.H1,
    h4: s.bias.H4,
    price,
  };
  signalHistory.unshift(entry);
  if (signalHistory.length > 200) signalHistory.pop();

  fireAlert(s.name, type, price);
  renderHistory();
}

// ---------- Alerts ----------
function fireAlert(name, type, price) {
  // Sound
  if (soundEnabled) {
    try {
      const audio = document.getElementById("alertSound");
      audio.currentTime = 0;
      audio.play().catch(() => {});
      beep(type);
    } catch (e) {}
  }
  // Browser notification
  if (notifPermission === "granted") {
    try {
      new Notification(`${type.toUpperCase()} Signal — ${name}`, {
        body: `Price: ${price.toFixed(4)} | 15m candle close confirmed`,
        icon: "",
      });
    } catch (e) {}
  }
  // Toast popup
  showToast(name, type, price);
}

// Simple WebAudio beep as a fallback/in addition to the <audio> tag
function beep(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = type === "Buy" ? 880 : 440;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

function showToast(name, type, price) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type.toLowerCase()}`;
  toast.innerHTML = `<div class="toast-title">${type.toUpperCase()} — ${name}</div>
                      <div class="toast-body">Price ${price.toFixed(4)} · 15m close confirmed</div>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 7000);
}

// ---------- WebSocket / Deriv API ----------
function connect() {
  setConnStatus("connecting");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setConnStatus("connected");
    resolveSymbolsThenSubscribe();
  };

  ws.onmessage = (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch (e) { return; }
    if (data.error) {
      console.warn("Deriv API error:", data.error.message);
      return;
    }
    if (data.msg_type === "candles") handleCandles(data);
    if (data.msg_type === "ohlc") handleOhlcUpdate(data);
    if (data.msg_type === "tick") handleTick(data);
    if (data.msg_type === "active_symbols") handleActiveSymbols(data);
  };

  ws.onerror = () => setConnStatus("error");

  ws.onclose = () => {
    setConnStatus("error");
    SYMBOLS.forEach(s => state[s.code].connected = false);
    updateSummary();
    scheduleReconnect();
  };
}

function resolveSymbolsThenSubscribe() {
  send({ active_symbols: "brief", req_id: 1 });
}

function handleActiveSymbols(data) {
  const list = data.active_symbols || [];
  const resolved = [];
  WANTED_NAMES.forEach(wantedName => {
    const match = list.find(s =>
      (s.display_name || "").toLowerCase() === wantedName.toLowerCase()
    );
    if (match) {
      resolved.push({ code: match.symbol, name: match.display_name });
    } else {
      console.warn(`Symbol not found on Deriv: "${wantedName}" — skipping. It may be unavailable in your region or renamed.`);
    }
  });

  SYMBOLS = resolved;
  initStateFor(SYMBOLS);

  if (!SYMBOLS.length) {
    document.getElementById("scannerBody").innerHTML =
      `<tr><td colspan="8" class="loading-row">No matching symbols found on Deriv. Check console for details.</td></tr>`;
    return;
  }

  SYMBOLS.forEach(sym => {
    requestCandles(sym.code, "H1");
    requestCandles(sym.code, "H4");
    requestCandles(sym.code, "M15");
    subscribeTicks(sym.code);
  });

  renderAll();
}
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * Math.pow(1.6, reconnectAttempts));
  setTimeout(connect, delay);
}

function requestCandles(symbolCode, tf) {
  const granularity = GRANULARITY[tf];
  send({
    ticks_history: symbolCode,
    style: "candles",
    granularity,
    count: CANDLE_COUNT,
    end: "latest",
    req_id: reqId(symbolCode, tf),
  });
}

function subscribeTicks(symbolCode) {
  // Subscribe to 15m OHLC stream for live-forming candle updates, used to refresh price/EMA in near-real-time
  send({
    ticks_history: symbolCode,
    style: "candles",
    granularity: GRANULARITY.M15,
    count: 1,
    end: "latest",
    subscribe: 1,
    req_id: reqId(symbolCode, "M15_sub"),
  });
}

let reqCounter = 1000;
const reqMap = {}; // req_id -> {symbolCode, tf}
function reqId(symbolCode, tf) {
  const id = ++reqCounter;
  reqMap[id] = { symbolCode, tf };
  return id;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleCandles(data) {
  const meta = reqMap[data.req_id];
  if (!meta) return;
  const { symbolCode, tf } = meta;
  const s = state[symbolCode];
  if (!s || !data.candles) return;

  const key = tf === "M15_sub" ? "M15" : tf;
  s.candles[key] = data.candles.map(c => ({
    epoch: c.epoch,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  }));
  s.connected = true;
  s.lastUpdate = Date.now();

  recompute(symbolCode);
}

function handleOhlcUpdate(data) {
  // Streaming update for the subscribed 15m candle
  const ohlc = data.ohlc;
  if (!ohlc) return;
  const symbolCode = ohlc.symbol;
  const s = state[symbolCode];
  if (!s) return;

  const epoch = parseInt(ohlc.open_time, 10);
  const candle = {
    epoch,
    open: parseFloat(ohlc.open),
    high: parseFloat(ohlc.high),
    low: parseFloat(ohlc.low),
    close: parseFloat(ohlc.close),
  };

  const arr = s.candles.M15;
  if (arr.length && arr[arr.length - 1].epoch === epoch) {
    arr[arr.length - 1] = candle; // update forming candle
  } else {
    arr.push(candle); // new candle closed/opened
    if (arr.length > CANDLE_COUNT) arr.shift();
    // a new M15 candle means previous one fully closed — re-evaluate H1/H4 too occasionally
    requestCandles(symbolCode, "H1");
    requestCandles(symbolCode, "H4");
  }

  s.price = candle.close;
  s.connected = true;
  s.lastUpdate = Date.now();
  recompute(symbolCode);
}

function handleTick(data) {
  const tick = data.tick;
  if (!tick) return;
  const s = state[tick.symbol];
  if (!s) return;
  s.price = parseFloat(tick.quote);
  s.lastUpdate = Date.now();
  renderRow(tick.symbol);
}

function recompute(symbolCode) {
  const s = state[symbolCode];
  s.bias.H1 = getBias(s.candles.H1);
  s.bias.H4 = getBias(s.candles.H4);
  if (s.candles.M15.length) {
    s.price = s.candles.M15[s.candles.M15.length - 1].close;
  }
  evaluateSignal(symbolCode);
  renderAll();
}

// ---------- UI ----------
function setConnStatus(status) {
  const el = document.getElementById("connStatus");
  const text = document.getElementById("connStatusText");
  el.className = "conn-status conn-" + status;
  text.textContent = status === "connected" ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…";
}

function biasBadge(bias) {
  if (bias === "Bullish") return `<span class="badge badge-bullish">Bullish</span>`;
  if (bias === "Bearish") return `<span class="badge badge-bearish">Bearish</span>`;
  if (bias === "Mixed") return `<span class="badge badge-mixed">Mixed</span>`;
  return `<span class="badge badge-none">—</span>`;
}

function signalBadge(sig) {
  if (sig === "Buy") return `<span class="badge badge-buy">BUY</span>`;
  if (sig === "Sell") return `<span class="badge badge-sell">SELL</span>`;
  return `<span class="badge badge-none">No Signal</span>`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function getFilteredSorted() {
  let list = Object.values(state);

  if (searchTerm) {
    list = list.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()));
  }

  switch (currentFilter) {
    case "bullish": list = list.filter(s => s.bias.H1 === "Bullish" && s.bias.H4 === "Bullish"); break;
    case "bearish": list = list.filter(s => s.bias.H1 === "Bearish" && s.bias.H4 === "Bearish"); break;
    case "active": list = list.filter(s => s.signal === "Buy" || s.signal === "Sell"); break;
    case "buy": list = list.filter(s => s.signal === "Buy"); break;
    case "sell": list = list.filter(s => s.signal === "Sell"); break;
  }

  const biasRank = { Bullish: 0, Bearish: 1, Mixed: 2, None: 3 };
  switch (currentSort) {
    case "alpha": list.sort((a, b) => a.name.localeCompare(b.name)); break;
    case "signal": list.sort((a, b) => (b.signal !== "None") - (a.signal !== "None")); break;
    case "buy": list.sort((a, b) => (b.signal === "Buy") - (a.signal === "Buy")); break;
    case "sell": list.sort((a, b) => (b.signal === "Sell") - (a.signal === "Sell")); break;
    case "h1": list.sort((a, b) => biasRank[a.bias.H1] - biasRank[b.bias.H1]); break;
    case "h4": list.sort((a, b) => biasRank[a.bias.H4] - biasRank[b.bias.H4]); break;
  }
  return list;
}

function renderAll() {
  renderTable();
  updateSummary();
}

function renderTable() {
  const tbody = document.getElementById("scannerBody");
  const list = getFilteredSorted();

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading-row">No indices match the current filter</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(s => rowHtml(s)).join("");
}

function rowHtml(s) {
  const priceVsBadge = s.priceVs50 === "Above"
    ? `<span class="badge-above">Above 50 EMA</span>`
    : s.priceVs50 === "Below"
      ? `<span class="badge-below">Below 50 EMA</span>`
      : `<span class="muted-text">—</span>`;

  const flashClass = s.signal === "Buy" ? "row-flash-buy" : s.signal === "Sell" ? "row-flash-sell" : "";

  return `<tr data-code="${s.code}" class="${flashClass}">
    <td class="index-name">${s.name}</td>
    <td>${s.price !== null ? s.price.toFixed(4) : "—"}</td>
    <td>${biasBadge(s.bias.H1)}</td>
    <td>${biasBadge(s.bias.H4)}</td>
    <td>${priceVsBadge}</td>
    <td>${signalBadge(s.signal)}</td>
    <td>${fmtTime(s.signalTime)}</td>
    <td class="muted-text">${fmtTime(s.lastUpdate)}</td>
  </tr>`;
}

function renderRow(symbolCode) {
  // Lightweight per-tick price update without full table re-render
  const s = state[symbolCode];
  const row = document.querySelector(`tr[data-code="${symbolCode}"]`);
  if (row && s.price !== null) {
    const priceCell = row.children[1];
    if (priceCell) priceCell.textContent = s.price.toFixed(4);
    const updateCell = row.children[7];
    if (updateCell) updateCell.textContent = fmtTime(s.lastUpdate);
  }
}

function renderHistory() {
  const tbody = document.getElementById("historyBody");
  if (!signalHistory.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">No signals yet</td></tr>`;
    return;
  }
  tbody.innerHTML = signalHistory.slice(0, 100).map(h => `
    <tr>
      <td class="index-name">${h.name}</td>
      <td>${signalBadge(h.type)}</td>
      <td>${fmtTime(h.time)}</td>
      <td>${biasBadge(h.h1)}</td>
      <td>${biasBadge(h.h4)}</td>
      <td>${h.price.toFixed(4)}</td>
    </tr>
  `).join("");
}

function updateSummary() {
  const all = Object.values(state);
  document.getElementById("cardTracked").textContent = all.length;
  document.getElementById("cardConnected").textContent = all.filter(s => s.connected).length;
  document.getElementById("cardBuy").textContent = all.filter(s => s.signal === "Buy").length;
  document.getElementById("cardSell").textContent = all.filter(s => s.signal === "Sell").length;
}

// ---------- Event wiring ----------
document.getElementById("searchInput").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderTable();
});

document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    currentFilter = chip.dataset.filter;
    renderTable();
  });
});

document.getElementById("sortSelect").addEventListener("change", (e) => {
  currentSort = e.target.value;
  renderTable();
});

document.getElementById("soundToggle").addEventListener("click", (e) => {
  soundEnabled = !soundEnabled;
  e.target.classList.toggle("muted", !soundEnabled);
  e.target.textContent = soundEnabled ? "🔔" : "🔕";
});

document.getElementById("notifPermBtn").addEventListener("click", async () => {
  if (typeof Notification === "undefined") return;
  const perm = await Notification.requestPermission();
  notifPermission = perm;
  document.getElementById("notifPermBtn").textContent = perm === "granted" ? "🔔" : "🔕";
});

document.getElementById("clearHistoryBtn").addEventListener("click", () => {
  signalHistory.length = 0;
  renderHistory();
});

// Sortable column headers (click to sort)
document.querySelectorAll("#scannerTable thead th").forEach((th, idx) => {
  const sortKeys = ["alpha", null, "h1", "h4", null, "signal", null, null];
  th.addEventListener("click", () => {
    const key = sortKeys[idx];
    if (!key) return;
    currentSort = key;
    document.getElementById("sortSelect").value = key;
    renderTable();
  });
});

// ---------- Init ----------
renderAll();
renderHistory();
connect();

// Periodic safety re-render (keeps "last update" timers fresh even without new ticks)
setInterval(renderAll, 5000);
