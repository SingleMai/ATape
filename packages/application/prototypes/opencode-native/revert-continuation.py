#!/usr/bin/env python3
"""Native revert -> noReply continuation, always using a NEW isolated fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    here = Path(__file__).resolve().parent
    created = subprocess.run([sys.executable, str(here / "generate.py"), "--binary", str(binary)],
                             capture_output=True, text=True, timeout=120, check=True)
    scratch = Path(created.stdout.splitlines()[0].removeprefix("scratch="))
    manifest = json.loads((scratch / "manifest.json").read_text())
    source = scratch / "source"
    root = manifest["rootID"]
    old_export = scratch / "exports/root-export.json"
    old_bytes = old_export.read_bytes()
    old_export_data = json.loads(old_bytes)
    config = {"autoupdate": False, "share": "disabled", "snapshot": False, "plugin": [],
              "enabled_providers": ["fixture"], "model": "fixture/fixture-model",
              "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible",
                  "options": {"baseURL": "http://127.0.0.1:1/v1", "apiKey": "fixture-not-a-secret"},
                  "models": {"fixture-model": {"name": "Fixture", "limit": {"context": 32768, "output": 4096}}}}}}
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/sh", "LANG": "en_US.UTF-8",
           "HOME": str(source / "home"), "OPENCODE_TEST_HOME": str(source / "home"),
           "XDG_CONFIG_HOME": str(source / "config"), "XDG_DATA_HOME": str(source / "data"),
           "XDG_STATE_HOME": str(source / "state"), "XDG_CACHE_HOME": str(source / "cache"),
           "TMPDIR": str(source / "tmp"), "OPENCODE_CONFIG_CONTENT": json.dumps(config),
           "OPENCODE_AUTH_CONTENT": "{}", "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_PURE": "1",
           "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_AUTOCOMPACT": "1",
           "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
           "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true"}
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    log = (scratch / "continuation-server.log").open("w")
    process = subprocess.Popen([str(binary), "serve", "--hostname", "127.0.0.1", "--port", str(port)],
                               cwd=manifest["projectPath"], env=env, stdout=log, stderr=log)
    evidence = []

    def api(method, path, payload=None):
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
            data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json", "x-opencode-directory": manifest["projectPath"]})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
            evidence.append({"method": method, "path": path, "request": payload, "response": result})
            return result

    def state():
        db = sqlite3.connect(f"file:{manifest['dbPath']}?mode=ro", uri=True)
        value = {}
        for name in ["root", "child", "fork"]:
            sid = manifest[name + "ID"]
            value[name] = {"messages": [r[0] for r in db.execute("SELECT id FROM message WHERE session_id=? ORDER BY id", (sid,))],
                           "parts": [r[0] for r in db.execute("SELECT id FROM part WHERE session_id=? ORDER BY id", (sid,))]}
        value["rootEventTypes"] = dict(db.execute("SELECT type,count(*) FROM event WHERE aggregate_id=? GROUP BY type", (root,)))
        db.close()
        return value

    try:
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError("server exited; inspect continuation-server.log")
            try:
                api("GET", "/global/health")
                break
            except OSError:
                time.sleep(.25)
        else:
            raise RuntimeError("server readiness timeout")
        before = state()
        marked_session = api("POST", f"/session/{root}/revert", {"messageID": manifest["mutableMessageID"]})
        marked = state()
        marked_api = api("GET", f"/session/{root}/message")
        assert marked["root"] == before["root"]
        assert marked_api == old_export_data["messages"]
        new = api("POST", f"/session/{root}/message", {"noReply": True,
            "model": {"providerID": "fixture", "modelID": "fixture-model"},
            "parts": [{"type": "text", "text": "revert 后原生继续：只保留新分支 🧪"}]})
        after = state()
        after_session = api("GET", f"/session/{root}")
        after_api = api("GET", f"/session/{root}/message")
        assert not (set(before["root"]["messages"]) & set(after["root"]["messages"]))
        assert not (set(before["root"]["parts"]) & set(after["root"]["parts"]))
        assert after["root"]["messages"] == [new["info"]["id"]]
        assert before["child"] == after["child"] and before["fork"] == after["fork"]
        assert "revert" not in after_session
        assert old_export.read_bytes() == old_bytes
        result = {"schema": "atape.opencode.native-revert-continuation.v1", "version": manifest["version"],
                  "sourceCommit": manifest["sourceCommit"], "fixtureManifest": str(scratch / "manifest.json"),
                  "rootID": root, "revertMessageID": manifest["mutableMessageID"],
                  "before": before, "afterRevertMarker": marked, "afterContinuation": after,
                  "revertMarker": marked_session.get("revert"), "newMessageID": new["info"]["id"],
                  "oldExportSHA256": hashlib.sha256(old_bytes).hexdigest(), "oldExportUnchanged": True,
                  "oldExportMessageCount": len(old_export_data["messages"]),
                  "sourceMessageCountAfterContinuation": len(after_api),
                  "oldExportIsATapeRaw": False,
                  "scope": "Official APIs only; noReply continuation, no real model, first-message revert removes entire root suffix; no file diff rollback claim."}
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()
        (scratch / "continuation-api-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    exported = subprocess.run([str(binary), "export", root], cwd=manifest["projectPath"], env=env,
                              capture_output=True, text=True, timeout=30, check=True)
    new_export = json.loads(exported.stdout)
    assert new_export["messages"] == after_api
    (scratch / "exports/root-continued-export.json").write_text(exported.stdout)
    result["newOfficialExportMatchesAPI"] = True
    result["apiEvidence"] = str(scratch / "continuation-api-evidence.json")
    output = here / "revert-continuation-results.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(output)
    print(json.dumps({"scratch": str(scratch), "oldRootMessages": len(before["root"]["messages"]),
                      "oldRootParts": len(before["root"]["parts"]), "newRootMessages": len(after["root"]["messages"]),
                      "newRootParts": len(after["root"]["parts"]), "oldExportUnchanged": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
