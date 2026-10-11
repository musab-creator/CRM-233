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
from dataclasses import dataclass, field

from solders.pubkey import Pubkey

log = logging.getLogger("bot.pumpchain")

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
WSOL_MINT = "So11111111111111111111111111111111111111112"
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
    quote_mint: str | None = None   # None: priced in SOL; otherwise the token the curve is priced in
    # the account as read, for the log when a read makes no sense as a SOL curve
    size: int = field(default=0, compare=False)
    extra: str = field(default="", compare=False, repr=False)   # hex of bytes 81..166
    # byte 81 of the 166-byte layout: pump.fun Mayhem Mode, whose curves hold far less virtual SOL
    mayhem: bool = field(default=False, compare=False)

    @property
    def price_sol(self) -> float | None:
        return self.v_sol / self.v_tokens if self.v_tokens > 0 else None


def plausible_curve(c: Curve) -> bool:
    """A pump.fun curve starts at 30 virtual SOL against 1.073B virtual tokens and completes near
    115 SOL against 280M. One live read (#784, 8 Oct) came back at 281x the token's price, far
    outside anything a curve can reach; the bounds are loose enough for a non-standard curve and
    tight enough to drop a corrupt read before it reaches the price history."""
    return (0.1 * INITIAL_VIRTUAL_TOKENS <= c.v_tokens <= 1.5 * INITIAL_VIRTUAL_TOKENS
            and 0.5 * INITIAL_VIRTUAL_SOL <= c.v_sol <= 20 * INITIAL_VIRTUAL_SOL)


def decode_curve(data: bytes | None) -> Curve | None:
    """Bonding-curve account bytes -> Curve, or None if it is not a bonding-curve account.

    Since May 2026 a curve may be priced in another token (USDC, a listed token, and since 7-8 Oct
    any pump coin): the reserves at offsets 16 and 32 are then in that token's units, not lamports.
    pump's IDL (pump-fun/pump-public-docs, 8 Oct 2026) puts quote_mint at bytes 83..115 of the
    166-byte account; the default key (all zeros) means SOL. Shorter, older accounts are SOL."""
    if not data or len(data) < 49 or data[:8] != CURVE_DISCRIMINATOR:
        return None
    vt, vs, rt, rs, sup = struct.unpack_from("<5Q", data, 8)
    creator = str(Pubkey.from_bytes(data[49:81])) if len(data) >= 81 else None
    quote = None
    if len(data) >= 115 and any(data[83:115]):
        quote = str(Pubkey.from_bytes(data[83:115]))
        if quote == WSOL_MINT:
            quote = None
    scale = 10 ** TOKEN_DECIMALS
    return Curve(vt / scale, vs / LAMPORTS, rt / scale, rs / LAMPORTS, sup / scale, data[48] != 0, creator, quote,
                 len(data), data[81:166].hex(), len(data) > 81 and data[81] == 1)


def encode_curve(c: Curve) -> bytes:
    """Inverse of decode_curve (tests and the simulator)."""
    scale = 10 ** TOKEN_DECIMALS
    out = CURVE_DISCRIMINATOR + struct.pack("<5Q", round(c.v_tokens * scale), round(c.v_sol * LAMPORTS),
                                            round(c.real_tokens * scale), round(c.real_sol * LAMPORTS),
                                            round(c.supply * scale)) + bytes([int(c.complete)])
    out += bytes(Pubkey.from_string(c.creator)) if c.creator else b""
    if c.quote_mint:                                    # the 166-byte layout: mayhem, cashback, quote_mint, rest
        out = out.ljust(81, b"\0") + b"\0\0" + bytes(Pubkey.from_string(c.quote_mint))
        out = out.ljust(166, b"\0")
    return out


def bonding_curve_key(mint: str) -> str | None:
    """The bonding-curve account of a pump.fun mint: the program address from the seeds
    ("bonding-curve", mint). None for a string that is not a public key."""
    try:
        return str(Pubkey.find_program_address([b"bonding-curve", bytes(Pubkey.from_string(mint))],
                                               Pubkey.from_string(PUMP_PROGRAM))[0])
    except (ValueError, TypeError):
        return None


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
                owner = (acc or {}).get("owner")
                if owner is not None and owner != PUMP_PROGRAM:
                    out[k] = None                       # not pump's account, whatever its bytes look like
                    continue
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
                           max_pages: int = 10, concurrency: int | None = None) -> dict:
        """Trades in the first `window_s` seconds after launch (at most `max_tx` transactions).

        Signatures come newest first, 1,000 per call (1 credit). Paging back to the launch stops
        after `max_pages`; `reached_launch` says whether it got there. `concurrency` caps the
        transaction reads in flight, so a background reader never queues dozens of calls ahead of
        the position price reads on the shared rate limiter.
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
        gate = asyncio.Semaphore(concurrency) if concurrency else None

        async def read(sig: str):
            if gate is None:
                return await self.h.rpc("getTransaction", [sig, {
                    "encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"}])
            async with gate:
                return await self.h.rpc("getTransaction", [sig, {
                    "encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"}])
        txs = await asyncio.gather(*[read(x["signature"]) for x in pick], return_exceptions=True)
        trades: list[dict] = []
        for seq, tx in enumerate(txs):  # seq: block order, the tiebreaker inside a slot
            if isinstance(tx, dict):
                for t in trades_from_tx(tx, mint, curve_key):
                    t["seq"] = seq
                    trades.append(t)
        trades.sort(key=lambda t: (t["slot"] or 0, t["seq"]))
        return {"trades": trades, "reached_launch": reached, "transactions": len(pick)}
