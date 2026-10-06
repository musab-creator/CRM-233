"""Live executor. In this build it is a DRY RUN by default: it builds and signs the real
transaction and simulates it through Helius RPC, but never sends it.

Routes:
  bonding curve / any pool -> PumpPortal Local Trade API  POST /api/trade-local  (pool "auto")
  graduated + JUPITER_API_KEY -> Jupiter Swap API v2       GET /order -> sign -> POST /execute

Dry run: fills are modeled with the paper cost model.

Sending (LIVE_DRY_RUN=false), fills are reconciled against the wallet, never assumed:
  * sells are a percentage of what the wallet actually holds ("100%" on full exits), so a fill
    that differed from the model can never leave a position unsellable;
  * after sending, the signature is polled until confirmed (LIVE_CONFIRM_TIMEOUT_S); tokens and
    SOL actually moved are read from wallet balances before/after;
  * before a sell is retried, the wallet balance is checked: if the earlier attempt already
    landed, it is recorded as the fill instead of selling again.

Every signature (dry-run or sent) is written to `live_tx`. The private key is held only as a
solders Keypair and is never logged.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
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


class LiveExecutionError(RuntimeError):
    pass


class LiveExecutor:
    mode = "live"

    def __init__(self, s: Settings, db: Database, http: httpx.AsyncClient, keypair: Keypair,
                 is_graduated: Callable[[str], bool], chain=None):
        """`chain` provides balance_sol / token_balance / signature_status (the Helius client)."""
        self.s = s
        self.db = db
        self.http = http
        self._kp = keypair
        self.pubkey = str(keypair.pubkey())
        self.is_graduated = is_graduated
        self.chain = chain
        self.rpc = AsyncClient(s.helius_rpc(), commitment=Confirmed)
        self.jup_lim = RateLimiter(s.JUPITER_RPS, burst=1)
        self.dry_run = s.LIVE_DRY_RUN
        self.poll_s = 2.0

    def __repr__(self) -> str:  # never expose the key
        return f"LiveExecutor(pubkey={self.pubkey}, dry_run={self.dry_run})"

    # --- transaction builders ---------------------------------------------------
    async def build_pumpportal(self, action: str, mint: str, amount, in_sol: bool) -> VersionedTransaction:
        """`amount`: SOL (buy), tokens, or a percentage string like "100%" (sell)."""
        body = {"publicKey": self.pubkey, "action": action, "mint": mint, "amount": amount,
                "denominatedInSol": "true" if in_sol else "false",
                "slippage": int(max(self.s.ENTRY_SLIPPAGE_PCT, self.s.EXIT_SLIPPAGE_PCT) * 2),
                "priorityFee": round(self.s.NETWORK_FEE_SOL * 0.8, 6), "pool": "auto"}
        r = await self.http.post(self.s.PUMPPORTAL_TRADE_URL, data=body, timeout=20)
        if r.status_code != 200:
            raise LiveExecutionError(f"trade-local HTTP {r.status_code}: {r.text[:200]}")
        tx = VersionedTransaction.from_bytes(r.content)
        return VersionedTransaction(tx.message, [self._kp])

    async def build_jupiter(self, input_mint: str, output_mint: str, amount_raw: int) -> tuple[VersionedTransaction, str]:
        if not self.s.JUPITER_API_KEY:
            raise LiveExecutionError("JUPITER_API_KEY not set")
        data = await request_json(
            self.http, "GET", f"{self.s.JUPITER_URL}/order", limiter=self.jup_lim,
            params={"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount_raw),
                    "taker": self.pubkey},
            headers={"x-api-key": self.s.JUPITER_API_KEY})
        if not data or not data.get("transaction"):
            raise LiveExecutionError(f"jupiter order returned no transaction: {str(data)[:200]}")
        tx = VersionedTransaction.from_bytes(base64.b64decode(data["transaction"]))
        return VersionedTransaction(tx.message, [self._kp]), data["requestId"]

    def _use_jupiter(self, mint: str) -> bool:
        return self.is_graduated(mint) and bool(self.s.JUPITER_API_KEY)

    # --- submit -------------------------------------------------------------------
    async def _simulate(self, tx: VersionedTransaction, route: str, side: str) -> str:
        sig = str(tx.signatures[0])
        sim = await self.rpc.simulate_transaction(tx, sig_verify=True)
        err = sim.value.err if sim and sim.value else "no result"
        logs = (sim.value.logs or [])[-5:] if sim and sim.value else []
        await self._log_tx(side, route, sig, sent=False, ok=err is None,
                           detail={"simulated": True, "err": str(err) if err else None, "logs": logs})
        log.info("DRY RUN %s via %s sig=%s simulate_err=%s", side, route, sig, err)
        return sig

    async def _send(self, tx: VersionedTransaction, route: str, side: str, jup_request: str | None) -> tuple[str, str]:
        """Send and wait for the outcome. Returns (signature, 'ok' | 'failed' | 'pending')."""
        sig = str(tx.signatures[0])
        if route == "jupiter":
            # Jupiter /execute lands and confirms the transaction itself
            res = await request_json(self.http, "POST", f"{self.s.JUPITER_URL}/execute", limiter=self.jup_lim,
                                     json={"signedTransaction": base64.b64encode(bytes(tx)).decode(),
                                           "requestId": jup_request},
                                     headers={"x-api-key": self.s.JUPITER_API_KEY})
            status = "ok" if (res or {}).get("status") == "Success" else "failed"
            sig = (res or {}).get("signature") or sig
            await self._log_tx(side, route, sig, sent=True, ok=status == "ok", detail=res)
            return sig, status
        resp = await self.rpc.send_raw_transaction(bytes(tx), opts=TxOpts(skip_preflight=False,
                                                                         preflight_commitment=Confirmed))
        sig = str(resp.value)
        await self._log_tx(side, route, sig, sent=True, ok=True, detail={"stage": "sent"})
        status = await self._await_confirmation(sig)
        await self._log_tx(side, route, sig, sent=True, ok=status == "ok", detail={"stage": status})
        log.info("SENT %s via %s sig=%s status=%s", side, route, sig, status)
        return sig, status

    async def _await_confirmation(self, sig: str) -> str:
        deadline = time.monotonic() + self.s.LIVE_CONFIRM_TIMEOUT_S
        while True:
            try:
                status = await self.chain.signature_status(sig)
            except Exception as e:  # an RPC hiccup is not an answer; keep polling
                log.warning("signature status for %s failed: %s", sig, e)
                status = "pending"
            if status != "pending" or time.monotonic() >= deadline:
                return status
            await asyncio.sleep(self.poll_s)

    async def _log_tx(self, side: str, route: str, sig: str, sent: bool, ok: bool, detail) -> None:
        try:
            await self.db.insert("live_tx", {"ts": now_s(), "position_id": None, "side": side, "route": route,
                                             "signature": sig, "sent": int(sent), "ok": int(ok), "detail": detail})
        except Exception:  # logging must never turn a landed trade into a "failed" one
            log.exception("could not record tx %s", sig)

    # --- executor interface -----------------------------------------------------------
    async def buy(self, mint: str, sol_in: float, price: float) -> Fill:
        jup = self._use_jupiter(mint)
        if self.dry_run:
            if jup:
                tx, _ = await self.build_jupiter(WSOL, mint, int(sol_in * LAMPORTS))
            else:
                tx = await self.build_pumpportal("buy", mint, round(sol_in, 6), in_sol=True)
            f = entry_fill(sol_in, price, self.s)
            f.tx_sig = await self._simulate(tx, "jupiter" if jup else "pumpportal", "buy")
            return f
        sol_before = await self.chain.balance_sol(self.pubkey)
        _, tok_before = await self.chain.token_balance(self.pubkey, mint)
        if jup:
            tx, rid = await self.build_jupiter(WSOL, mint, int(sol_in * LAMPORTS))
            sig, status = await self._send(tx, "jupiter", "buy", rid)
        else:
            tx = await self.build_pumpportal("buy", mint, round(sol_in, 6), in_sol=True)
            sig, status = await self._send(tx, "pumpportal", "buy", None)
        if status == "failed":
            raise LiveExecutionError(f"buy {sig} failed on chain")
        _, tok_after = await self.chain.token_balance(self.pubkey, mint)
        got = tok_after - tok_before
        if got <= 0:  # 'pending' after the timeout and nothing arrived: treat as not filled
            raise LiveExecutionError(f"buy {sig} not confirmed and no tokens received")
        spent = sol_before - await self.chain.balance_sol(self.pubkey)
        return Fill("buy", price, spent / got if got else price, got, spent,
                    max(0.0, spent - sol_in), sig)

    async def sell(self, mint: str, tokens: float, price: float, fraction: float = 1.0) -> Fill:
        """Sell `fraction` of current holdings (`tokens` is the bot's own estimate of that amount)."""
        full = fraction >= 0.999
        jup = self._use_jupiter(mint)
        if self.dry_run:
            if jup:
                tx, _ = await self.build_jupiter(mint, WSOL, int(tokens * 10 ** PUMP_DECIMALS))
            else:
                tx = await self.build_pumpportal("sell", mint, round(tokens, 6), in_sol=False)
            f = exit_fill(tokens, price, self.s)
            f.tx_sig = await self._simulate(tx, "jupiter" if jup else "pumpportal", "sell")
            return f
        raw_before, tok_before = await self.chain.token_balance(self.pubkey, mint)
        # An earlier attempt may have landed after we gave up on it: if the wallet already holds
        # what should remain after this sell, record that as the fill rather than selling again.
        expected_after = 0.0 if full else (tokens / fraction) * (1 - fraction)
        if tok_before <= expected_after * 1.02 + 1e-9:
            log.warning("sell %s: wallet already at %.0f tokens (expected after %.0f); earlier attempt landed",
                        mint, tok_before, expected_after)
            f = exit_fill(tokens, price, self.s)  # proceeds of the earlier send are unknown here: modeled
            f.tx_sig = None
            return f
        sol_before = await self.chain.balance_sol(self.pubkey)
        if jup:
            amount_raw = raw_before if full else int(raw_before * fraction)
            tx, rid = await self.build_jupiter(mint, WSOL, amount_raw)
            sig, status = await self._send(tx, "jupiter", "sell", rid)
        else:
            pct = "100%" if full else f"{fraction * 100:.4g}%"
            tx = await self.build_pumpportal("sell", mint, pct, in_sol=False)
            sig, status = await self._send(tx, "pumpportal", "sell", None)
        if status == "failed":
            raise LiveExecutionError(f"sell {sig} failed on chain")
        _, tok_after = await self.chain.token_balance(self.pubkey, mint)
        sold = tok_before - tok_after
        if sold <= 0:
            raise LiveExecutionError(f"sell {sig} not confirmed and no tokens left the wallet")
        received = await self.chain.balance_sol(self.pubkey) - sol_before
        return Fill("sell", price, received / sold, sold, received, 0.0, sig)

    async def close(self) -> None:
        await self.rpc.close()
