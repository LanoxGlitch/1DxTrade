# Deriv Synthetic Indices Scanner

A real-time, browser-only scanner for Deriv synthetic indices that detects the H1/H4-bias + 15m pullback-retest strategy you specified.

## Files

- `index.html` — page structure
- `style.css` — dark trading-dashboard styling
- `script.js` — WebSocket connection, EMA/bias math, signal engine, UI rendering
- `strategy.pine` — Pine Script v5 version of the identical strategy, for TradingView backtesting/visual verification

## Data source

This connects directly from the browser to **Deriv's public WebSocket API** (`wss://ws.derivws.com/websockets/v3?app_id=1089`). No backend, no API key, and no account login is required to read market data (ticks and candles) — only actual trading requires authentication. This is why the project can be a static site with no server component.

On connect, the app calls Deriv's `active_symbols` endpoint and matches indices by display name (e.g. "Volatility 75 Index", "Step 200 Index") rather than hardcoding internal symbol codes, since Deriv's internal codes for Jump and Step indices are not consistently documented and can vary. If any requested index isn't found (e.g. it doesn't exist in your account region), it's skipped and logged to the browser console — open dev tools to check if a row is missing.

## How the strategy is implemented

- **Bias (H1/H4):** for each timeframe, pulls candles via `ticks_history` with `style: candles` and the matching `granularity` (3600 for H1, 14400 for H4), computes 20/50/200 EMA on closes, and classifies Bullish/Bearish/Mixed exactly per your spec.
- **Execution (15m):** subscribes to streaming 15m OHLC. On each new closed candle, it scans a rolling lookback window (16 bars ≈ 4 hours) for the "impulse beyond the 50 EMA against current bias, then reclaim" pattern. A signal fires only on the candle where price closes back on the bias side of the 50 EMA, and is locked to that candle's timestamp so the same candle can never re-fire the alert.
- **Bias-unchanged condition:** since H1/H4 bias is recalculated from live EMA stacking, a genuine bias flip during the impulse will naturally remove the Bullish/Bullish or Bearish/Bearish requirement, which satisfies condition 5 of your spec (impulse must not change the higher timeframe bias).

## Running locally

No build step needed — it's static. Just open `index.html` in a browser, or serve it:

```bash
npx serve .
```

## Deploying to GitHub + Vercel

1. Create a new GitHub repo and push these three files (plus this README) to it.
2. Go to [vercel.com/new](https://vercel.com/new), import the repo.
3. Framework preset: **Other** (no build command needed — it's static HTML/CSS/JS).
4. Deploy. Vercel will serve `index.html` at the root automatically.

For GitHub Pages instead: Settings → Pages → Deploy from branch → `main` → `/ (root)`.

## Important notes and limitations

- **Browser notifications and autoplay audio** require a user interaction first (click the bell icon) due to browser security policies — this is normal and not a bug.
- **Free public `app_id=1089`** is rate-limited by Deriv for shared/demo use. For heavier personal use, register your own free app_id at [api.deriv.com](https://api.deriv.com) and swap it into `script.js` (`APP_ID` constant).
- **This is not financial advice** and the strategy as implemented has not been historically backtested by me — use the included `strategy.pine` on TradingView's Strategy Tester first to evaluate its historical performance on each instrument before relying on the live scanner.
- The Pine Script's `biasUnchanged` check currently trusts the live-recalculated H1/H4 bias rather than storing a true bar-by-bar bias history; this matches the JS scanner's behavior but is worth tightening if you want a stricter backtest (i.e., explicitly persist bias state per H1/H4 bar across the lookback window).
