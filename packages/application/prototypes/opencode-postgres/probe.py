"""Disposable HTTP protocol experiment backed by REAL PostgreSQL transactions.

Deliberately independent of ATape production Interfaces. See README.md for scope.
The only supported entry point is run.py, which provisions an empty scratch DB.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from http.client import RemoteDisconnected
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import socket
import sys
import threading
import traceback
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import psycopg

DSN = os.environ["PROBE_PG_DSN"]
SCENARIOS = []
FAULT_READY = threading.Event()
FAULT_RELEASE = threading.Event()
FAULT_PID = None
ACTIVATE_BARRIER = None
RACE_PIDS = []


class Rejected(Exception):
    pass


def db():
    return psycopg.connect(DSN, connect_timeout=5, application_name="atape-disposable-probe")


def initialize():
    with db() as connection:
        assert connection.execute("SELECT current_database()").fetchone()[0] == "atape_publication_probe"
        assert connection.execute("SELECT count(*) FROM pg_tables WHERE schemaname='public'").fetchone()[0] == 0
        connection.execute("""
        CREATE TABLE session(id text PRIMARY KEY, head bigint, fence bigint NOT NULL,
          lifecycle bigint NOT NULL, raw_fence bigint NOT NULL, raw_allowed boolean NOT NULL,
          visible_count integer NOT NULL);
        INSERT INTO session VALUES('fixture',NULL,0,1,1,true,0);
        CREATE TABLE attempt(head bigserial PRIMARY KEY, base bigint, fence bigint,
          lifecycle bigint, sealed boolean DEFAULT false, validated boolean DEFAULT false,
          manifest jsonb);
        CREATE TABLE part(head bigint REFERENCES attempt, number integer, body jsonb,
          digest text, PRIMARY KEY(head,number));
        CREATE TABLE member(head bigint REFERENCES attempt, event text, descriptor text,
          PRIMARY KEY(head,event));
        CREATE TABLE receipt(attempt bigint PRIMARY KEY REFERENCES attempt,
          activated_head bigint, lifecycle bigint);
        CREATE TABLE search_work(head bigint REFERENCES attempt, event text, descriptor text,
          PRIMARY KEY(head,event));
        CREATE TABLE search_index(event text, descriptor text, PRIMARY KEY(event,descriptor));
        CREATE TABLE raw_receipt(object text PRIMARY KEY, capture bigint REFERENCES receipt(attempt),
          lifecycle bigint, raw_fence bigint);
        """)


def digest(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def dispatch(operation, data):
    global FAULT_PID
    with db() as connection:
        pid = connection.execute("SELECT pg_backend_pid()").fetchone()[0]
        if operation == "begin":
            active, fence, lifecycle = connection.execute(
                "SELECT head,fence,lifecycle FROM session WHERE id='fixture' FOR UPDATE").fetchone()
            if data["base"] != active:
                raise Rejected("stale base")
            connection.execute("UPDATE session SET fence=fence+1 WHERE id='fixture'")
            head = connection.execute("INSERT INTO attempt(base,fence,lifecycle) VALUES(%s,%s,%s) RETURNING head",
                                      (active, fence + 1, lifecycle)).fetchone()[0]
            return {"head": head, "base": active, "fence": fence + 1, "backend_pid": pid}
        if operation == "part":
            head, number, body = data["head"], data["number"], data["body"]
            sealed = connection.execute("SELECT sealed FROM attempt WHERE head=%s FOR UPDATE", (head,)).fetchone()[0]
            if sealed:
                raise Rejected("sealed candidate")
            fingerprint = digest(body)
            old = connection.execute("SELECT digest FROM part WHERE head=%s AND number=%s", (head, number)).fetchone()
            if old and old[0] != fingerprint:
                raise Rejected("part replay differs")
            connection.execute("INSERT INTO part VALUES(%s,%s,%s::jsonb,%s) ON CONFLICT DO NOTHING",
                               (head, number, json.dumps(body), fingerprint))
            return {"digest": fingerprint}
        if operation == "seal":
            head = data["head"]
            sealed, old_manifest = connection.execute(
                "SELECT sealed,manifest FROM attempt WHERE head=%s FOR UPDATE", (head,)).fetchone()
            if sealed:
                if old_manifest != data["manifest"]:
                    raise Rejected("seal replay differs")
                return {"sealed": True}
            actual = connection.execute("SELECT number,digest FROM part WHERE head=%s ORDER BY number", (head,)).fetchall()
            if actual != list(enumerate(data["manifest"])):
                raise Rejected("incomplete candidate")
            connection.execute("UPDATE attempt SET sealed=true,manifest=%s::jsonb WHERE head=%s",
                               (json.dumps(data["manifest"]), head))
            return {"sealed": True}
        if operation == "validate":
            head = data["head"]
            sealed, validated = connection.execute(
                "SELECT sealed,validated FROM attempt WHERE head=%s FOR UPDATE", (head,)).fetchone()
            if not sealed:
                raise Rejected("not sealed")
            if not validated:
                bodies = [row[0] for row in connection.execute("SELECT body FROM part WHERE head=%s", (head,))]
                if len({body["event"] for body in bodies}) != len(bodies):
                    raise Rejected("duplicate event")
                with connection.cursor() as cursor:
                    cursor.executemany("INSERT INTO member VALUES(%s,%s,%s)",
                                       [(head, body["event"], body["descriptor"]) for body in bodies])
                connection.execute("UPDATE attempt SET validated=true WHERE head=%s", (head,))
            return {"validated": True}
        if operation == "activate":
            head = data["head"]
            if data.get("race"):
                RACE_PIDS.append(pid)
                ACTIVATE_BARRIER.wait(timeout=10)
            # Serialize competing writers and replay against the stable Session.
            active, fence, lifecycle = connection.execute(
                "SELECT head,fence,lifecycle FROM session WHERE id='fixture' FOR UPDATE").fetchone()
            receipt = connection.execute("SELECT activated_head,lifecycle FROM receipt WHERE attempt=%s", (head,)).fetchone()
            if receipt:
                if receipt[1] != lifecycle:
                    raise Rejected("changed lifecycle")
                return {"receipt": receipt[0], "replay": True, "backend_pid": pid}
            base, candidate_fence, candidate_lifecycle, validated = connection.execute(
                "SELECT base,fence,lifecycle,validated FROM attempt WHERE head=%s", (head,)).fetchone()
            if not validated:
                raise Rejected("not validated")
            if candidate_lifecycle != lifecycle:
                raise Rejected("changed lifecycle")
            if base != active:
                raise Rejected("stale base")
            if candidate_fence != fence:
                raise Rejected("stale fence")
            connection.execute("UPDATE session SET head=%s,visible_count=(SELECT count(*) FROM member WHERE head=%s)",
                               (head, head))
            connection.execute("INSERT INTO receipt VALUES(%s,%s,%s)", (head, head, lifecycle))
            connection.execute("INSERT INTO search_work SELECT head,event,descriptor FROM member WHERE head=%s", (head,))
            if data.get("fault") == "terminate-before-commit":
                FAULT_PID = pid
                FAULT_READY.set()
                if not FAULT_RELEASE.wait(timeout=10):
                    raise RuntimeError("fault controller timed out")
                connection.execute("SELECT 1")  # Raises after real backend termination.
            return {"receipt": head, "replay": False, "backend_pid": pid}
        if operation == "view":
            # A single SQL statement snapshots the head, count and target members.
            head, count, members = connection.execute("""
                SELECT s.head,s.visible_count,COALESCE(jsonb_agg(m.event ORDER BY m.event)
                  FILTER(WHERE m.event IS NOT NULL),'[]'::jsonb)
                FROM session s LEFT JOIN member m ON m.head=s.head
                GROUP BY s.head,s.visible_count
                """).fetchone()
            if "expected_head" in data and data["expected_head"] != head:
                raise Rejected("refresh required")
            return {"head": head, "count": count, "events": members}
        if operation == "search":
            return {"events": [row[0] for row in connection.execute("""
                SELECT m.event FROM session s JOIN member m ON m.head=s.head
                JOIN search_index i ON i.event=m.event AND i.descriptor=m.descriptor ORDER BY m.event
                """)]}
        if operation == "index":
            connection.execute("INSERT INTO search_index SELECT event,descriptor FROM search_work WHERE head=%s ON CONFLICT DO NOTHING",
                               (data["head"],))
            return {"indexed": data["head"]}
        if operation == "raw-authorize":
            # No object store: check only independent authority and activated proof.
            lifecycle, raw_fence, allowed = connection.execute(
                "SELECT lifecycle,raw_fence,raw_allowed FROM session WHERE id='fixture' FOR UPDATE").fetchone()
            receipt = connection.execute("SELECT lifecycle FROM receipt WHERE attempt=%s", (data["capture"],)).fetchone()
            if not receipt or receipt[0] != lifecycle:
                raise Rejected("capture not activated in current lifecycle")
            if not allowed or data["raw_fence"] != raw_fence:
                raise Rejected("raw authority rejected")
            connection.execute("INSERT INTO raw_receipt VALUES(%s,%s,%s,%s)",
                               (data["object"], data["capture"], lifecycle, raw_fence))
            return {"authorized_capture": data["capture"]}
        raise Rejected("unknown prototype operation")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            result = dispatch(self.path.removeprefix("/"), data)
            if data.get("fault") == "drop-after-commit":
                # dispatch's transaction context has COMMITTED before this close.
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                self.close_connection = True
                return
            status = 200
        except Rejected as error:
            result, status = {"error": str(error)}, 409
        except psycopg.Error as error:
            result, status = {"error": type(error).__name__}, 503
        except Exception as error:
            result, status = {"error": type(error).__name__, "detail": str(error)}, 500
        body = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def request(operation, data=None, expected=200):
    call = Request(URL + "/" + operation, json.dumps(data or {}).encode(), {"Content-Type": "application/json"})
    try:
        response = urlopen(call, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        result = json.loads(response.read())
        assert response.status == expected, (operation, response.status, result)
    return result


def reject(operation, data, reason):
    result = request(operation, data, expected=409)
    assert result["error"] == reason, result
    return result


def record(name, **evidence):
    SCENARIOS.append({"name": name, "status": "passed", "evidence": evidence})
    print("PASS", name, flush=True)


def view(events, head=None):
    result = request("view")
    assert result["events"] == events and result["count"] == len(events), result
    if head is not None:
        assert result["head"] == head, result
    return result


def candidate(events):
    head = request("begin", {"base": request("view")["head"]})["head"]
    manifest = [request("part", {"head": head, "number": number,
                 "body": {"event": event, "descriptor": "v1"}})["digest"] for number, event in enumerate(events)]
    request("seal", {"head": head, "manifest": manifest})
    request("validate", {"head": head})
    return head


def run():
    global ACTIVATE_BARRIER
    first = candidate(["A", "B", "C"])
    view([])
    request("activate", {"head": first})
    request("index", {"head": first})
    view(["A", "B", "C"], first)
    replacement = request("begin", {"base": first})["head"]
    a = request("part", {"head": replacement, "number": 0, "body": {"event": "A", "descriptor": "v1"}})["digest"]
    reject("seal", {"head": replacement, "manifest": [a, "missing-D"]}, "incomplete candidate")
    reject("activate", {"head": replacement}, "not validated")
    view(["A", "B", "C"], first)
    d = request("part", {"head": replacement, "number": 1, "body": {"event": "D", "descriptor": "v1"}})["digest"]
    request("seal", {"head": replacement, "manifest": [a, d]})
    view(["A", "B", "C"], first)
    request("validate", {"head": replacement})
    view(["A", "B", "C"], first)
    record("replacement-staging-and-incomplete-target", old_head=first, candidate=replacement,
           visible_during_prepare=["A", "B", "C"], first_publication_invisible=True)

    with ThreadPoolExecutor(max_workers=1) as executor:
        response = executor.submit(request, "activate", {"head": replacement, "fault": "terminate-before-commit"}, 503)
        assert FAULT_READY.wait(timeout=10)
        try:
            view(["A", "B", "C"], first)
            with db() as control:
                assert control.execute("SELECT count(*) FROM receipt WHERE attempt=%s", (replacement,)).fetchone()[0] == 0
                assert control.execute("SELECT count(*) FROM search_work WHERE head=%s", (replacement,)).fetchone()[0] == 0
                assert control.execute("SELECT pg_terminate_backend(%s)", (FAULT_PID,)).fetchone()[0]
        finally:
            FAULT_RELEASE.set()
        assert response.result(timeout=15)["error"] in ("AdminShutdown", "OperationalError")
    view(["A", "B", "C"], first)
    with db() as connection:
        assert connection.execute("SELECT count(*) FROM receipt WHERE attempt=%s", (replacement,)).fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM search_work WHERE head=%s", (replacement,)).fetchone()[0] == 0
    record("activation-backend-terminated-before-commit", backend_pid=FAULT_PID,
           pointer_receipt_search_work_rolled_back=True)

    try:
        request("activate", {"head": replacement, "fault": "drop-after-commit"})
    except RemoteDisconnected:
        pass
    else:
        raise AssertionError("HTTP response was not lost")
    view(["A", "D"], replacement)
    receipt = request("activate", {"head": replacement})
    assert receipt["receipt"] == replacement and receipt["replay"]
    with db() as connection:
        assert connection.execute("SELECT count(*) FROM receipt WHERE attempt=%s", (replacement,)).fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM search_work WHERE head=%s", (replacement,)).fetchone()[0] == 2
    assert request("search")["events"] == ["A"]
    request("index", {"head": replacement})
    assert request("search")["events"] == ["A", "D"]
    record("http-response-lost-after-commit", recovered_receipt=replacement,
           receipt_count=1, durable_search_work=2, search_before_index=["A"], search_after_index=["A", "D"])

    later = candidate(["A", "E"])
    request("activate", {"head": later})
    assert request("activate", {"head": replacement})["receipt"] == replacement
    view(["A", "E"], later)
    reject("view", {"expected_head": replacement}, "refresh required")
    request("index", {"head": replacement})
    assert request("search")["events"] == ["A"]
    record("old-receipt-and-old-reader-after-new-head", old_receipt=replacement, current_head=later,
           stale_reader="refresh required", delayed_worker_cannot_revive="D")

    first_racer = candidate(["A", "F"])
    second_racer = candidate(["A", "G"])
    # Explicitly test the fence guard before a newer activation changes the base.
    reject("activate", {"head": first_racer}, "stale fence")
    ACTIVATE_BARRIER = threading.Barrier(2)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(request, "activate", {"head": first_racer, "race": True}, 409),
                   executor.submit(request, "activate", {"head": second_racer, "race": True}, 200)]
        conflict, winner = [future.result(timeout=15) for future in futures]
    assert conflict["error"] in ("stale fence", "stale base")
    assert len(RACE_PIDS) == 2 and len(set(RACE_PIDS)) == 2, RACE_PIDS
    view(["A", "G"], second_racer)
    reject("activate", {"head": first_racer}, "stale base")
    reject("begin", {"base": later}, "stale base")
    record("independent-connections-compete", winner=second_racer, rejected=first_racer,
           race_conflict=conflict["error"], winner_backend_pid=winner["backend_pid"],
           contender_backend_pids=RACE_PIDS,
           two_connections_synchronized_before_session_lock=True,
           separate_stale_fence_and_base_assertions=True)

    changed = request("begin", {"base": second_racer})["head"]
    part = request("part", {"head": changed, "number": 0, "body": {"event": "A", "descriptor": "v2"}})
    request("seal", {"head": changed, "manifest": [part["digest"]]})
    request("validate", {"head": changed})
    request("activate", {"head": changed})
    assert request("search")["events"] == []
    request("index", {"head": replacement})
    assert request("search")["events"] == []
    request("index", {"head": changed})
    assert request("search")["events"] == ["A"]
    record("search-current-membership-and-descriptor", changed_event="A", old_descriptor="v1",
           current_descriptor="v2", stale_index_filtered=True, asynchronous_new_index=True)

    raw = request("raw-authorize", {"capture": replacement, "object": "old-observation", "raw_fence": 1})
    assert raw["authorized_capture"] == replacement and request("view")["head"] == changed
    unactivated = candidate(["Z"])
    reject("raw-authorize", {"capture": unactivated, "object": "not-activated", "raw_fence": 1},
           "capture not activated in current lifecycle")
    reject("raw-authorize", {"capture": replacement, "object": "stale-raw-fence", "raw_fence": 0},
           "raw authority rejected")
    record("old-activated-capture-retains-independent-raw-authority", capture=replacement,
           current_head=changed, raw_fence=1, unactivated_capture_rejected=True, stale_raw_fence_rejected=True,
           object_store_used=False)


if __name__ == "__main__":
    result = {"status": "failed", "started_at": datetime.now(timezone.utc).isoformat(),
              "python": platform.python_version(), "psycopg": psycopg.__version__, "scenarios": SCENARIOS,
              "not_covered": ["ATape production Interface/authorization", "native OpenCode/Collector",
                              "lease/reservation/receipt expiry and unknown reconciliation", "quotas and bounded/resumable validation",
                              "PostgreSQL host restart/power loss", "Raw object bytes/storage/recovery", "patch targets",
                              "full Search outbox worker progress", "large scale performance and supported-platform acceptance"]}
    server = None
    try:
        initialize()
        with db() as connection:
            result["postgres_version"] = connection.execute("SELECT version()").fetchone()[0]
            result["postgres_isolation"] = connection.execute("SHOW transaction_isolation").fetchone()[0]
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        URL = "http://127.0.0.1:" + str(server.server_address[1])
        threading.Thread(target=server.serve_forever, daemon=True).start()
        run()
        result["status"] = "passed"
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
        traceback.print_exc()
    finally:
        if server:
            server.shutdown()
            server.server_close()
        result["finished_at"] = datetime.now(timezone.utc).isoformat()
        Path(sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    sys.exit(0 if result["status"] == "passed" else 1)
