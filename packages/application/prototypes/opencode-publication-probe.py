"""THROWAWAY ADR-0025 publication model: synthetic SQLite + child SIGKILL.

Run: python3 packages/application/prototypes/opencode-publication-probe.py
No production DB/HTTP, OpenCode installation, or personal history is accessed.
This demonstrates replacement publication, NOT production acceptance. It does
not model PostgreSQL concurrency, power loss, authorization, bounded validation,
leases/receipt expiry, quotas, GC, patch mode, or the full Search worker protocol.
"""

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import select
import signal
import sqlite3
import subprocess
import sys
import tempfile


class Rejected(Exception):
    pass


@contextmanager
def connect(path):
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize(path):
    with connect(path) as db:
        db.executescript("""
        CREATE TABLE session(id TEXT PRIMARY KEY, head INTEGER, fence INTEGER);
        INSERT INTO session VALUES('synthetic-session', NULL, 0);
        CREATE TABLE attempt(head INTEGER PRIMARY KEY AUTOINCREMENT,
          base INTEGER, fence INTEGER, sealed INTEGER DEFAULT 0,
          validated INTEGER DEFAULT 0, manifest TEXT);
        CREATE TABLE part(head INTEGER, number INTEGER, body TEXT, digest TEXT,
          PRIMARY KEY(head, number));
        CREATE TABLE member(head INTEGER, event TEXT, descriptor TEXT,
          PRIMARY KEY(head, event));
        CREATE TABLE receipt(attempt INTEGER PRIMARY KEY, activated_head INTEGER);
        CREATE TABLE search_work(head INTEGER, event TEXT, descriptor TEXT,
          PRIMARY KEY(head, event));
        CREATE TABLE search_index(event TEXT, descriptor TEXT,
          PRIMARY KEY(event, descriptor));
        CREATE TABLE raw(session TEXT, object TEXT PRIMARY KEY, body TEXT);
        """)


def current(path):
    with connect(path) as db:
        return db.execute("SELECT head FROM session").fetchone()[0]


def begin(path, expected_base):
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        head, fence = db.execute("SELECT head, fence FROM session").fetchone()
        if expected_base != head:
            raise Rejected("stale base")
        db.execute("UPDATE session SET fence=?", (fence + 1,))
        return db.execute("INSERT INTO attempt(base,fence) VALUES(?,?)",
                          (head, fence + 1)).lastrowid


def upload(path, head, number, event, descriptor="v1"):
    body = json.dumps([event, descriptor], separators=(",", ":"))
    digest = hashlib.sha256(body.encode()).hexdigest()
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT sealed FROM attempt WHERE head=?", (head,)).fetchone()[0]:
            raise Rejected("sealed candidate is immutable")
        old = db.execute("SELECT digest FROM part WHERE head=? AND number=?",
                         (head, number)).fetchone()
        if old and old[0] != digest:
            raise Rejected("part replay differs")
        db.execute("INSERT OR IGNORE INTO part VALUES(?,?,?,?)", (head, number, body, digest))
    return digest


def seal(path, head, manifest):
    encoded = json.dumps(manifest)
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        sealed, previous = db.execute("SELECT sealed,manifest FROM attempt WHERE head=?",
                                      (head,)).fetchone()
        if sealed:
            if previous != encoded:
                raise Rejected("seal replay differs")
            return
        actual = db.execute("SELECT number,digest FROM part WHERE head=? ORDER BY number",
                            (head,)).fetchall()
        if actual != list(enumerate(manifest)):
            raise Rejected("incomplete or mismatching candidate")
        db.execute("UPDATE attempt SET sealed=1,manifest=? WHERE head=?", (encoded, head))


def validate(path, head):
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        sealed, validated = db.execute("SELECT sealed,validated FROM attempt WHERE head=?",
                                        (head,)).fetchone()
        if not sealed:
            raise Rejected("candidate is not sealed")
        if validated:
            return
        members = [json.loads(row[0]) for row in db.execute(
            "SELECT body FROM part WHERE head=? ORDER BY number", (head,))]
        if len({event for event, _ in members}) != len(members):
            raise Rejected("duplicate target event")
        db.executemany("INSERT INTO member VALUES(?,?,?)",
                       [(head, event, descriptor) for event, descriptor in members])
        db.execute("UPDATE attempt SET validated=1 WHERE head=?", (head,))


def pause_for_parent(label):
    print(label, flush=True)
    # The parent kills this process only after observing this precise boundary.
    sys.stdin.readline()
    raise RuntimeError("expected parent SIGKILL")


def activate(path, head, pause=None):
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        receipt = db.execute("SELECT activated_head FROM receipt WHERE attempt=?", (head,)).fetchone()
        if receipt:
            # Check replay BEFORE current fence/base: return history, never reset it.
            return receipt[0]
        base, fence, validated = db.execute(
            "SELECT base,fence,validated FROM attempt WHERE head=?", (head,)).fetchone()
        active, current_fence = db.execute("SELECT head,fence FROM session").fetchone()
        if not validated:
            raise Rejected("candidate is not validated")
        if fence != current_fence:
            raise Rejected("stale writer fence")
        if base != active:
            raise Rejected("stale base")
        db.execute("UPDATE session SET head=?", (head,))
        db.execute("INSERT INTO receipt VALUES(?,?)", (head, head))
        db.execute("INSERT INTO search_work SELECT head,event,descriptor FROM member WHERE head=?", (head,))
        if pause == "before-commit":
            pause_for_parent(pause)
    if pause == "after-commit":
        pause_for_parent(pause)
    return head


def visible(path, search=False):
    with connect(path) as db:
        join = "JOIN search_index i ON i.event=m.event AND i.descriptor=m.descriptor" if search else ""
        return [r[0] for r in db.execute(
            "SELECT m.event FROM member m JOIN session s ON s.head=m.head " + join + " ORDER BY m.event")]


def index_work(path, head):
    with connect(path) as db:
        db.execute("INSERT OR IGNORE INTO search_index SELECT event,descriptor FROM search_work WHERE head=?",
                   (head,))


def ready(path, events):
    head = begin(path, current(path))
    seal(path, head, [upload(path, head, i, event) for i, event in enumerate(events)])
    validate(path, head)
    return head


def rejected(reason, operation):
    try:
        operation()
    except Rejected as error:
        assert str(error) == reason, (reason, str(error))
        print("PASS rejection:", reason)
    else:
        raise AssertionError("expected rejection: " + reason)


def kill_at(path, head, boundary, old_view):
    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                                "--activate", str(path), str(head), boundary],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True)
    try:
        readable, _, _ = select.select([process.stdout], [], [], 10)
        assert readable, "child did not reach crash boundary"
        assert process.stdout.readline().strip() == boundary
        if boundary == "before-commit":
            # Independent reader while the writer's transaction is still open.
            assert visible(path) == old_view
        process.send_signal(signal.SIGKILL)
        _, stderr = process.communicate(timeout=10)
        assert process.returncode == -signal.SIGKILL, stderr
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=10)


def main():
    print("MODEL ONLY: ADR-0025 explicit replacement; real SQLite transactions and subprocess SIGKILL")
    with tempfile.TemporaryDirectory(prefix="atape-publication-probe-") as directory:
        path = Path(directory) / "synthetic-publication.db"
        initialize(path)
        first = ready(path, ["A", "B", "C"])
        assert visible(path) == []  # First publication is not visible before activate.
        activate(path, first)
        index_work(path, first)
        with connect(path) as db:
            db.executemany("INSERT INTO raw VALUES('synthetic-session',?,?)",
                           [(event, "synthetic raw " + event) for event in "ABCD"])
        candidate = begin(path, first)
        a = upload(path, candidate, 0, "A")
        assert upload(path, candidate, 0, "A") == a
        rejected("part replay differs", lambda: upload(path, candidate, 0, "wrong"))
        rejected("candidate is not validated", lambda: activate(path, candidate))
        rejected("candidate is not sealed", lambda: validate(path, candidate))
        rejected("incomplete or mismatching candidate", lambda: seal(path, candidate, [a, "missing-D"]))
        assert visible(path) == ["A", "B", "C"]
        d = upload(path, candidate, 1, "D")
        seal(path, candidate, [a, d])
        seal(path, candidate, [a, d])
        rejected("sealed candidate is immutable", lambda: upload(path, candidate, 2, "E"))
        assert visible(path) == ["A", "B", "C"]
        validate(path, candidate)
        assert visible(path) == ["A", "B", "C"]
        print("PASS staging/seal/validation preserve A/B/C; incomplete target cannot activate")

        kill_at(path, candidate, "before-commit", ["A", "B", "C"])
        assert current(path) == first and visible(path) == ["A", "B", "C"]
        with connect(path) as db:
            assert db.execute("SELECT COUNT(*) FROM receipt WHERE attempt=?", (candidate,)).fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM search_work WHERE head=?", (candidate,)).fetchone()[0] == 0
        print("PASS SIGKILL inside activation rolls back pointer + receipt + Search outbox")

        kill_at(path, candidate, "after-commit", ["A", "B", "C"])
        assert current(path) == candidate and visible(path) == ["A", "D"]
        assert activate(path, candidate) == candidate
        with connect(path) as db:
            assert db.execute("SELECT COUNT(*) FROM search_work WHERE head=?", (candidate,)).fetchone()[0] == 2
        assert visible(path, search=True) == ["A"]
        index_work(path, candidate)
        assert visible(path, search=True) == ["A", "D"]
        print("PASS post-commit SIGKILL retains receipt; Search hides B/C immediately and adds D asynchronously")

        later = ready(path, ["A", "E"])
        activate(path, later)
        assert activate(path, candidate) == candidate
        assert current(path) == later and visible(path) == ["A", "E"]
        index_work(path, candidate)  # A delayed old worker cannot revive D.
        assert visible(path, search=True) == ["A"]
        print("PASS old activate returns its original receipt without rolling back newer A/E")

        stale = ready(path, ["A", "F"])
        fresh = ready(path, ["A", "G"])
        rejected("stale writer fence", lambda: activate(path, stale))
        rejected("stale base", lambda: begin(path, candidate))
        assert current(path) == later
        activate(path, fresh)
        # Descriptor gating also excludes a stale index entry for a retained ID.
        changed = begin(path, fresh)
        seal(path, changed, [upload(path, changed, 0, "A", "v2")])
        validate(path, changed)
        activate(path, changed)
        assert visible(path, search=True) == []
        index_work(path, changed)
        assert visible(path, search=True) == ["A"]
        with connect(path) as db:
            assert db.execute("SELECT object FROM raw ORDER BY object").fetchall() == [(x,) for x in "ABCD"]
        print("PASS fence/base guards, current Search descriptor, and independent historical Raw retention")
    print("ALL MODEL ASSERTIONS PASSED; scratch database removed; production acceptance remains outstanding")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--activate":
        activate(Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
    else:
        main()
