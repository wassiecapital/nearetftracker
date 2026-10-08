#!/usr/bin/env python3
"""Append today's snapshot to data/near_flows.json — US spot NEAR ETF daily flows.

Why this is append-only (and the LTC tracker is not)
----------------------------------------------------
Nobody publishes a NEAR ETF flow series. Farside covers BTC/ETH/SOL/HYP/ZEC only;
SoSoValue's `us-near-spot` returns zero rows; CoinGlass has no NEAR endpoint;
stockanalysis.com carries no shares-outstanding history. Bitwise itself publishes
only a *current* snapshot plus a NAV chart that holds a handful of points.

So the history does not exist anywhere and cannot be re-derived later from the
issuer. This script snapshots the primary source every business day and
accumulates the series itself. Days missed are gone — which is why the workflow
runs on a schedule and why pre-collection days come from the on-chain
reconstruction in backfill_onchain.py, flagged estimated.

    flow_t = (shares_outstanding_t - shares_outstanding_t-1) * NAV_t
    NAV    = net_assets / shares_outstanding   (same as-of date, see below)

Date-skew trap: fundDetails/holdings carry one as-of date and
navAndMarketPrice/premiumDiscount often lag it by a day. Never multiply today's
share count by the NAV chart's last point. NAV is always recomputed from
net_assets / shares_outstanding, which share one as-of date.

Flow is measured off share count, not off the NEAR coin count: the coin count is
inflated by staking rewards and deflated by the sponsor fee, so it is not a clean
creation signal.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import pathlib
import re
import sys

import requests

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from funds import FUNDS, LIVE, WATCH_CIKS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "near_flows.json"
BACKFILL = ROOT / "data" / "near_backfill_onchain.json"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
EDGAR_UA = os.environ.get("EDGAR_UA", "Mozilla/5.0")
RPC = "https://rpc.mainnet.near.org"


def fetch_bitwise(url: str = "https://nrretf.com/") -> dict:
    """Read the fund page's __NEXT_DATA__ payload.

    Prefer this over /_next/data/<buildId>/index.json: the buildId changes on
    every Bitwise redeploy, the embedded script does not.
    """
    r = requests.get(url, headers={"User-Agent": UA}, timeout=90)
    r.raise_for_status()
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
    if not m:
        raise RuntimeError("__NEXT_DATA__ not found — Bitwise changed the page shell")
    return json.loads(m.group(1))["props"]["pageProps"]["fundData"]["data"]


def onchain_staked(pool: str) -> "float | None":
    """Pool-level staked NEAR — an independent cross-check on reported holdings."""
    try:
        p = {"request_type": "call_function", "account_id": pool,
             "method_name": "get_total_staked_balance",
             "args_base64": base64.b64encode(b"{}").decode(), "finality": "final"}
        r = requests.post(RPC, json={"jsonrpc": "2.0", "id": 1, "method": "query",
                                     "params": p}, timeout=60).json()
        return int(json.loads(bytes(r["result"]["result"]).decode())) / 1e24
    except Exception:
        return None


def snapshot(fund: dict) -> dict:
    d = fetch_bitwise(fund["source"])
    fd = d["fundDetails"]
    shares = fd.get("sharesOutstanding")
    na = fd.get("netAssets")
    if not shares or not na:
        raise RuntimeError("missing netAssets/sharesOutstanding")
    holdings = (d.get("holdings") or {}).get("basket") or [{}]
    nav_blk = d.get("navAndMarketPrice") or {}
    pd_blk = d.get("premiumDiscount") or {}
    wallets = (d.get("wallets") or {}).get("walletBalances") or []
    st = fd.get("stakingMetrics") or {}
    return {
        "date": fd["asOfDate"],
        "shares": shares,
        "net_assets": round(na, 2),
        "nav": round(na / shares, 6),
        "coins": holdings[0].get("shares"),
        "coins_as_of": (d.get("holdings") or {}).get("asOfDate"),
        "market_price": nav_blk.get("marketPrice"),
        "price_as_of": nav_blk.get("asOfDate") or pd_blk.get("asOfDate"),
        "premium_discount": pd_blk.get("marketPrice"),
        "staked_pct": st.get("currentPercentageOfAssetsStaked"),
        "staking_gross": st.get("grossStakingRewardRate"),
        "staking_net": st.get("netStakingRewardRate"),
        "wallet_count": len(wallets),
        "wallet_near": round(sum(w.get("balance", 0) for w in wallets), 4) or None,
        "onchain_pool_staked": onchain_staked(fund["staking_pool"]) if fund.get("staking_pool") else None,
        "estimated": False,
        "captured_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }


def check_edgar_listings() -> list:
    out = []
    for cik, ticker in WATCH_CIKS.items():
        try:
            j = requests.get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json",
                             headers={"User-Agent": EDGAR_UA}, timeout=60).json()
        except Exception as e:
            out.append({"ticker": ticker, "error": str(e)[:200]})
            continue
        rec = j.get("filings", {}).get("recent", {})
        forms, dates = rec.get("form", []), rec.get("filingDate", [])
        listed = any(f in ("8-A12B", "8-A12G") for f in forms)
        out.append({
            "ticker": ticker, "cik": cik, "exchanges": j.get("exchanges", []),
            "has_8a": listed,
            "latest_form": forms[0] if forms else None,
            "latest_form_date": dates[0] if dates else None,
            "action": "LISTING IMMINENT — add an adapter" if listed else "no 8-A yet",
        })
    return out


def main() -> int:
    existing = json.loads(OUT.read_text()) if OUT.exists() else {}
    # fund -> {date: record}
    hist: dict = {}
    for row in existing.get("series", []):
        for tk, rec in row.get("by_fund", {}).items():
            hist.setdefault(tk, {})[rec["date"]] = rec

    # Seed estimated pre-collection days once; real snapshots always win.
    if BACKFILL.exists():
        bf = json.loads(BACKFILL.read_text())
        for tk, recs in bf.get("by_fund", {}).items():
            for rec in recs:
                cur = hist.setdefault(tk, {}).get(rec["date"])
                if cur is None or cur.get("estimated"):
                    hist[tk][rec["date"]] = rec

    for f in LIVE:
        if f["adapter"] != "bitwise_nextdata":
            continue
        snap = snapshot(f)
        hist.setdefault(f["ticker"], {})[snap["date"]] = snap  # overwrite any estimate
        print(f"{f['ticker']} as-of {snap['date']}: shares {snap['shares']:,.0f} "
              f"NAV {snap['nav']:.4f} net assets ${snap['net_assets']:,.0f}")

    # Recompute flows per fund over the merged series.
    for tk, byday in hist.items():
        days = sorted(byday)
        prev = None
        for i, d in enumerate(days):
            rec = byday[d]
            if rec.get("estimated") and rec.get("flow") is not None:
                # Keep the reconstruction's own figure. It filters sub-basket coin
                # deltas as staking accrual and prices each flow on the session it
                # is attributed to; recomputing from estimated share counts here
                # would reintroduce that noise as spurious tiny redemptions.
                pass
            elif prev is None:
                rec["flow"] = round(rec["net_assets"], 2)
                rec["seed"] = True
            else:
                rec["flow"] = round((rec["shares"] - prev["shares"]) * rec["nav"], 2)
                rec.pop("seed", None)
            prev = rec

    # ---- on-chain custody series -------------------------------------------
    # Seeded by backfill_onchain.py (archival RPC, per day), then extended one row
    # per run from the fund page's own wallet list plus a live pool read. Keyed by
    # date so re-runs overwrite rather than duplicate.
    onchain = {}
    for prev in existing.get("onchain", []):
        onchain[prev["date"]] = prev
    if BACKFILL.exists():
        for r in json.loads(BACKFILL.read_text()).get("raw", []):
            if r.get("total_near"):
                onchain.setdefault(r["date"], {
                    "date": r["date"], "staked_near": r.get("staked_near"),
                    "liquid_near": r.get("liquid_near"), "total_near": r.get("total_near"),
                    "near_usd": r.get("near_usd"), "source": "archival-rpc",
                })
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    for f in LIVE:
        if not f.get("staking_pool"):
            continue
        d = fetch_bitwise(f["source"])
        total = sum(w.get("balance", 0) for w in (d.get("wallets") or {}).get("walletBalances") or [])
        staked = onchain_staked(f["staking_pool"])
        if total:
            onchain[today] = {
                "date": today, "staked_near": round(staked, 6) if staked else None,
                "liquid_near": round(total - staked, 6) if staked else None,
                "total_near": round(total, 6),
                "near_usd": None, "source": "fund page + live pool read",
            }

    # Trim the pre-launch tail: the pool held Bitwise's own validator stake
    # before the fund existed, which is not custody of fund assets.
    cutoff = min((f["first_trade"] for f in LIVE if f.get("first_trade")), default=None)
    if cutoff:
        prior = dt.date.fromisoformat(cutoff) - dt.timedelta(days=1)
        onchain = {d: v for d, v in onchain.items() if d >= prior.isoformat()}

    dates = sorted({d for byday in hist.values() for d in byday})
    series, cum = [], 0.0
    for d in dates:
        row = {"date": d, "by_fund": {}, "flow": 0.0, "net_assets": 0.0, "estimated": False}
        for tk, byday in hist.items():
            rec = byday.get(d)
            if not rec:
                continue
            row["by_fund"][tk] = rec
            row["flow"] += rec.get("flow", 0.0)
            row["net_assets"] += rec.get("net_assets", 0.0)
            row["estimated"] = row["estimated"] or bool(rec.get("estimated"))
        cum += row["flow"]
        row.update(flow=round(row["flow"], 2), net_assets=round(row["net_assets"], 2),
                   cum_flow=round(cum, 2))
        series.append(row)

    payload = {
        "asset": "NEAR",
        "asset_name": "NEAR Protocol",
        "updated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "method": ("flow = change in shares outstanding x NAV, per fund, per trading day; "
                   "NAV recomputed as net assets / shares outstanding on a single as-of date"),
        "funds": FUNDS,
        "live_tickers": sorted(t for t, v in hist.items() if v),
        "coins_total": ({"amount": round(sum(
                             (byday[max(byday)] or {}).get("coins") or 0 for byday in hist.values()), 4),
                         "unit": "NEAR",
                         "as_of": max((max(b) for b in hist.values() if b), default=None)}
                        if hist else None),
        "series": series,
        "onchain": [onchain[d] for d in sorted(onchain)],
        "listing_watch": check_edgar_listings(),
        "caveats": [
            "Rows marked estimated are reconstructed from on-chain custody balances, "
            "not from issuer-reported share counts. Treat them as indicative.",
            "No third party publishes a NEAR ETF flow series — this file IS the series. "
            "A day not captured cannot be recovered from the issuer.",
            "Flow excludes price movement and excludes staking rewards.",
            "Creations are struck in 10,000-share baskets, so zero-flow days are "
            "mechanical, not a demand signal.",
            "Bitwise's own numbers lag by one to two business days; the as-of date on "
            "each row is the issuer's, not the capture date.",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=1))
    last = series[-1]
    print(f"wrote {OUT.relative_to(ROOT)}: {len(series)} sessions through {last['date']}, "
          f"last flow ${last['flow']:,.0f}, cumulative ${last['cum_flow']:,.0f}")
    for h in payload["listing_watch"]:
        print("  watch:", h)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
