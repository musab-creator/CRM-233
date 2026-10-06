"""Live executor. In this build it is a DRY RUN by default: it builds and signs the real
transaction and simulates it through Helius RPC, but never sends it.

Routes:
  bonding curve / any pool -> PumpPortal Local Trade API  POST /api/trade-local  (pool "auto")
  graduated + JUPITER_API_KEY -> Jupiter Swap API v2       GET /order -> sign -> POST /execute

Fills are modeled with the paper cost model; every signature (dry-run or sent) is written to
`live_tx`. The private key is held only as a solders Keypair and is never logged.
"""
from __future__ import annotations

import base64
import logging
from typing import Callable

import httpx
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
try:  # solana-py >= 0.41
    from solana.rpc.models import TxOpts
except ImportError:  # older releases
    from solana.rpc.types import TxOpts
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction

from ..config import Settings
from ..db import Database
from ..feeds.dexscreener import WSOL
from ..feeds.http import request_json
from ..paper import Fill, entry_fill, exit_fill
from ..util import RateLimiter, now_s

log = logging.getLogger("bot.live")

PUMP_DECIMALS = 6
LAMPORTS = 1_000_000_000


class LiveExecutor:
    mode = "live"

    def __init__(self, s: Settings, db: Database, http: httpx.AsyncClient, keypair: Keypair,
                 is_graduated: Callable[[str], bool]):
        self.s = s
        self.db = db
        self.http = http
        self._kp = keypair
        self.pubkey = str(keypair.pubkey())
        self.is_graduated = is_graduated
        self.rpc = AsyncClient(s.helius_rpc(), commitment=Confirmed)
        self.jup_lim = RateLimiter(s.JUPITER_RPS, burst=1)
        self.dry_run = s.LIVE_DRY_RUN

    def __repr__(self) -> str:  # never expose the key
        return f"LiveExecutor(pubkey={self.pubkey}, dry_run={self.dry_run})"

    # --- transaction builders ---------------------------------------------------
    async def build_pumpportal(self, action: str, mint: str, amount: float, in_sol: bool) -> VersionedTransaction:
        body = {"publicKey": self.pubkey, "action": action, "mint": mint, "amount": amount,
                "denominatedInSol": "true" if in_sol else "false",
                "slippage": int(max(self.s.ENTRY_SLIPPAGE_PCT, self.s.EXIT_SLIPPAGE_PCT) * 2),
                "priorityFee": round(self.s.NETWORK_FEE_SOL * 0.8, 6), "pool": "auto"}
        r = await self.http.post(self.s.PUMPPORTAL_TRADE_URL, data=body, timeout=20)
        if r.status_code != 200:
            raise RuntimeError(f"trade-local HTTP {r.status_code}: {r.text[:200]}")
        tx = VersionedTransaction.from_bytes(r.content)
        return VersionedTransaction(tx.message, [self._kp])

    async def build_jupiter(self, input_mint: str, output_mint: str, amount_raw: int) -> tuple[VersionedTransaction, str]:
        if not self.s.JUPITER_API_KEY:
            raise RuntimeError("JUPITER_API_KEY not set")
        data = await request_json(
            self.http, "GET", f"{self.s.JUPITER_URL}/order", limiter=self.jup_lim,
            params={"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount_raw),
                    "taker": self.pubkey},
            headers={"x-api-key": self.s.JUPITER_API_KEY})
        if not data or not data.get("transaction"):
            raise RuntimeError(f"jupiter order returned no transaction: {str(data)[:200]}")
        tx = VersionedTransaction.from_bytes(base64.b64decode(data["transaction"]))
        return VersionedTransaction(tx.message, [self._kp]), data["requestId"]

    # --- submit -------------------------------------------------------------------
    async def _submit(self, tx: VersionedTransaction, route: str, side: str, jup_request: str | None) -> str:
        sig = str(tx.signatures[0])
        raw = bytes(tx)
        if self.dry_run:
            sim = await self.rpc.simulate_transaction(tx, sig_verify=True)
            err = sim.value.err if sim and sim.value else "no result"
            logs = (sim.value.logs or [])[-5:] if sim and sim.value else []
            await self._log_tx(side, route, sig, sent=False, ok=err is None,
                               detail={"simulated": True, "err": str(err) if err else None, "logs": logs})
            log.info("DRY RUN %s via %s sig=%s simulate_err=%s", side, route, sig, err)
            return sig
        if route == "jupiter":
            res = await request_json(self.http, "POST", f"{self.s.JUPITER_URL}/execute", limiter=self.jup_lim,
                                     json={"signedTransaction": base64.b64encode(raw).decode(),
                                           "requestId": jup_request},
                                     headers={"x-api-key": self.s.JUPITER_API_KEY})
            ok = (res or {}).get("status") == "Success"
            sig = (res or {}).get("signature") or sig
            await self._log_tx(side, route, sig, sent=True, ok=ok, detail=res)
            if not ok:
                raise RuntimeError(f"jupiter execute failed: {str(res)[:200]}")
        else:
            resp = await self.rpc.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False,
                                                                        preflight_commitment=Confirmed))
            sig = str(resp.value)
            await self._log_tx(side, route, sig, sent=True, ok=True, detail={})
        log.info("SENT %s via %s sig=%s", side, route, sig)
        return sig

    async def _log_tx(self, side: str, route: str, sig: str, sent: bool, ok: bool, detail) -> None:
        await self.db.insert("live_tx", {"ts": now_s(), "position_id": None, "side": side, "route": route,
                                         "signature": sig, "sent": int(sent), "ok": int(ok), "detail": detail})

    # --- executor interface -----------------------------------------------------------
    async def buy(self, mint: str, sol_in: float, price: float) -> Fill:
        if self.is_graduated(mint) and self.s.JUPITER_API_KEY:
            tx, rid = await self.build_jupiter(WSOL, mint, int(sol_in * LAMPORTS))
            sig = await self._submit(tx, "jupiter", "buy", rid)
        else:
            tx = await self.build_pumpportal("buy", mint, round(sol_in, 6), in_sol=True)
            sig = await self._submit(tx, "pumpportal", "buy", None)
        f = entry_fill(sol_in, price, self.s)
        f.tx_sig = sig
        return f

    async def sell(self, mint: str, tokens: float, price: float) -> Fill:
        if self.is_graduated(mint) and self.s.JUPITER_API_KEY:
            tx, rid = await self.build_jupiter(mint, WSOL, int(tokens * 10 ** PUMP_DECIMALS))
            sig = await self._submit(tx, "jupiter", "sell", rid)
        else:
            tx = await self.build_pumpportal("sell", mint, round(tokens, 6), in_sol=False)
            sig = await self._submit(tx, "pumpportal", "sell", None)
        f = exit_fill(tokens, price, self.s)
        f.tx_sig = sig
        return f

    async def close(self) -> None:
        await self.rpc.close()
