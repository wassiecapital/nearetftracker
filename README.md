# nearetftracker

Daily net creation flows for US-listed **spot NEAR Protocol ETFs**, rebuilt by
GitHub Actions and served as a static page, with an on-chain custody cross-check.

Live page: `https://<you>.github.io/nearetftracker/`

---

## Why this exists, and why it is append-only

Nobody publishes a NEAR ETF flow series. Checked 5 Oct 2026:

| Source | NEAR flows? |
|---|---|
| Farside Investors | No — `/near/` 404s; covers BTC, ETH, SOL, HYP, ZEC |
| SoSoValue OpenAPI | Endpoint answers, `us-near-spot` returns **0 rows** |
| CoinGlass | No NEAR entry; ETF flow API is BTC/ETH only |
| stockanalysis.com/etf/NRR | Stale share count, no shares-outstanding history |
| Bitwise | Current snapshot only; the NAV chart held 3 points |

**The history does not exist anywhere and cannot be re-derived from the issuer
later.** This repo's data file *is* the series. That is why `update.py` appends
a snapshot per run rather than rebuilding, why the workflow runs twice a day,
and why a missed week is a permanent hole.

```
flow_t = (shares_outstanding_t − shares_outstanding_t−1) × NAV_t
NAV_t  = net_assets_t / shares_outstanding_t     (single as-of date)
```

Flow is measured off the **share count**, never the NEAR coin count: coins are
inflated by staking rewards and deflated by the sponsor fee, so coin deltas are
not a clean creation signal.

## The complex, as of 5 Oct 2026

**Trading — one fund.**

| Fund | Ticker | Venue | Listed | Fee | Stakes |
|---|---|---|---|---|---|
| Bitwise NEAR ETF | NRR | NYSE Arca | 29 Sep 2026 (seeded 28 Sep) | 0.75% | Yes — staking expenses take 33% of rewards |

At its 2 Oct 2026 disclosure: $53.4m net assets, 2,210,000 shares, NAV $24.1633,
11,535,015 NEAR, 98.2% staked, gross staking rate 4.89% / net 3.28%.

**Not trading.** *Grayscale Near Trust (GSNR)* — Reg-D trust on OTCQB, S-1 filed
20 Jan 2026 and amended 12 Jun 2026, with no 8-A12B, 424B3, EFFECT or CERT on
file, so it has not converted. ~$1.1m AUM, 401,800 shares, 1.4441 NEAR/share.
No US spot NEAR filing exists from 21Shares, Canary, Franklin or VanEck
(EDGAR full-text search). WisdomTree's CoinDesk 20 Fund and Cryptex BAGZ hold
NEAR only as a basket constituent.

Every run checks EDGAR for a Form 8-A12B on the pending trust — the filing that
means a listing is days away.

## The launch-week backfill, and how far to trust it

NRR listed before this tracker existed, so sessions 28 Sep – 1 Oct 2026 are
**reconstructed from on-chain custody balances**, flagged `estimated` in the data
and rendered as faded bars.

How: the fund page lists 51 NEAR custody addresses; 48 delegate to
`bitwise_2.poolv1.near`. Total holdings per day are read from an archival node at
the block nearest 16:00 ET as *pool staked + wallet liquid*, net of the ~18.2k
NEAR of Bitwise validator stake that pre-dated the fund. Coin deltas are priced
at the NEAR close and attributed back one trading session, because coins settle
T+1: at the 29 Sep close custody still held ~123k NEAR, and the ~7.1m NEAR
arrived the next day.

**It checks out.** The reconstruction puts first-day flow at **$35.26m** against
the **$35.5m** reported independently — a 0.7% gap from a wholly different
method. Reconstructed seed shares come to 20,009 against a 20,000-share (two
basket) seed, and reconstructed 1 Oct shares to 2,197,369 against Bitwise's
reported 2,210,000 on 2 Oct, a 0.6% gap.

**Known errors, largest first:** staking rewards inflate the coin count (~1,500
NEAR/day — visible as the weekend drift, and filtered out by discarding any
delta smaller than half a creation basket); the sponsor fee is paid in NEAR
monthly, so one day a month carries a lumpy negative that is not a redemption;
settlement timing can shift a creation a session either way; only addresses the
fund page lists *today* are queried, so an address retired since launch is
invisible; NEAR-per-share is held at today's ratio across the window.

Real issuer snapshots always overwrite an estimate for the same date, and the
share count hands off cleanly — the first real session after the estimates
prints $305k, not a double-counted $8m.

## Layout

```
index.html                      the dashboard
assets/styles.css               light + dark theme tokens
assets/app.js                   renderer: tiles, charts, tables, CSV (no dependencies)
scripts/funds.py                fund registry — add a fund here
scripts/update.py               daily snapshot + flow builder, writes data/near_flows.json
scripts/backfill_onchain.py     one-off archival-RPC reconstruction
data/near_flows.json            the series (committed, so the page is static)
data/near_backfill_onchain.json raw on-chain readings + derived estimates
.github/workflows/update.yml    twice-daily snapshot + commit
```

## Running it locally

```bash
pip install -r requirements.txt
python scripts/backfill_onchain.py   # once; raw readings are cached between runs
python scripts/update.py
python -m http.server 8000           # then open http://localhost:8000
```

## Deploying

1. Create a repo named `nearetftracker`, push these files to `main`.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Settings → Actions → General → Workflow permissions: **Read and write**.
4. Actions → *update flows* → **Run workflow** once, then it runs on schedule:
   22:00 UTC Mon–Fri and 10:00 UTC Tue–Sat.

Commit `data/near_flows.json` on every run and never rewrite history in it — it
is the only copy of the series that exists.

## Gotchas worth knowing before you touch the collector

- **Read `__NEXT_DATA__`, not `/_next/data/<buildId>/index.json`.** Both carry
  the same payload, but the buildId changes on every Bitwise redeploy.
- **Date skew will corrupt the flow if you ignore it.** `fundDetails` and
  `holdings` carry one as-of date; `navAndMarketPrice` and `premiumDiscount`
  often lag a day. Never multiply today's share count by the NAV chart's last
  point — derive NAV from `netAssets / sharesOutstanding`, which share one date.
- **`expenseRatio` returns 0** in the payload. It is an unpopulated field, not a
  waiver; the 0.75% in `funds.py` comes from the prospectus.
- **`bitwiseinvestments.com` has no NRR page** — `nrretf.com` is the fund page.
- **`data.sec.gov` 403s descriptive bot user agents** and accepts browser-like
  ones. Override with the `EDGAR_UA` env var if that flips.
- **Archival RPC:** `archival-rpc.mainnet.fastnear.com` is fast and reliable;
  `archival-rpc.mainnet.near.org` works but rate-limits a serial loop hard. The
  public `rpc.mainnet.near.org` cannot serve historical state at all.
- **CoinGecko's free tier throttles** with a 429 — the backfill retries and
  falls back to the daily `market_chart` endpoint.

## Reading the output

- **Flow excludes price and excludes staking rewards.** Cumulative flow above
  net assets is the NEAR drawdown plus fees, not a data error.
- **Creations are struck in 10,000-share baskets,** so zero-flow days are
  mechanical. Cadence beats any single-day record.
- **One fund is not an asset class.** A thin tape here is one issuer's book.
- **Watch the custody chart against reported holdings.** A persistent gap means
  the issuer page has gone stale — the two agreed to 0.4% at the last check.

## Adding a fund when one lists

Flip its `scripts/funds.py` entry to `"status": "live"`, give it an `adapter`,
and add a fetch function in `update.py` returning the same record shape. The
page is driven off `live_tickers`, so tiles, charts and the per-fund tooltip
breakdown all pick it up.

Sources: [Bitwise NRR fund page](https://nrretf.com/) ·
[NRR 424B3 prospectus](https://www.sec.gov/Archives/edgar/data/2067111/000121390026103106/ea0306486-424b3_bitwise.htm) ·
[Bitwise launch release](https://bitwiseinvestments.com/newsroom/the-bitwise-near-etf-nrr-launches-as-first-spot-near-etp-in-the-us) ·
[Grayscale Near Trust S-1](https://www.sec.gov/Archives/edgar/data/2025000/000119312526016785/gsnr-20260120.htm) ·
NEAR mainnet archival RPC · CoinGecko

Day-one and cumulative launch-week flow figures quoted above as "reported" come
from crypto-media relays of Blockbeats and a NEAR Protocol announcement — they
are secondary, which is exactly why the on-chain reconstruction is worth having.

Not investment advice. Verify against the issuer before citing.
