"""Live executor in dry-run: builds + signs the PumpPortal transaction, simulates, never sends."""
import asyncio
from types import SimpleNamespace

from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from bot.db import Database
from bot.live.executor import LiveExecutor


def unsigned_tx(payer: Keypair) -> bytes:
    ix = transfer(TransferParams(from_pubkey=payer.pubkey(), to_pubkey=Keypair().pubkey(), lamports=1))
    msg = MessageV0.try_compile(payer.pubkey(), [ix], [], Hash.default())
    # PumpPortal returns an unsigned v0 transaction: one zeroed signature slot
    tx = VersionedTransaction.populate(msg, [Keypair().sign_message(b"x")])
    return bytes(tx)


class FakeHttp:
    def __init__(self, body: bytes):
        self.body = body
        self.posts = []

    async def post(self, url, data=None, timeout=None, **kw):
        self.posts.append((url, data))
        return SimpleNamespace(status_code=200, content=self.body, text="")


class FakeRpc:
    def __init__(self):
        self.simulated = []

    async def simulate_transaction(self, tx, sig_verify=False):
        self.simulated.append(tx)
        return SimpleNamespace(value=SimpleNamespace(err=None, logs=["ok"]))

    async def send_raw_transaction(self, *a, **k):
        raise AssertionError("dry run must never send")

    async def close(self):
        pass


def test_dry_run_builds_signs_simulates_and_never_sends(s):
    async def go():
        db = await Database(s.DB_PATH).open()
        kp = Keypair()
        http = FakeHttp(unsigned_tx(kp))
        ex = LiveExecutor(s, db, http, kp, is_graduated=lambda m: False)
        await ex.rpc.close()
        ex.rpc = FakeRpc()
        assert ex.dry_run
        f = await ex.buy("MintAddr", 0.05, 1e-7)
        url, body = http.posts[0]
        assert url.endswith("/api/trade-local")
        assert body["pool"] == "auto" and body["action"] == "buy" and body["denominatedInSol"] == "true"
        assert body["publicKey"] == str(kp.pubkey())
        signed = ex.rpc.simulated[0]
        assert signed.verify_with_results() == [True]
        assert f.tx_sig == str(signed.signatures[0])
        rows = await db.fetchall("SELECT * FROM live_tx")
        assert len(rows) == 1 and rows[0]["sent"] == 0 and rows[0]["signature"] == f.tx_sig
        assert str(kp) not in repr(ex) and str(kp) not in str(rows)
        f2 = await ex.sell("MintAddr", 1000.0, 1e-7)
        assert http.posts[1][1]["denominatedInSol"] == "false" and f2.tx_sig
        await db.close()
    asyncio.run(go())
