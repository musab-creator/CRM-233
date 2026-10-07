"""pump.fun token state read from the chain through Helius (free plan).

Why: since May 1, 2026 PumpPortal streams per-token trades only to a funded API key, at
0.01 SOL per 10,000 trades. Following every launch would cost about 1 SOL a day. The facts the
pre-filter needs are on chain:

* The bonding-curve account holds the curve's reserves (layout from pump-fun/pump-public-docs):
      8  discriminator = sha256("account:BondingCurve")[:8]
      8  virtual_token_reserves  u64   raw units, 6 decimals
      8  virtual_sol_reserves    u64   lamports
      8  real_token_reserves     u64
      8  real_sol_reserves       u64
      8  token_total_supply      u64
      1  complete                bool  set when the last real token is bought (graduation)
     32  creator                 Pubkey (newer accounts only)
  `real_sol_reserves` starts at 0. Every buy and sell moves it by exactly the SOL of the trade,
  and fees go to other accounts, so it equals the net SOL inflow. Price is virtual SOL divided
  by virtual tokens. One getMultipleAccounts call reads 100 curves for 1 credit.
* DAS getTokenAccounts lists a mint's token accounts (10 credits per 1,000): the wallets that
  bought it and what they hold now.
* The first trades (snipers, bundles, the dev's buy) are rebuilt from the curve's earliest
  transactions by SOL and token balance deltas. That does not depend on pump.fun's event
  layout, which has changed before.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import struct
from dataclasses import dataclass

from solders.pubkey import Pubkey

log = logging.getLogger("bot.pumpchain")

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
CURVE_DISCRIMINATOR = hashlib.sha256(b"account:BondingCurve").digest()[:8]
TOKEN_DECIMALS = 6
LAMPORTS = 1_000_000_000
SUPPLY = 1_000_000_000.0                 # UI units
INITIAL_VIRTUAL_SOL = 30.0
INITIAL_VIRTUAL_TOKENS = 1_073_000_000.0
LAUNCH_PRICE_SOL = INITIAL_VIRTUAL_SOL / INITIAL_VIRTUAL_TOKENS


@dataclass(frozen=True)
class Curve:
    v_tokens: float      # UI units
    v_sol: float         # SOL
    real_tokens: float
    real_sol: float      # = net SOL inflow
    supply: float
    complete: bool
    creator: str | None = None

    @property
    def price_sol(self) -> float | None:
        return self.v_sol / self.v_tokens if self.v_tokens > 0 else None


def decode_curve(data: bytes | None) -> Curve | None:
    """Bonding-curve account bytes -> Curve, or None if it is not a bonding-curve account."""
    if not data or len(data) < 49 or data[:8] != CURVE_DISCRIMINATOR:
        return None
    vt, vs, rt, rs, sup = struct.unpack_from("<5Q", data, 8)
    creator = str(Pubkey.from_bytes(data[49:81])) if len(data) >= 81 else None
    scale = 10 ** TOKEN_DECIMALS
    return Curve(vt / scale, vs / LAMPORTS, rt / scale, rs / LAMPORTS, sup / scale, data[48] != 0, creator)


def encode_curve(c: Curve) -> bytes:
    """Inverse of decode_curve (tests and the simulator)."""
    scale = 10 ** TOKEN_DECIMALS
    out = CURVE_DISCRIMINATOR + struct.pack("<5Q", round(c.v_tokens * scale), round(c.v_sol * LAMPORTS),
                                            round(c.real_tokens * scale), round(c.real_sol * LAMPORTS),
                                            round(c.supply * scale)) + bytes([int(c.complete)])
    return out + (bytes(Pubkey.from_string(c.creator)) if c.creator else b"")


def _account_keys(tx: dict) -> list[str]:
    """Static keys then address-table keys (writable, readonly): the order balances use."""
    msg = (tx.get("transaction") or {}).get("message") or {}
    keys = [k if isinstance(k, str) else (k or {}).get("pubkey") for k in msg.get("accountKeys") or []]
    loaded = (tx.get("meta") or {}).get("loadedAddresses") or {}
    return keys + list(loaded.get("writable") or []) + list(loaded.get("readonly") or [])


def trades_from_tx(tx: dict, mint: str, curve_key: str) -> list[dict]:
    """Curve trades in one getTransaction result, from balance deltas.

    SOL into the curve means buys and SOL out means sells. Each wallet whose token balance
    moved the matching way is a trader, and the SOL is split between them by tokens.
    Transfers, migrations and failed transactions give [].
    """
    meta = tx.get("meta") or {}
    if meta.get("err") is not None:
        return []
    keys = _account_keys(tx)
    if curve_key not in keys:
        return []
    i = keys.index(curve_key)
    pre, post = meta.get("preBalances") or [], meta.get("postBalances") or []
    if i >= len(pre) or i >= len(post):
        return []
    sol_delta = (post[i] - pre[i]) / LAMPORTS
    raw: dict[str, int] = {}
    for sign, rows in ((-1, meta.get("preTokenBalances") or []), (1, meta.get("postTokenBalances") or [])):
        for b in rows:
            owner = b.get("owner")
            if b.get("mint") != mint or not owner or owner == curve_key:
                continue
            raw[owner] = raw.get(owner, 0) + sign * int((b.get("uiTokenAmount") or {}).get("amount") or 0)
    if abs(sol_delta) < 1e-12:
        return []
    side = "buy" if sol_delta > 0 else "sell"
    group = {o: abs(d) / 10 ** TOKEN_DECIMALS for o, d in raw.items() if (d > 0) == (side == "buy") and d != 0}
    total = sum(group.values())
    if not group or total <= 0:
        return []
    sig = ((tx.get("transaction") or {}).get("signatures") or [None])[0]
    ts = tx.get("blockTime")
    return [{"signature": sig, "slot": tx.get("slot"), "ts": float(ts) if ts else None, "side": side,
             "trader": o, "tokens": tok, "sol": abs(sol_delta) * tok / total, "price_sol": abs(sol_delta) / total}
            for o, tok in group.items()]


def holder_snapshot(rows: list[dict], curve_key: str | None, creator: str | None, complete: bool = True) -> dict:
    """DAS token accounts -> per-owner balances, excluding the curve's own token account.

    `wallets_ex_dev` counts every wallet with a token account, including emptied ones that
    were not closed. It is a lower bound on distinct buyers, because a wallet that sold
    everything and closed its account is gone.
    """
    by_owner: dict[str, float] = {}
    for r in rows:
        owner = r.get("owner")
        if not owner or owner == curve_key:
            continue
        by_owner[owner] = by_owner.get(owner, 0.0) + int(r.get("amount") or 0) / 10 ** TOKEN_DECIMALS
    others = [o for o in by_owner if o != creator]
    return {"wallets_ex_dev": len(others),
            "holders_ex_dev": sum(1 for o in others if by_owner[o] > 0),
            "creator_tokens": by_owner.get(creator, 0.0) if creator else None,
            "by_owner": by_owner, "complete": complete}


class HeliusChain:
    """The on-chain reads above, through a `Helius` client (which meters credits)."""

    def __init__(self, helius):
        self.h = helius
        self._das_options = True

    @property
    def enabled(self) -> bool:
        return bool(self.h.key)

    async def curves(self, keys: list[str]) -> dict[str, Curve | None]:
        out: dict[str, Curve | None] = {}
        for i in range(0, len(keys), 100):
            chunk = keys[i:i + 100]
            res = await self.h.rpc("getMultipleAccounts", [chunk, {"encoding": "base64", "commitment": "confirmed"}])
            for k, acc in zip(chunk, (res or {}).get("value") or []):
                data = (acc or {}).get("data")
                out[k] = decode_curve(base64.b64decode(data[0])) if isinstance(data, list) and data else None
        return out

    async def _token_accounts_page(self, mint: str, page: int) -> list[dict]:
        params: dict = {"mint": mint, "limit": 1000, "page": page}
        if self._das_options:
            try:
                res = await self.h.das("getTokenAccounts", {**params, "options": {"showZeroBalance": True}})
                return (res or {}).get("token_accounts") or []
            except Exception as e:
                # A transient timeout/rate limit does not establish that the provider lacks
                # this capability. Fall back only when its response explicitly rejects it.
                error = str(e).lower()
                names_option = "showzerobalance" in error or "options" in error
                rejects_option = any(word in error for word in (
                    "invalid params", "unsupported", "not supported", "unknown", "unrecognized",
                    "unexpected", "not allowed"))
                if not (names_option and rejects_option):
                    raise
                log.warning("getTokenAccounts with showZeroBalance failed (%s); retrying without", e)
                self._das_options = False
        res = await self.h.das("getTokenAccounts", params)
        return (res or {}).get("token_accounts") or []

    async def holders(self, mint: str, curve_key: str | None, creator: str | None, max_pages: int = 3) -> dict:
        rows: list[dict] = []
        complete = False
        for page in range(1, max_pages + 1):
            got = await self._token_accounts_page(mint, page)
            rows.extend(got)
            if len(got) < 1000:
                complete = True
                break
        return holder_snapshot(rows, curve_key, creator, complete)

    async def early_trades(self, mint: str, curve_key: str, window_s: float = 60.0, max_tx: int = 80,
                           max_pages: int = 10) -> dict:
        """Trades in the first `window_s` seconds after launch (at most `max_tx` transactions).

        Signatures come newest first, 1,000 per call (1 credit). Paging back to the launch stops
        after `max_pages`; `reached_launch` says whether it got there.
        """
        sigs: list[dict] = []
        before = None
        reached = False
        for _ in range(max_pages):
            opts: dict = {"limit": 1000, "commitment": "confirmed"}
            if before:
                opts["before"] = before
            page = await self.h.rpc("getSignaturesForAddress", [curve_key, opts]) or []
            sigs.extend(page)
            if len(page) < 1000:
                reached = True
                break
            before = page[-1]["signature"]
        # The RPC lists signatures newest first, inside a slot too. Reverse them before the stable
        # sort by slot so same-slot transactions keep block order: the create transaction first,
        # then the snipers bundled with it. Sorting by slot alone left the launch transaction
        # last in its slot, and a busy launch slot pushed it past `max_tx`.
        ok = [x for x in reversed(sigs) if not x.get("err")]
        ok.sort(key=lambda x: x.get("slot") or 0)
        if not ok:
            return {"trades": [], "reached_launch": reached, "transactions": 0}
        t0 = ok[0].get("blockTime") or 0
        pick = [x for x in ok if (x.get("blockTime") or t0) - t0 <= window_s][:max_tx] if reached else []
        txs = await asyncio.gather(*[self.h.rpc("getTransaction", [x["signature"], {
            "encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"}]) for x in pick],
            return_exceptions=True)
        trades: list[dict] = []
        for seq, tx in enumerate(txs):  # seq: block order, the tiebreaker inside a slot
            if isinstance(tx, dict):
                for t in trades_from_tx(tx, mint, curve_key):
                    t["seq"] = seq
                    trades.append(t)
        trades.sort(key=lambda t: (t["slot"] or 0, t["seq"]))
        return {"trades": trades, "reached_launch": reached, "transactions": len(pick)}
