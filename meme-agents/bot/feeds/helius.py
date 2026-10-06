"""Helius RPC (free plan: 10 req/s) and DAS / Enhanced Transactions API (2 req/s).

Credits (helius.dev/docs/billing/credits): an RPC call costs 1, getProgramAccounts 10, a DAS
call 10 and an Enhanced Transactions call 100. The free plan has 1M a month. `credits` counts
what this client spent so the engine can record and pace it.
"""
from __future__ import annotations

import itertools

import httpx

from ..util import RateLimiter
from .http import HttpError, request_json

LAMPORTS = 1_000_000_000


class RpcError(Exception):
    pass


class Helius:
    def __init__(self, client: httpx.AsyncClient, rpc_url: str, api_url: str, api_key: str,
                 rpc_rps: float, enhanced_rps: float):
        self.c = client
        self.rpc_url = rpc_url
        self.api_url = api_url.rstrip("/")
        self.key = api_key
        self.rpc_lim = RateLimiter(rpc_rps, burst=rpc_rps)
        self.enh_lim = RateLimiter(enhanced_rps, burst=1)
        self._ids = itertools.count(1)
        self.credits = 0

    async def _call(self, method: str, params, limiter: RateLimiter, credits: int):
        body = {"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": params}
        self.credits += credits
        data = await request_json(self.c, "POST", self.rpc_url, json=body, limiter=limiter)
        if data is None:
            raise RpcError(f"{method}: empty response")
        if data.get("error"):
            raise RpcError(f"{method}: {data['error']}")
        return data.get("result")

    async def rpc(self, method: str, params: list) -> dict | list | int | None:
        return await self._call(method, params, self.rpc_lim, 10 if method == "getProgramAccounts" else 1)

    async def das(self, method: str, params: dict) -> dict | list | None:
        """Digital Asset Standard methods (getTokenAccounts, getAsset, ...): 10 credits, 2 req/s."""
        return await self._call(method, params, self.enh_lim, 10)

    async def balance_sol(self, pubkey: str) -> float:
        res = await self.rpc("getBalance", [pubkey, {"commitment": "confirmed"}])
        if not isinstance(res, dict) or not isinstance(res.get("value"), int):
            # fail closed: the live guard must never read a missing balance as 0 SOL
            raise RpcError(f"getBalance: unexpected result {str(res)[:100]}")
        return res["value"] / LAMPORTS

    async def token_balance(self, owner: str, mint: str) -> tuple[int, float]:
        """(raw units, UI units) of `mint` held by `owner`, summed over its token accounts."""
        res = await self.rpc("getTokenAccountsByOwner",
                             [owner, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}])
        if not isinstance(res, dict) or not isinstance(res.get("value"), list):
            raise RpcError(f"getTokenAccountsByOwner: unexpected result {str(res)[:100]}")
        raw, ui = 0, 0.0
        for acc in res["value"]:
            amt = acc["account"]["data"]["parsed"]["info"]["tokenAmount"]
            raw += int(amt["amount"])
            ui += float(amt.get("uiAmount") or 0)
        return raw, ui

    async def signature_status(self, sig: str) -> str:
        """'ok' (confirmed without error), 'failed' (landed with an error) or 'pending' (not seen yet)."""
        res = await self.rpc("getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])
        st = ((res or {}).get("value") or [None])[0]
        if not st:
            return "pending"
        if st.get("err"):
            return "failed"
        return "ok" if st.get("confirmationStatus") in ("confirmed", "finalized") else "pending"

    async def holders(self, mint: str, exclude: set[str] | None = None) -> dict:
        """Top-20 token accounts resolved to owner wallets, with % of supply."""
        exclude = exclude or set()
        supply_res = await self.rpc("getTokenSupply", [mint])
        supply = float(((supply_res or {}).get("value") or {}).get("uiAmount") or 0)
        largest = ((await self.rpc("getTokenLargestAccounts", [mint, {"commitment": "confirmed"}])) or {}).get("value") or []
        addrs = [a["address"] for a in largest]
        owners: dict[str, str] = {}
        if addrs:
            accs = ((await self.rpc("getMultipleAccounts", [addrs, {"encoding": "jsonParsed"}])) or {}).get("value") or []
            for addr, acc in zip(addrs, accs):
                try:
                    owners[addr] = acc["data"]["parsed"]["info"]["owner"]
                except (TypeError, KeyError):
                    owners[addr] = ""
        rows = []
        for a in largest:
            ui = float(a.get("uiAmount") or 0)
            owner = owners.get(a["address"], "")
            rows.append({
                "token_account": a["address"], "owner": owner,
                "pct": round(100 * ui / supply, 3) if supply else None,
                "is_pool_or_curve": a["address"] in exclude or owner in exclude,
            })
        real = [r for r in rows if not r["is_pool_or_curve"]]
        return {
            "supply": supply,
            "holders": rows,
            "top10_pct_ex_pools": round(sum(r["pct"] or 0 for r in real[:10]), 2),
            "top1_pct_ex_pools": real[0]["pct"] if real else None,
        }

    async def address_transactions(self, address: str, limit: int = 20) -> list[dict]:
        """Enhanced (parsed) transactions for a wallet, newest first."""
        url = f"{self.api_url}/addresses/{address}/transactions"
        self.credits += 100
        try:
            data = await request_json(self.c, "GET", url, params={"api-key": self.key, "limit": limit},
                                      limiter=self.enh_lim)
        except HttpError:
            return []
        out = []
        for t in data or []:
            out.append({
                "signature": t.get("signature"), "timestamp": t.get("timestamp"), "type": t.get("type"),
                "source": t.get("source"), "description": (t.get("description") or "")[:200],
                "token_transfers": [
                    {"mint": x.get("mint"), "from": x.get("fromUserAccount"), "to": x.get("toUserAccount"),
                     "amount": x.get("tokenAmount")}
                    for x in (t.get("tokenTransfers") or [])[:6]
                ],
            })
        return out

    async def simulate(self, tx_b64: str) -> dict:
        return await self.rpc("simulateTransaction", [tx_b64, {
            "encoding": "base64", "sigVerify": True, "commitment": "confirmed"}])

    async def send(self, tx_b64: str) -> str:
        return await self.rpc("sendTransaction", [tx_b64, {
            "encoding": "base64", "skipPreflight": False, "maxRetries": 3, "preflightCommitment": "confirmed"}])
