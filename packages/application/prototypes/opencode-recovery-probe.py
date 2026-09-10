"""THROWAWAY: real SQLite + process-kill recovery experiment, synthetic source only.

Run: python3 packages/application/prototypes/opencode-recovery-probe.py
This is not the production Collector, native OpenCode, or a power-loss test.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile


def connect(path):
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    return db


def trace(name, root):
    with connect(root / "PROTOTYPE-pending.db") as db:
        cursor = db.execute("SELECT position FROM checkpoint").fetchone()[0]
        pending = db.execute("SELECT id, canonical_ack, raw_state FROM pending").fetchall()
    with connect(root / "PROTOTYPE-remote.db") as db:
        deliveries = db.execute("SELECT kind,id FROM accepted ORDER BY kind,id").fetchall()
    print(json.dumps({"phase": name, "cursor": cursor, "pending": pending,
                      "remote": deliveries}, ensure_ascii=False), flush=True)


def initialize(root):
    with connect(root / "PROTOTYPE-source.db") as db:
        db.execute("CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)")
        db.execute("INSERT INTO part VALUES(?,?,?,?)", ("p1", "m1", "s1", json.dumps({
            "type": "text", "text": "A token=FIXTURE_SECRET", "unused": "RAW_ONLY_SENTINEL"})))
    with connect(root / "PROTOTYPE-pending.db") as db:
        db.executescript("""
        CREATE TABLE checkpoint(position INTEGER NOT NULL);
        INSERT INTO checkpoint VALUES(0);
        CREATE TABLE pending(id TEXT PRIMARY KEY, canonical TEXT NOT NULL, raw TEXT,
          canonical_ack INTEGER NOT NULL DEFAULT 0, raw_state TEXT NOT NULL);
        """)
    with connect(root / "PROTOTYPE-remote.db") as db:
        db.execute("CREATE TABLE accepted(kind TEXT,id TEXT,body TEXT,digest TEXT,PRIMARY KEY(kind,id))")


def prepare(root, raw_enabled, die=False):
    # A transaction on the read-only synthetic source, not a copied live DB.
    src = sqlite3.connect((root / "PROTOTYPE-source.db").as_uri() + "?mode=ro", uri=True)
    src.execute("BEGIN")
    row = src.execute("SELECT id,data FROM part WHERE id='p1'").fetchone()
    data = json.loads(row[1])
    canonical = json.dumps({"eventId": row[0], "revision": 1, "text": data["text"]}, sort_keys=True)
    # Illustrative exact-literal masking only, NOT the ATape SecretRedactor.
    canonical = canonical.replace("FIXTURE_SECRET", "[REDACTED]")
    raw = row[1].replace("FIXTURE_SECRET", "[REDACTED]") if raw_enabled else None
    src.close()
    with connect(root / "PROTOTYPE-pending.db") as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT INTO pending(id,canonical,raw,raw_state) VALUES(?,?,?,?)",
                   ("unit-1", canonical, raw, "pending" if raw_enabled else "not-requested"))
        if die:
            os.kill(os.getpid(), signal.SIGKILL)


def deliver(root, kind, die=False):
    with connect(root / "PROTOTYPE-pending.db") as db:
        row = db.execute("SELECT id,canonical,raw,canonical_ack,raw_state FROM pending").fetchone()
    if kind == "raw":
        assert row[3] == 1 and row[4] == "pending", "Raw requires Canonical confirmation and an active obligation"
    body = row[1 if kind == "canonical" else 2]
    assert body is not None
    digest = hashlib.sha256(body.encode()).hexdigest()
    with connect(root / "PROTOTYPE-remote.db") as db:
        prior = db.execute("SELECT digest FROM accepted WHERE kind=? AND id=?", (kind, row[0])).fetchone()
        assert prior is None or prior[0] == digest, "Same delivery identity changed content"
        db.execute("INSERT OR IGNORE INTO accepted VALUES(?,?,?,?)", (kind, row[0], body, digest))
    if die:
        os.kill(os.getpid(), signal.SIGKILL)
    with connect(root / "PROTOTYPE-pending.db") as db:
        if kind == "canonical":
            db.execute("UPDATE pending SET canonical_ack=1 WHERE id=?", (row[0],))
        else:
            db.execute("UPDATE pending SET raw_state='acknowledged' WHERE id=?", (row[0],))


def finish(root, die=False):
    with connect(root / "PROTOTYPE-pending.db") as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT canonical_ack,raw_state FROM pending").fetchone()
        assert row and row[0] == 1 and row[1] != "pending", "Cannot acknowledge incomplete obligations"
        db.execute("UPDATE checkpoint SET position=1")
        db.execute("DELETE FROM pending")
        if die:
            os.kill(os.getpid(), signal.SIGKILL)


def child(root, operation, killed=False):
    result = subprocess.run([sys.executable, __file__, operation, str(root)])
    assert result.returncode == (-signal.SIGKILL if killed else 0), (operation, result.returncode)


def main():
    if len(sys.argv) > 1:
        operation, root = sys.argv[1], Path(sys.argv[2])
        if operation == "prepare-kill": prepare(root, True, True)
        elif operation == "canonical-kill": deliver(root, "canonical", True)
        elif operation == "raw-kill": deliver(root, "raw", True)
        elif operation == "finish-kill": finish(root, True)
        else: raise ValueError(operation)
        return
    with tempfile.TemporaryDirectory(prefix="PROTOTYPE-opencode-wipe-me-") as scratch:
        root = Path(scratch); initialize(root)
        child(root, "prepare-kill", True)
        with connect(root / "PROTOTYPE-pending.db") as db:
            assert db.execute("SELECT count(*) FROM pending").fetchone()[0] == 0
        trace("killed before prepare commit: no pending/remote effect", root)
        prepare(root, True)
        child(root, "canonical-kill", True)
        with connect(root / "PROTOTYPE-source.db") as db:
            db.execute("UPDATE part SET data=?", (json.dumps({"type": "text", "text": "B"}),))
        trace("Canonical accepted; no local receipt; source changed to B", root)
        deliver(root, "canonical")
        child(root, "raw-kill", True)
        trace("Raw accepted; no local receipt; pending still owns A", root)
        deliver(root, "raw")
        child(root, "finish-kill", True)
        trace("killed during cursor+reclaim transaction: both rolled back", root)
        finish(root)
        with connect(root / "PROTOTYPE-remote.db") as db:
            bodies = db.execute("SELECT body FROM accepted").fetchall()
            assert len(bodies) == 2 and all("A token=" in x[0] for x in bodies)
            assert all("FIXTURE_SECRET" not in x[0] for x in bodies)
        trace("recovered: cursor committed, pending reclaimed, no duplicate remote effects", root)
    with tempfile.TemporaryDirectory(prefix="PROTOTYPE-opencode-raw-off-") as scratch:
        root=Path(scratch); initialize(root); prepare(root, False)
        with connect(root / "PROTOTYPE-pending.db") as db:
            row=db.execute("SELECT canonical,raw,raw_state FROM pending").fetchone()
            assert row[1] is None and row[2] == "not-requested"
            assert "RAW_ONLY_SENTINEL" not in row[0] and "FIXTURE_SECRET" not in row[0]
        deliver(root, "canonical"); finish(root)
        trace("Raw disabled: projected pending data only; no Raw receipt", root)
    print("PASS: synthetic SQLite/process-kill experiment; native OpenCode and production Interfaces NOT verified.")


if __name__ == "__main__":
    main()
