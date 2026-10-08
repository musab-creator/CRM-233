"""Live executor. In this build it is a DRY RUN by default: it builds and signs the real
transaction and simulates it through Helius RPC, but never sends it.

Routes:
  bonding curve / any pool -> PumpPortal Local Trade API  POST /api/trade-local  (pool "auto")
  graduated + JUPITER_API_KEY -> Jupiter Swap API v2       GET /order -> sign -> POST /execute

Dry run: fills are modeled with the paper cost model.

Sending (LIVE_DRY_RUN=false), fills are reconciled against the wallet, never assumed:
  * sells are a percentage of what the wallet actually holds ("100%" on full exits), so a fill
    that differed from the model can never leave a position unsellable;
  * the signed transaction intent is persisted before broadcast and polled until confirmed;
  * fills use the confirmed transaction's own SOL and token balance deltas;
  * an uncertain retry reconciles the original signature instead of submitting another trade.

Every signature (dry-run or sent) is written to `live_tx`. The private key is held only as a
solders Keypair and is never logged.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from math import isfinite
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
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from solders.compute_budget import ID as COMPUTE_BUDGET_ID

from ..config import Settings
from ..db import Database
from ..feeds.dexscreener import WSOL
from ..feeds.http import request_json
from ..paper import Fill, entry_fill, exit_fill
from ..risk import kill_switch_active
from ..util import RateLimiter, now_s

log = logging.getLogger("bot.live")

PUMP_DECIMALS = 6
LAMPORTS = 1_000_000_000


class LiveExecutionError(RuntimeError):
    pass


class LiveExecutionUnknown(LiveExecutionError):
    """May have landed: keep its intent and reconcile, never rebuild or invent a fill."""


def spend_limit(side: str, sol_in: float, s) -> float:
    """The most a transaction may take from the wallet. A buy spends `sol_in` plus the pump.fun
    and PumpPortal percentage fees on top, the network fee, and the rent of a token account the
    wallet may not have yet (the first buy of any token). A sell only pays fees and, on some
    routes, a wrapped-SOL account it closes again."""
    fees = (s.PUMPFUN_FEE_PCT + s.PUMPPORTAL_FEE_PCT) / 100
    spend = sol_in * (1 + fees) if side == "buy" else 0.0
    return spend + s.NETWORK_FEE_SOL + s.LIVE_ACCOUNT_RENT_SOL


def check_transaction(msg, payer, max_sol_debit: float) -> dict:
    """Static checks on a remotely built transaction before it is signed.

    The wallet must be the only required signer and the fee payer; every program must be a
    static account key; compute-budget instructions must be well formed; and the explicit
    native-SOL debits from the wallet (system transfers and account creations), plus the
    priority fee and base fee, must fit `max_sol_debit`. Raises LiveExecutionError, else
    returns what it found (also used by `python -m bot preflight --probe`).
    """
    if msg.header.num_required_signatures != 1 or not msg.account_keys or msg.account_keys[0] != payer:
        raise LiveExecutionError("remote transaction has an unexpected fee payer or required signer")
    debit_lamports = 0
    compute_limit = 1_400_000
    compute_price = 0
    seen_compute = set()
    programs: list[str] = []
    for ix in msg.instructions:
        if ix.program_id_index >= len(msg.account_keys):
            # The program itself must be a static key; lookup-table contents aren't signed here.
            raise LiveExecutionError("remote transaction program is not a static account key")
        program = msg.account_keys[ix.program_id_index]
        programs.append(str(program))
        if program == COMPUTE_BUDGET_ID:
            data = bytes(ix.data)
            if not data or data[0] not in (1, 2, 3, 4) or data[0] in seen_compute:
                raise LiveExecutionError("remote transaction has malformed or duplicate compute instructions")
            seen_compute.add(data[0])
            if data[0] == 2:
                if len(data) != 5:
                    raise LiveExecutionError("remote transaction has a malformed compute limit")
                compute_limit = int.from_bytes(data[1:], "little")
                if not 0 < compute_limit <= 1_400_000:
                    raise LiveExecutionError("remote transaction has an invalid compute limit")
            elif data[0] == 3:
                if len(data) != 9:
                    raise LiveExecutionError("remote transaction has a malformed compute price")
                compute_price = int.from_bytes(data[1:], "little")
            elif len(data) != 5:
                raise LiveExecutionError("remote transaction has a malformed compute instruction")
            continue
        if program != SYSTEM_PROGRAM_ID:
            continue
        data = bytes(ix.data)
        if len(data) < 4:
            raise LiveExecutionError("remote transaction has a malformed system instruction")
        opcode = int.from_bytes(data[:4], "little")
        if ix.accounts and ix.accounts[0] == 0:
            if opcode not in (0, 2) or len(data) < 12:
                raise LiveExecutionError("remote transaction has an unsupported wallet system instruction")
            debit_lamports += int.from_bytes(data[4:12], "little")
    priority_lamports = (compute_limit * compute_price + 999_999) // 1_000_000
    if debit_lamports + priority_lamports + 5000 > int(max_sol_debit * LAMPORTS):
        raise LiveExecutionError("remote transaction exceeds the authorized SOL spending limit")
    return {"instructions": len(msg.instructions), "programs": sorted(set(programs)),
            "explicit_debit_sol": debit_lamports / LAMPORTS, "priority_fee_sol": priority_lamports / LAMPORTS,
            "compute_limit": compute_limit, "max_sol_debit": max_sol_debit}


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
        # Balance/receipt checks and intents are serialized for this wallet.
        self._wallet_lock = asyncio.Lock()

    def __repr__(self) -> str:  # never expose the key
        return f"LiveExecutor(pubkey={self.pubkey}, dry_run={self.dry_run})"

    # --- transaction builders ---------------------------------------------------
    async def build_pumpportal(self, action: str, mint: str, amount, in_sol: bool) -> VersionedTransaction:
        """`amount`: SOL (buy), tokens, or a percentage string like "100%" (sell)."""
        body = {"publicKey": self.pubkey, "action": action, "mint": mint, "amount": amount,
                "denominatedInSol": "true" if in_sol else "false",
                # PumpPortal documents slippage as a whole percentage
                "slippage": max(1, int(round(self.s.ENTRY_SLIPPAGE_PCT if action == "buy" else self.s.EXIT_SLIPPAGE_PCT))),
                "priorityFee": round(self.s.NETWORK_FEE_SOL * 0.8, 6), "pool": "auto"}
        r = await self.http.post(self.s.PUMPPORTAL_TRADE_URL, data=body, timeout=20)
        if r.status_code != 200:
            raise LiveExecutionError(f"trade-local HTTP {r.status_code}: {r.text[:200]}")
        tx = VersionedTransaction.from_bytes(r.content)
        max_debit = spend_limit(action, float(amount) if in_sol else 0.0, self.s)
        return self._checked_sign(tx, max_debit)

    def _checked_sign(self, tx: VersionedTransaction, max_sol_debit: float) -> VersionedTransaction:
        """Reject foreign payers/signers and excessive explicit native-SOL debits, then sign."""
        check_transaction(tx.message, self._kp.pubkey(), max_sol_debit)
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
        # Some routes quote these fields; reject a contradictory order before signing.
        for field, expected in (("inputMint", input_mint), ("outputMint", output_mint),
                                ("inAmount", str(amount_raw))):
            if field in data and str(data[field]) != expected:
                raise LiveExecutionError(f"jupiter order has an unexpected {field}")
        if not data.get("requestId"):
            raise LiveExecutionError("jupiter order returned no requestId")
        tx = VersionedTransaction.from_bytes(base64.b64decode(data["transaction"], validate=True))
        max_debit = spend_limit("buy" if input_mint == WSOL else "sell",
                                amount_raw / LAMPORTS if input_mint == WSOL else 0.0, self.s)
        return self._checked_sign(tx, max_debit), data["requestId"]

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
        if err is not None:
            raise LiveExecutionError(f"dry-run {side} simulation failed: {err}")
        return sig

    async def _send(self, tx: VersionedTransaction, route: str, side: str, jup_request: str | None) -> tuple[str, str]:
        """Send and wait for the outcome. Returns (signature, 'ok' | 'failed' | 'pending')."""
        sig = str(tx.signatures[0])
        if side == "buy" and kill_switch_active(self.s):
            raise LiveExecutionError("STOP file appeared before broadcast; entry refused")
        if route == "jupiter":
            # Jupiter /execute lands and confirms the transaction itself
            await self.jup_lim.acquire()
            if side == "buy" and kill_switch_active(self.s):
                raise LiveExecutionError("STOP file appeared before broadcast; entry refused")
            res = await request_json(self.http, "POST", f"{self.s.JUPITER_URL}/execute", retries=0,
                                     json={"signedTransaction": base64.b64encode(bytes(tx)).decode(),
                                           "requestId": jup_request},
                                     headers={"x-api-key": self.s.JUPITER_API_KEY})
            # A service rejection doesn't prove this signed transaction can't still land.
            remote_sig = (res or {}).get("signature")
            if remote_sig and remote_sig != sig:
                raise LiveExecutionUnknown("jupiter returned a signature different from the signed transaction")
            status = await self._await_confirmation(sig)
            await self._log_tx(side, route, sig, sent=True, ok=status == "ok", detail=res)
            return sig, status
        resp = await self.rpc.send_raw_transaction(bytes(tx), opts=TxOpts(skip_preflight=False,
                                                                         preflight_commitment=Confirmed))
        if str(resp.value) != sig:
            raise LiveExecutionUnknown("RPC returned a signature different from the signed transaction")
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
    def _intent_key(self, mint: str, side: str) -> str:
        return f"live_intent:{self.pubkey}:{side}:{mint}"

    async def pending_intent(self, mint: str, side: str) -> dict | None:
        raw = await self.db.kv_get(self._intent_key(mint, side))
        return json.loads(raw) if raw else None

    async def acknowledge_fill(self, mint: str, side: str, signature: str) -> None:
        """Called in the position/fill DB transaction, so a crash cannot orphan a receipt."""
        key = self._intent_key(mint, side)
        raw = await self.db.kv_get(key)
        if raw and json.loads(raw).get("signature") == signature:
            await self.db.execute("DELETE FROM kv WHERE k=?", [key])

    async def _receipt_fill(self, intent: dict) -> Fill:
        sig, side, mint = intent["signature"], intent["side"], intent["mint"]
        status = await self._await_confirmation(sig)
        if status == "failed":
            # Definitive on-chain failure permits a fresh attempt; it cannot move token inventory.
            await self.db.execute("DELETE FROM kv WHERE k=?", [self._intent_key(mint, side)])
            raise LiveExecutionError(f"{side} {sig} failed on chain")
        if status != "ok":
            raise LiveExecutionUnknown(f"{side} {sig} not confirmed; original signature quarantined")
        try:
            tx = await self.chain.rpc("getTransaction", [sig, {
                "encoding": "jsonParsed", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}])
            if not isinstance(tx, dict) or not isinstance(tx.get("meta"), dict):
                raise ValueError("confirmed receipt is unavailable")
            meta = tx["meta"]
            if meta.get("err") is not None:
                raise ValueError("receipt contradicts the confirmed success status")
            keys = (tx.get("transaction") or {}).get("message", {}).get("accountKeys") or []
            payer = keys[0].get("pubkey") if keys and isinstance(keys[0], dict) else (keys[0] if keys else None)
            if payer != self.pubkey:
                raise ValueError("unexpected receipt fee payer")
            sol_delta = (int(meta["postBalances"][0]) - int(meta["preBalances"][0])) / LAMPORTS
            def holdings(field: str) -> float:
                total = 0.0
                for row in meta.get(field) or []:
                    if row.get("mint") == mint and row.get("owner") == self.pubkey:
                        amount = row["uiTokenAmount"]
                        total += int(amount["amount"]) / 10 ** int(amount["decimals"])
                return total
            remaining_tokens = holdings("postTokenBalances")
            token_delta = remaining_tokens - holdings("preTokenBalances")
            tokens = token_delta if side == "buy" else -token_delta
            sol = -sol_delta if side == "buy" else sol_delta
            if not isfinite(tokens) or tokens <= 0 or not isfinite(sol) or (side == "buy" and sol <= 0):
                raise ValueError("receipt has no matching SOL/token movement")
            if side == "buy" and sol > spend_limit("buy", intent["amount"], self.s) + 1e-9:
                # The same allowance the transaction was simulated against (amount, percentage fees,
                # network fee, token-account rent). Beyond it, do not conceal the loss: leave the
                # signature quarantined for operator reconciliation. (First live buy, 8 Oct: this
                # check still used amount + network fee and refused a receipt the simulation had
                # passed, so the confirmed buy sat unreconciled.)
                raise ValueError("confirmed spend exceeds the authorized SOL limit")
            fee = max(0.0, sol - intent["amount"]) if side == "buy" else int(meta.get("fee") or 0) / LAMPORTS
            fill = Fill(side, intent["price"], sol / tokens, tokens, sol, fee, sig,
                        remaining_tokens if side == "sell" else None)
            await self._log_tx(side, intent["route"], sig, sent=True, ok=True,
                               detail={"stage": "reconciled", "mint": mint, "tokens": tokens, "sol": sol})
            return fill
        except LiveExecutionError:
            raise
        except Exception as e:
            raise LiveExecutionUnknown(f"{side} {sig} receipt reconciliation failed ({type(e).__name__}: {e}); "
                                       "original signature quarantined") from None

    async def _execute(self, mint: str, side: str, amount: float, price: float,
                       tx: VersionedTransaction, route: str, rid: str | None) -> Fill:
        key = self._intent_key(mint, side)
        sig = str(tx.signatures[0])
        intent = {"signature": sig, "mint": mint, "side": side, "amount": amount,
                  "price": price, "route": route, "created_at": now_s()}
        await self._check_simulated_spend(tx, side, amount)
        # No sending is possible without a durable reconciliation record.
        await self.db.kv_set(key, json.dumps(intent))
        await self._log_tx(side, route, sig, sent=False, ok=True, detail={"stage": "prepared", "mint": mint})
        try:
            await self._send(tx, route, side, rid)
        except LiveExecutionUnknown:
            raise
        except Exception as e:
            if isinstance(e, LiveExecutionError) and "before broadcast" in str(e):
                await self.db.execute("DELETE FROM kv WHERE k=?", [key])
                raise
            # A transport error is an unknown result, not proof of failure.
            raise LiveExecutionUnknown(f"{side} {sig} broadcast result unknown ({type(e).__name__}); "
                                       "original signature quarantined") from None
        return await self._receipt_fill(intent)

    async def _check_simulated_spend(self, tx: VersionedTransaction, side: str, amount: float) -> None:
        """Simulate the exact signed transaction and inspect its payer's resulting SOL balance."""
        before = await self.chain.balance_sol(self.pubkey)
        try:
            simulation = await self.chain.rpc("simulateTransaction", [
                base64.b64encode(bytes(tx)).decode(), {
                    "encoding": "base64", "sigVerify": True, "commitment": "confirmed",
                    "accounts": {"encoding": "base64", "addresses": [self.pubkey]}}])
            value = (simulation or {}).get("value")
            if not isinstance(value, dict):
                raise ValueError("simulation returned no result")
            if value.get("err") is not None:
                # the program's own words: a slippage or balance failure reads differently from an RPC slip
                said = [ln for ln in (value.get("logs") or []) if "error" in ln.lower() or "failed" in ln.lower()][-2:]
                raise ValueError(f"simulation failed: {value['err']}" + (f" ({'; '.join(said)})" if said else ""))
            accounts = value.get("accounts") or []
            if len(accounts) != 1 or not isinstance(accounts[0], dict):
                raise ValueError("simulation returned no payer account")
            after_lamports = accounts[0].get("lamports")
            if not isinstance(after_lamports, int) or after_lamports < 0:
                raise ValueError("simulation returned an invalid payer balance")
            after = after_lamports / LAMPORTS
            allowed = spend_limit(side, amount, self.s)
            if not isfinite(before) or before - after > allowed + 1e-9:
                raise ValueError("simulated payer debit exceeds the authorized SOL spending limit")
        except Exception as e:
            raise LiveExecutionError(f"{side} pre-broadcast simulation refused ({type(e).__name__}: {e})") from None

    async def buy(self, mint: str, sol_in: float, price: float) -> Fill:
        if not isfinite(sol_in) or sol_in <= 0 or not isfinite(price) or price <= 0:
            raise ValueError("buy amount and price must be finite and positive")
        async with self._wallet_lock:
            return await self._buy(mint, sol_in, price)

    async def _buy(self, mint: str, sol_in: float, price: float) -> Fill:
        # A real transaction may be in flight from before a restart, dry run or not: read its
        # receipt (the receipt path only reads the chain) rather than simulate over it.
        existing = await self.db.kv_get(self._intent_key(mint, "buy"))
        if existing:
            return await self._receipt_fill(json.loads(existing))
        if kill_switch_active(self.s):
            raise LiveExecutionError("STOP file present; entry refused")
        jup = self._use_jupiter(mint)
        if self.dry_run:
            if jup:
                tx, _ = await self.build_jupiter(WSOL, mint, int(sol_in * LAMPORTS))
            else:
                tx = await self.build_pumpportal("buy", mint, round(sol_in, 6), in_sol=True)
            if kill_switch_active(self.s):
                raise LiveExecutionError("STOP file appeared before simulation; entry refused")
            f = entry_fill(sol_in, price, self.s)
            f.tx_sig = await self._simulate(tx, "jupiter" if jup else "pumpportal", "buy")
            return f
        if self.chain is None:
            raise LiveExecutionError("live sending requires the Helius transaction receipt source")
        balance = await self.chain.balance_sol(self.pubkey)
        if not isfinite(balance) or balance < sol_in + self.s.NETWORK_FEE_SOL:
            raise LiveExecutionError("insufficient wallet SOL for entry and network fees")
        if jup:
            tx, rid = await self.build_jupiter(WSOL, mint, int(sol_in * LAMPORTS))
        else:
            tx = await self.build_pumpportal("buy", mint, round(sol_in, 6), in_sol=True)
            rid = None
        return await self._execute(mint, "buy", sol_in, price, tx, "jupiter" if jup else "pumpportal", rid)

    async def sell(self, mint: str, tokens: float, price: float, fraction: float = 1.0) -> Fill:
        """Sell `fraction` of current holdings (`tokens` is the bot's own estimate of that amount)."""
        if (not isfinite(tokens) or tokens <= 0 or not isfinite(price) or price <= 0
                or not isfinite(fraction) or not 0 < fraction <= 1):
            raise ValueError("sell tokens/price must be positive and fraction must be within (0,1]")
        async with self._wallet_lock:
            return await self._sell(mint, tokens, price, fraction)

    async def _sell(self, mint: str, tokens: float, price: float, fraction: float) -> Fill:
        existing = await self.db.kv_get(self._intent_key(mint, "sell"))
        if existing:                                   # see _buy: never simulate over a pending real sell
            return await self._receipt_fill(json.loads(existing))
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
        # Without a tracked signature an empty/reduced balance is not a sale receipt.
        expected_after = 0.0 if full else (tokens / fraction) * (1 - fraction)
        if tok_before <= expected_after * 1.02 + 1e-9:
            raise LiveExecutionUnknown("wallet holdings changed without a tracked sell signature; "
                                       "reconcile the wallet before retrying")
        if jup:
            amount_raw = raw_before if full else int(raw_before * fraction)
            tx, rid = await self.build_jupiter(mint, WSOL, amount_raw)
        else:
            pct = "100%" if full else f"{fraction * 100:.4g}%"
            tx = await self.build_pumpportal("sell", mint, pct, in_sol=False)
            rid = None
        return await self._execute(mint, "sell", tokens, price, tx, "jupiter" if jup else "pumpportal", rid)

    async def close(self) -> None:
        await self.rpc.close()
