# ReclaimScan — Deriv Synthetic Index Scanner

A single standalone `index.html` (HTML + CSS + JS embedded, no build step) that scans 19 Deriv synthetic indices and fires Buy/Sell alerts on a 15‑minute EMA50 reclaim, filtered by H1/H4 EMA20/50/200 trend bias.

## Data source — no backend required

Deriv exposes a public WebSocket API at `wss://ws.derivws.com/websockets/v3` that serves live and historical candle data for synthetic indices directly to browsers — it's the same feed Deriv's own web trader uses, and it requires no API key for read‑only market data (`active_symbols`, `ticks_history`). That's why this stays a single static HTML file: the page opens its own WebSocket connection straight to Deriv, with no server in between.

The file ships with Deriv's public demo `app_id` (`1089`), which works out of the box. For your own production deployment, register a free app at https://api.deriv.com/dashboard and replace the `APP_ID` constant near the top of the `<script>` block — this is a client identifier for Deriv's own rate‑limit/billing attribution, not a secret, so it's safe to keep client‑side.

Symbol codes (e.g. `R_10`, `1HZ100V`) are **not hardcoded** — on load, the page calls `active_symbols` and matches each requested instrument (Volatility/Jump/Step, number, "1s" variant) against what Deriv currently lists. This avoids shipping a guessed/stale symbol table; if Deriv ever renames or retires an instrument, the row will show "Unavailable" instead of silently using a wrong code.

## How the strategy is implemented

- **H1/H4 bias**: fetched as 300‑candle histories every 90 seconds per symbol, independent of the 15m view, with full EMA20/50/200 series computed client‑side.
- **15m signals**: the 15m candle stream is a live WebSocket subscription (`ticks_history` with `subscribe:1`); each time the open time advances, the previous candle is treated as closed and run through a small state machine: idle → impulse‑through‑EMA50‑against‑bias → reclaim‑close‑confirms‑signal, with the bias re‑checked on every candle so a setup is cancelled if H1/H4 flips mid‑impulse, per the spec.
- Duplicate alerts are prevented by tracking which candle epochs have already been processed per symbol.

## Deploy to GitHub + Vercel

1. Create a new GitHub repo and add this `index.html` at the repo root (no other files needed).
2. Push to GitHub.
3. In Vercel: **New Project → Import** the repo. Framework preset: **Other** (static). Build command: none. Output directory: `.` (root).
4. Deploy. Vercel will serve `index.html` directly.

No environment variables, build step, or server functions are required.

## Notes / limitations

- Browser notifications and sound require a user gesture first (click the bell/speaker icons) — this is a browser security requirement, not a bug.
- The public demo `app_id` is rate‑limited by Deriv; if you scale this to more users hitting the same shared key, get your own `app_id`.
- This is a market scanner, not a trade executor — it does not place orders. It's also not financial advice.
