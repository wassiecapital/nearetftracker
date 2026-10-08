"""Fund registry for the US spot NEAR Protocol ETF complex.

Multi-issuer by design. Today exactly one fund trades (Bitwise NRR); Grayscale's
trust conversion is registered with status != "live" so the dashboard shows the
pipeline and adding it on listing day is a one-line change plus an adapter.

Verified 5 Oct 2026 — see README for sources.
"""

FUNDS = [
    {
        "ticker": "NRR",
        "issuer": "Bitwise",
        "name": "Bitwise NEAR ETF",
        "exchange": "NYSE Arca",
        "status": "live",
        "adapter": "bitwise_nextdata",
        "fee": 0.0075,           # unitary sponsor fee, accrued daily, paid in NEAR monthly
        "stakes": True,
        "staking_expense": 0.33,  # 33% of staking rewards to agents/custodian/sponsor
        "seed_date": "2026-09-28",
        "first_trade": "2026-09-29",
        "cik": "2067111",
        "cusip": "091952101",
        "basket_shares": 10000,
        "source": "https://nrretf.com/",
        "staking_pool": "bitwise_2.poolv1.near",
    },
    {
        "ticker": "GSNR",
        "issuer": "Grayscale",
        "name": "Grayscale Near Trust (ETF conversion pending)",
        "exchange": "OTCQB (NYSE Arca proposed)",
        "status": "pending_19b4",
        "adapter": None,
        "fee": 0.025,            # current trust fee; post-conversion fee not announced
        "stakes": False,
        "cik": "2025000",
        "note": (
            "Reg-D trust quoted on OTCQB. S-1 filed 20 Jan 2026, S-1/A 12 Jun 2026; "
            "no 8-A12B, 424B3, EFFECT or CERT on file, so it has not converted. "
            "~$1.1m AUM, 401,800 shares, 1.4441 NEAR/share at last disclosure."
        ),
    },
]

# Not single-asset NEAR, listed so they are never miscounted:
#   WisdomTree CoinDesk 20 Fund (CIK 2092551), Cryptex Digital Market Cap ETF / BAGZ
#   (CIK 2115027) — NEAR is a basket constituent only.
# No US spot NEAR filing exists from 21Shares, Canary, Franklin or VanEck.

LIVE = [f for f in FUNDS if f["status"] == "live"]
WATCH_CIKS = {f["cik"]: f["ticker"] for f in FUNDS if f.get("cik") and f["status"] != "live"}
