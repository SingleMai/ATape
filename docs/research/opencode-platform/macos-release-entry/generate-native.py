#!/usr/bin/env python3
"""Controlled official OpenCode fixture; stdlib only, no test framework.

Run with rtk proxy python3 generate.py --binary /tmp/.../opencode.
Only official HTTP APIs and CLI write source DB; Python SQLite is read-only.
All runtime paths and subprocess credentials are isolated in a new scratch dir.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import resource
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

VERSION = "1.18.30"
COMMIT = "3104c1428ec91f809e5ab86631300de41eb6952e"
MODEL = {"providerID": "fixture", "modelID": "fixture-model"}


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    scratch = Path(tempfile.mkdtemp(prefix="atape-opencode-native-11830-"))
    os.chmod(scratch, 0o700)
    source = scratch / "source"
    project = source / "project"
    project.mkdir(parents=True)
    exports = scratch / "exports"
    exports.mkdir()
    print(f"scratch={scratch}", flush=True)
    model_calls = []

    class Stub(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            model_calls.append({"path": self.path, "stream": body.get("stream"),
                                "messageCount": len(body.get("messages", []))})
            text = "受控本地摘要：fixture 根会话、子会话与工具输出。No real model was called. 🧪"
            self.send_response(200)
            if body.get("stream"):
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for delta, finish in [({"role": "assistant", "content": text}, None), ({}, "stop")]:
                    item = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1,
                            "model": "fixture-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1,
                    "model": "fixture-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}).encode())

    stub = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    config = {"autoupdate": False, "share": "disabled", "snapshot": False,
              "model": "fixture/fixture-model", "small_model": "fixture/fixture-model",
              "enabled_providers": ["fixture"], "plugin": [],
              "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Controlled local fixture",
                  "options": {"baseURL": f"http://127.0.0.1:{stub.server_port}/v1", "apiKey": "fixture-not-a-secret"},
                  "models": {"fixture-model": {"name": "Fixture model", "limit": {"context": 32768, "output": 4096}}}}}}
    # Construct from scratch, never inherit provider keys, auth, proxies or user config.
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/sh", "LANG": "en_US.UTF-8",
           "HOME": str(source / "home"), "OPENCODE_TEST_HOME": str(source / "home"),
           "XDG_CONFIG_HOME": str(source / "config"), "XDG_DATA_HOME": str(source / "data"),
           "XDG_STATE_HOME": str(source / "state"), "XDG_CACHE_HOME": str(source / "cache"),
           "TMPDIR": str(source / "tmp"), "OPENCODE_CONFIG_CONTENT": json.dumps(config),
           "OPENCODE_AUTH_CONTENT": "{}", "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_PURE": "1",
           "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_AUTOCOMPACT": "1",
           "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
           "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true"}
    for name in ["home", "config", "data", "state", "cache", "tmp"]:
        (source / name).mkdir()
    actual_version = subprocess.check_output([str(binary), "--version"], env=env, cwd=project, text=True).strip()
    assert actual_version == VERSION, actual_version
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    log = (scratch / "server.log").open("w")
    process = subprocess.Popen([str(binary), "serve", "--hostname", "127.0.0.1", "--port", str(port)],
                               env=env, cwd=project, stdout=log, stderr=log)
    calls = []
    start = time.monotonic()
    result = {"version": actual_version, "sourceCommit": COMMIT, "platform": platform.platform(),
              "binarySHA256": hashlib.sha256(binary.read_bytes()).hexdigest(), "scratch": str(scratch),
              "dbPath": str(source / "data/opencode/opencode.db"), "projectPath": str(project)}

    def api(method, path, payload=None, record=True):
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
            data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json", "x-opencode-directory": str(project)})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                raw = response.read()
                value = json.loads(raw) if raw else None
                if record:
                    calls.append({"method": method, "path": path, "status": response.status,
                                  "request": payload, "response": value})
                return value
        except urllib.error.HTTPError as error:
            detail = error.read().decode()
            calls.append({"method": method, "path": path, "status": error.code, "request": payload, "error": detail})
            raise RuntimeError(f"{method} {path}: {error.code} {detail}") from error

    try:
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError(f"server exited {process.returncode}; see {scratch}/server.log")
            try:
                api("GET", "/global/health", record=False)
                break
            except (OSError, RuntimeError):
                time.sleep(0.25)
        else:
            raise RuntimeError("server readiness timeout")
        root = api("POST", "/session", {"title": "ATape native fixture 根 🧪"})
        root_id = root["id"]
        result["rootID"] = root_id
        result["requestedProjectPath"] = str(project)
        result["projectPath"] = root["directory"]
        first = api("POST", f"/session/{root_id}/message", {"noReply": True, "model": MODEL,
            "parts": [{"type": "text", "text": "原始文本 A：中文与 emoji 🧪\nsecond line"}]})
        mutable = next(p for p in first["parts"] if p["type"] == "text")
        result.update({"mutableMessageID": first["info"]["id"], "mutablePartID": mutable["id"]})
        changed = {**mutable, "text": "改写文本 B：中文与 emoji 🚀\nsecond line",
                   "metadata": {"atapeFixtureUnknown": {"sentinel": "raw-only-unknown-字段", "nested": [1, True, None]}},
                   "atapeFixtureUnknown": {"sentinel": "raw-only-unknown-字段"}}
        updated = api("PATCH", f"/session/{root_id}/message/{first['info']['id']}/part/{mutable['id']}", changed)
        result["unknownExtensionPreservedInAPI"] = "atapeFixtureUnknown" in updated
        result["openMetadataSentinelPreservedInAPI"] = updated.get("metadata") == changed["metadata"]
        child = api("POST", "/session", {"parentID": root_id, "title": "Native child 子会话"})
        result["childID"] = child["id"]
        api("POST", f"/session/{child['id']}/message", {"noReply": True, "model": MODEL,
            "parts": [{"type": "text", "text": "子会话的受控内容 🧵"}]})
        shell = api("POST", f"/session/{root_id}/shell", {"agent": "build", "model": MODEL,
                                                       "command": "printf 'native tool fixture 中文 🛠️\\n'"})
        result["toolMessageID"] = shell["info"]["id"]
        fork = api("POST", f"/session/{root_id}/fork", {})
        result["forkID"] = fork["id"]
        before_revert = api("GET", f"/session/{root_id}/message")
        api("POST", f"/session/{root_id}/revert", {"messageID": first["info"]["id"]})
        result["revertSession"] = api("GET", f"/session/{root_id}")
        result["revertRetainedMessageCount"] = len(api("GET", f"/session/{root_id}/message"))
        result["beforeRevertMessageCount"] = len(before_revert)
        api("POST", f"/session/{root_id}/unrevert", {})
        try:
            result["compactionAPIResult"] = api("POST", f"/session/{root_id}/summarize", MODEL)
        except Exception as error:
            result["compactionError"] = str(error)
        result["modelStubRequests"] = model_calls
        result["syncHistory"] = api("POST", "/sync/history", {})
        for name in ["root", "child", "fork"]:
            dump(exports / f"{name}-api.json", api("GET", f"/session/{result[name+'ID']}/message"))
        db = sqlite3.connect(f"file:{result['dbPath']}?mode=ro", uri=True)
        result["tables"] = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        result["tableCounts"] = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                                 for table in ["session", "message", "part", "event", "event_sequence", "session_message"]}
        result["journalMode"] = db.execute("PRAGMA journal_mode").fetchone()[0]
        result["unknownExtensionPreservedInDB"] = "atapeFixtureUnknown" in json.loads(db.execute(
            "SELECT data FROM part WHERE id=?", (mutable["id"],)).fetchone()[0])
        db.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()
        dump(scratch / "api-evidence.json", calls)
        result["generationSeconds"] = round(time.monotonic() - start, 3)
        dump(scratch / "manifest.json", result)
    for name in ["root", "child", "fork"]:
        command = subprocess.run([str(binary), "export", result[name + "ID"]], cwd=project, env=env,
                                 text=True, capture_output=True, timeout=45)
        (exports / f"{name}-export.stderr").write_text(command.stderr)
        assert command.returncode == 0, command.stderr
        exported = json.loads(command.stdout)
        dump(exports / f"{name}-export.json", exported)
        expected = json.loads((exports / f"{name}-api.json").read_text())
        assert exported["messages"] == expected, f"API/export mismatch: {name}"
        # Hydrate exactly the official row identities; no hand-created schema/data.
        db = sqlite3.connect(f"file:{result['dbPath']}?mode=ro", uri=True)
        rows = []
        for mid, sid, data in db.execute("SELECT id,session_id,data FROM message WHERE session_id=? ORDER BY time_created,id",
                                        (result[name + "ID"],)):
            info = {**json.loads(data), "id": mid, "sessionID": sid}
            parts = [{**json.loads(data), "id": pid, "sessionID": psid, "messageID": pmid}
                     for pid, psid, pmid, data in db.execute(
                         "SELECT id,session_id,message_id,data FROM part WHERE message_id=? ORDER BY id", (mid,))]
            rows.append({"info": info, "parts": parts})
        db.close()
        assert rows == exported["messages"], f"SQLite/export mismatch: {name}"
    result["officialExportMatchesAPI"] = True
    result["officialExportMatchesSQLite"] = True
    result["sqliteFileBytes"] = Path(result["dbPath"]).stat().st_size
    result["maxChildRSSNativeUnits"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    result["maxChildRSSNote"] = "macOS bytes; max child peak across version/server/export, not incremental collector memory"
    result["modelStubRequests"] = model_calls
    dump(scratch / "manifest.json", result)
    stub.shutdown()
    print(json.dumps({k: v for k, v in result.items() if k not in ["syncHistory", "revertSession"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
