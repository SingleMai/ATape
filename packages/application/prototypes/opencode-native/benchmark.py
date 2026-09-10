#!/usr/bin/env python3
"""Three-run small-fixture comparison; Darwin /usr/bin/time -l per-process RSS.

rtk proxy python3 benchmark.py --manifest /scratch/manifest.json --binary /scratch/opencode
SQLite route is Python stdlib, NOT the production Node Collector implementation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sqlite3
import subprocess
import sys
import tempfile
import time


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sqlite_child(manifest):
    db = sqlite3.connect(f"file:{manifest['dbPath']}?mode=ro", uri=True)
    db.execute("BEGIN")
    hydrated = {}
    source_json_bytes = 0
    messages = parts = 0
    for name in ["root", "child", "fork"]:
        hydrated[name] = []
        for mid, sid, data in db.execute(
            "SELECT id,session_id,data FROM message WHERE session_id=? ORDER BY time_created,id",
            (manifest[name + "ID"],),
        ):
            messages += 1
            source_json_bytes += len(data.encode())
            info = {**json.loads(data), "id": mid, "sessionID": sid}
            hydrated_parts = []
            for pid, psid, pmid, pdata in db.execute(
                "SELECT id,session_id,message_id,data FROM part WHERE message_id=? ORDER BY id", (mid,),
            ):
                parts += 1
                source_json_bytes += len(pdata.encode())
                hydrated_parts.append({**json.loads(pdata), "id": pid, "sessionID": psid, "messageID": pmid})
            hydrated[name].append({"info": info, "parts": hydrated_parts})
    db.close()
    sys.stdout.buffer.write(encoded({"messages": hydrated, "sourceRowJSONBytes": source_json_bytes,
                                    "messageRows": messages, "partRows": parts}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("benchmark-results.json"))
    parser.add_argument("--sqlite-child", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    if args.sqlite_child:
        sqlite_child(manifest)
        return
    assert platform.system() == "Darwin", "RSS units/parser verified only on Darwin"
    assert args.binary is not None
    binary = args.binary.resolve()
    scratch = Path(manifest["scratch"])
    source = scratch / "source"
    # No inherited credentials, user config, proxy, or provider endpoint.
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/sh", "LANG": "en_US.UTF-8",
           "HOME": str(source / "home"), "OPENCODE_TEST_HOME": str(source / "home"),
           "XDG_CONFIG_HOME": str(source / "config"), "XDG_DATA_HOME": str(source / "data"),
           "XDG_STATE_HOME": str(source / "state"), "XDG_CACHE_HOME": str(source / "cache"),
           "TMPDIR": str(source / "tmp"), "OPENCODE_AUTH_CONTENT": "{}",
           "OPENCODE_CONFIG_CONTENT": json.dumps({"autoupdate": False, "share": "disabled", "snapshot": False,
                                                 "enabled_providers": [], "plugin": []}),
           "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_PURE": "1",
           "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_AUTOCOMPACT": "1",
           "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
           "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true"}
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == manifest["binarySHA256"]
    timing_dir = Path(tempfile.mkdtemp(prefix="benchmark-", dir=scratch))

    def measured(command, label):
        timing_file = timing_dir / f"{label}.time"
        start = time.perf_counter()
        process = subprocess.run(["/usr/bin/time", "-l", "-o", str(timing_file), *command],
                                 cwd=manifest["projectPath"], env=env, capture_output=True, timeout=45)
        wall_ms = round((time.perf_counter() - start) * 1000, 3)
        stderr = process.stderr.decode()
        assert process.returncode == 0, stderr
        raw = timing_file.read_text()
        match = re.search(r"(\d+)\s+maximum resident set size", raw)
        assert match, raw
        real = re.search(r"([\d.]+)\s+real", raw)
        metadata = {"label": label, "wallMs": wall_ms, "timeRealSeconds": float(real.group(1)),
                    "peakRSSBytes": int(match.group(1)), "stdoutBytes": len(process.stdout),
                    "stderrBytes": len(process.stderr)}
        for label_key, suffix in [("blockInputs", "block input operations"), ("blockOutputs", "block output operations")]:
            found = re.search(r"(\d+)\s+" + suffix, raw)
            metadata[label_key] = int(found.group(1)) if found else None
        return process.stdout, metadata

    results = {"schema": "atape.opencode.native-route-benchmark.v1", "sourceVersion": manifest["version"],
               "sourceCommit": manifest["sourceCommit"], "binarySHA256": manifest["binarySHA256"],
               "platform": platform.platform(), "pythonVersion": platform.python_version(),
               "fixtureManifest": str(args.manifest.resolve()), "sqliteMainFileBytes": Path(manifest["dbPath"]).stat().st_size,
               "rawTimingDirectory": str(timing_dir), "runs": [],
               "scope": "Small cached fixture; 3 fresh-process runs, alternating route order; no cold-cache flush, no production-scale claim.",
               "rssMeaning": "Darwin time -l per child process, bytes. Route peak is max sequential child peak, never cumulative children max.",
               "bytesMeaning": "sourceRowJSONBytes counts SQLite JSON data columns only; stdoutBytes counts producer output; normalizedMessagesBytes uses identical hydrated messages. None is physical disk bytes read.",
               "fairnessLimits": "SQLite Python process hydrates all three sessions; export starts one native process per session and additionally emits session info. Parent normalization/checking memory excluded for both. No persistent server/SDK baseline."}
    for run in range(1, 4):
        entry = {"run": run}
        order = ["sqlite", "export"] if run % 2 else ["export", "sqlite"]
        entry["order"] = order
        payloads = {}
        for route in order:
            route_start = time.perf_counter()
            if route == "sqlite":
                raw, metric = measured([sys.executable, str(Path(__file__).resolve()), "--manifest",
                                        str(args.manifest.resolve()), "--sqlite-child"], f"{run}-sqlite")
                payload = json.loads(raw)
                payloads[route] = payload["messages"]
                metrics = [metric]
                extra = {k: payload[k] for k in ["sourceRowJSONBytes", "messageRows", "partRows"]}
            else:
                payloads[route] = {}
                metrics = []
                for name in ["root", "child", "fork"]:
                    raw, metric = measured([str(binary), "export", manifest[name + "ID"]], f"{run}-export-{name}")
                    payloads[route][name] = json.loads(raw)["messages"]
                    metrics.append(metric)
                extra = {}
            normalized = encoded(payloads[route])
            entry[route] = {"routeWallMs": round((time.perf_counter() - route_start) * 1000, 3),
                            "sumProcessWallMs": round(sum(p["wallMs"] for p in metrics), 3),
                            "peakProcessRSSBytes": max(p["peakRSSBytes"] for p in metrics),
                            "stdoutBytes": sum(p["stdoutBytes"] for p in metrics),
                            "normalizedMessagesBytes": len(normalized), "normalizedSHA256": hashlib.sha256(normalized).hexdigest(),
                            "processes": metrics, **extra}
        assert payloads["sqlite"] == payloads["export"], "Routes returned different message content"
        entry["messagesExactlyEqual"] = True
        results["runs"].append(entry)
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(args.output.resolve())
    for entry in results["runs"]:
        print(entry["run"], {route: {key: entry[route][key] for key in
              ["routeWallMs", "peakProcessRSSBytes", "stdoutBytes", "normalizedMessagesBytes"]} for route in ["sqlite", "export"]})


if __name__ == "__main__":
    main()
