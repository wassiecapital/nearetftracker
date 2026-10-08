#!/usr/bin/env python3
"""Reconstruct NRR's pre-collection daily flows from on-chain custody balances.

Run this ONCE (or whenever you want to extend the estimated window backwards).
It writes data/near_backfill_onchain.json, which update.py merges in as the
*lowest-priority* source: any day a real issuer snapshot exists for overwrites
the estimate.

Why this exists
---------------
Bitwise publishes only a current snapshot. No aggregator carries NEAR ETF flows.
So for every day between the fund's 29 Sep 2026 launch and the day this tracker
started collecting, the issuer-reported share count is simply gone. The custody
wallets are not: the fund page lists its NEAR addresses, and 48 of them delegate
to bitwise_2.poolv1.near. Historical state is readable from an archival node, so
the coin balance per day is recoverable even though the share count is not.

    total_near_t = pool_staked_t + sum(liquid balances of the custody wallets)_t
    flow_t       ~ (total_near_t - total_near_t-1) * NEAR_close_t

Known errors in this estimate, in rough order of size
-----------------------------------------------------
1. Staking rewards inflate the coin count (~4.9% gross annualised => roughly
   +1,500 NEAR/day on an 11.5m position, ~$7k/day at $5). Small against
   multi-million-dollar creation days, material on a quiet day.
2. The 0.75% sponsor fee is paid in NEAR monthly in arrears, so one day a month
   carries a lumpy negative that is not a redemption.
3. Settlement lag: coins can land a day either side of the share count changing,
   so a creation can be attributed to the wrong session.
4. Wallet-set drift: only addresses the fund page lists *today* are queried. An
   address used during launch week and since retired is invisible here.
5. The block sampled is the one nearest 20:00 UTC (16:00 ET), not the official
   NAV strike.

Treat the output as the shape of launch-week demand, not as a flow print.
Anything load-bearing should cite the issuer snapshots instead.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import pathlib
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from funds import LIVE  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "near_backfill_onchain.json"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
ARCHIVAL = ["https://archival-rpc.mainnet.fastnear.com",
            "https://archival-rpc.mainnet.near.org"]
RPC = "https://rpc.mainnet.near.org"
START = dt.date(2026, 9, 26)   # two sessions before first trade, to anchor the seed
WORKERS = 6                    # parallel wallet reads per day
SETTLEMENT_LAG = 1             # sessions the coin movement trails the share print
STRIKE_UTC_HOUR = 20           # 16:00 ET

S = requests.Session()
S.headers["User-Agent"] = UA


def rpc(method, params, urls=None, tries=4):
    for url in (urls or ARCHIVAL):
        for i in range(tries):
            try:
                r = S.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method,
                                      "params": params}, timeout=45)
                if r.status_code == 200:
                    j = r.json()
                    if "result" in j:
                        return j["result"]
                    name = json.dumps(j.get("error", {}))
                    if "UNKNOWN_ACCOUNT" in name:
                        return "NO_ACCOUNT"
                    if "UNKNOWN_BLOCK" in name:
                        return "NO_BLOCK"
                elif r.status_code == 422:
                    return "NO_BLOCK"
            except Exception:
                pass
            time.sleep(0.6 * (i + 1))
    return None


def block(h):
    r = rpc("block", {"block_id": h})
    if not isinstance(r, dict):
        return None
    return r["header"]["height"], r["header"]["timestamp"] / 1e9


def height_at(target, tip, rate):
    """Walk to the block nearest `target` (a unix timestamp). 3-4 probes."""
    h = int(tip[0] - (tip[1] - target) / rate)
    best = None
    for _ in range(7):
        b = block(h)
        if b is None:
            h -= 3
            continue
        if best is None or abs(b[1] - target) < abs(best[1] - target):
            best = b
        err = b[1] - target
        if abs(err) <= 20:
            return b
        step = int(err / rate)
        h = b[0] - (step if step else (1 if err > 0 else -1))
    return best


def view_function(account, method, args, block_id):
    p = {"request_type": "call_function", "account_id": account, "method_name": method,
         "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
         "block_id": block_id}
    r = rpc("query", p)
    if not isinstance(r, dict):
        return None
    return json.loads(bytes(r["result"]).decode())


def view_balance(account, block_id):
    r = rpc("query", {"request_type": "view_account", "account_id": account,
                      "block_id": block_id})
    if r == "NO_ACCOUNT":
        return 0.0
    if not isinstance(r, dict):
        return None
    return int(r["amount"]) / 1e24


def fetch_fund_page(url):
    r = S.get(url, timeout=90)
    r.raise_for_status()
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
    return json.loads(m.group(1))["props"]["pageProps"]["fundData"]["data"]


def near_daily_closes(start: dt.date, end: dt.date) -> dict:
    """CoinGecko daily USD closes, keyed by ISO date."""
    frm = int(dt.datetime.combine(start - dt.timedelta(days=2), dt.time(0),
                                 tzinfo=dt.timezone.utc).timestamp())
    to = int(dt.datetime.combine(end + dt.timedelta(days=1), dt.time(0),
                                tzinfo=dt.timezone.utc).timestamp())
    days = (end - start).days + 4
    urls = [("https://api.coingecko.com/api/v3/coins/near/market_chart/range"
             f"?vs_currency=usd&from={frm}&to={to}"),
            ("https://api.coingecko.com/api/v3/coins/near/market_chart"
             f"?vs_currency=usd&days={days}&interval=daily")]
    prices = []
    for url in urls:
        for attempt in range(5):          # CoinGecko's free tier throttles with a 429
            try:
                r = S.get(url, timeout=60)
                if r.status_code == 200:
                    prices = r.json().get("prices", [])
                    break
                time.sleep(3 * (attempt + 1))
            except Exception as e:
                print("  coingecko error:", e)
                time.sleep(3 * (attempt + 1))
        if prices:
            break
    if not prices:
        print("  coingecko unavailable — no USD prices, flows cannot be derived")
        return {}

    # Keep, per date, the observation closest to the 20:00 UTC strike.
    best: dict = {}
    for ms, px in prices:
        d = dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc)
        key = d.date().isoformat()
        strike = d.replace(hour=STRIKE_UTC_HOUR, minute=0, second=0, microsecond=0)
        gap = abs((d - strike).total_seconds())
        if key not in best or gap < best[key][0]:
            best[key] = (gap, px)
    return {k: v[1] for k, v in best.items()}


def main() -> int:
    fund = next(f for f in LIVE if f.get("staking_pool"))
    data = fetch_fund_page(fund["source"])
    wallets = [w["address"] for w in data["wallets"]["walletBalances"]]
    coins_now = data["holdings"]["basket"][0]["shares"]
    shares_now = data["fundDetails"]["sharesOutstanding"]
    near_per_share = coins_now / shares_now
    print(f"{len(wallets)} custody wallets; {near_per_share:.6f} NEAR/share "
          f"as of {data['fundDetails']['asOfDate']}")

    tipr = rpc("block", {"finality": "final"}, urls=[RPC])
    tip = (tipr["header"]["height"], tipr["header"]["timestamp"] / 1e9)
    anchor = block(tip[0] - 1_000_000)
    rate = (tip[1] - anchor[1]) / (tip[0] - anchor[0])
    print(f"tip {tip[0]}, mean block time {rate:.4f}s")

    today = dt.datetime.now(dt.timezone.utc).date()
    days = []
    d = START
    while d < today:
        days.append(d)
        d += dt.timedelta(days=1)
    prices = near_daily_closes(START, today)

    cache = {}
    if OUT.exists():
        try:
            for r in json.loads(OUT.read_text()).get("raw", []):
                if r.get("staked_near") is not None and not r.get("wallets_unreadable"):
                    cache[r["date"]] = r
        except Exception:
            pass

    rows = []
    for d in days:
        if d.isoformat() in cache:
            rows.append(cache[d.isoformat()])
            print(f"{d} cached")
            continue
        target = dt.datetime(d.year, d.month, d.day, STRIKE_UTC_HOUR,
                             tzinfo=dt.timezone.utc).timestamp()
        b = height_at(target, tip, rate)
        if b is None:
            print(d, "no block — skipped")
            continue
        staked = view_function(fund["staking_pool"], "get_total_staked_balance", {}, b[0])
        staked = int(staked) / 1e24 if staked else None
        with ThreadPoolExecutor(WORKERS) as ex:
            vals = list(ex.map(lambda a: view_balance(a, b[0]), wallets))
        missing = sum(1 for v in vals if v is None)
        liquid = sum(v for v in vals if v is not None)
        total = (staked or 0) + liquid
        px = prices.get(d.isoformat())
        rows.append({
            "date": d.isoformat(),
            "block": b[0],
            "block_utc": dt.datetime.fromtimestamp(b[1], dt.timezone.utc).isoformat(timespec="seconds"),
            "staked_near": round(staked, 6) if staked is not None else None,
            "liquid_near": round(liquid, 6),
            "total_near": round(total, 6),
            "wallets_unreadable": missing,
            "near_usd": px,
        })
        print(f"{d} blk {b[0]} staked {staked:,.0f} liquid {liquid:,.0f} "
              f"total {total:,.0f} NEAR @ ${px}" if staked is not None
              else f"{d} blk {b[0]} INCOMPLETE")

    # ---- turn the coin series into an estimated share/flow series --------------
    #
    # Coins trail the share print. NRR's first trading session was 29 Sep 2026;
    # on-chain custody still held ~123k NEAR at that session's close and only
    # jumped to ~7.2m the next day — i.e. the creation settled T+1. Checked
    # against the reported day-one print (~$35.5m), the T+1 delta reproduces it
    # to within the price convention used, so each coin delta is attributed back
    # SETTLEMENT_LAG trading sessions. Set SETTLEMENT_LAG = 0 to switch the
    # attribution off and date flows by the day the coins actually moved.
    def prev_session(d: dt.date, n: int) -> dt.date:
        for _ in range(n):
            d -= dt.timedelta(days=1)
            while d.weekday() >= 5:          # Sat/Sun -> previous Friday
                d -= dt.timedelta(days=1)
        return d

    # Cached raw rows may carry a null price from a run when CoinGecko was
    # throttled — always re-apply today's price lookup.
    for r in rows:
        px = prices.get(r["date"])
        if px:
            r["near_usd"] = px

    # The staking pool pre-dates the fund: it held ~18k NEAR before NRR's first
    # trade, which is Bitwise's own validator stake, not fund assets. Subtract the
    # last pre-launch reading as a constant baseline.
    first_trade = dt.date.fromisoformat(fund["first_trade"])
    pre = [r for r in rows if r.get("total_near") is not None
           and dt.date.fromisoformat(r["date"]) < first_trade]
    baseline = min((r["total_near"] for r in pre), default=0.0)
    print(f"pre-launch baseline subtracted: {baseline:,.0f} NEAR")

    usable = [dict(r, fund_near=max(r["total_near"] - baseline, 0.0))
              for r in rows if r.get("total_near") and r.get("near_usd")
              and dt.date.fromisoformat(r["date"]) >= first_trade]

    # A creation basket is 10,000 shares. Anything smaller than half a basket of
    # coins cannot be a creation — it is staking reward accrual (weekend deltas
    # run ~1,500 NEAR/day) or the monthly in-kind fee. Zero those out rather than
    # printing them as flow.
    basket_near = (fund.get("basket_shares") or 10_000) * near_per_share
    noise_floor = basket_near / 2

    by_date: dict = {}
    for i, r in enumerate(usable):
        obs = dt.date.fromisoformat(r["date"])
        session = obs if SETTLEMENT_LAG == 0 else prev_session(obs, SETTLEMENT_LAG)
        # Price the flow on the session it is attributed to, not the day the
        # coins moved — that is what reproduces the reported day-one print.
        px = prices.get(session.isoformat()) or r["near_usd"]
        delta = r["fund_near"] - usable[i - 1]["fund_near"] if i else r["fund_near"]
        if i and abs(delta) < noise_floor:
            delta = 0.0
        rec = by_date.setdefault(session.isoformat(), {
            "date": session.isoformat(),
            "estimated": True,
            "basis": ("on-chain custody balances x NEAR close, net of the pre-launch "
                      f"validator stake, attributed back {SETTLEMENT_LAG} session(s) for "
                      "settlement; sub-basket deltas treated as staking accrual. "
                      "See backfill_onchain.py"),
            "flow": 0.0,
        })
        rec["flow"] = round(rec["flow"] + delta * px, 2)
        # State fields describe the coin snapshot that produced the flow, so the
        # share count hands off cleanly to the first real issuer snapshot.
        rec.update({
            "shares": round(r["fund_near"] / near_per_share, 0),
            "nav": round(near_per_share * px, 6),
            "net_assets": round(r["fund_near"] * px, 2),
            "coins": round(r["fund_near"], 6),
            "near_usd": px,
            "coins_observed": r["date"],
        })
        if i == 0:
            rec["seed"] = True

    recs = [by_date[d] for d in sorted(by_date)]
    if not recs:
        print("no launch-week balance found on-chain — nothing to backfill")

    payload = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "near_per_share_assumed": near_per_share,
        "pre_launch_baseline_near": baseline,
        "noise_floor_near": noise_floor,
        "settlement_lag_sessions": SETTLEMENT_LAG,
        "method": ("total NEAR = pool staked + custody wallet liquid balances, read at the "
                   "block nearest 20:00 UTC; flow = change in total NEAR x NEAR close, "
                   f"attributed back {SETTLEMENT_LAG} trading session(s)"),
        "warning": ("ESTIMATE. Contaminated by staking rewards, the monthly in-kind sponsor "
                    "fee, settlement timing and wallet-set drift. Superseded by any real "
                    "issuer snapshot for the same date."),
        "raw": rows,
        "by_fund": {fund["ticker"]: recs},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=1))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(recs)} estimated sessions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
