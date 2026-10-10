"""Actual installed start with a synthetic native child and disposable state."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

request = json.load(sys.stdin)
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
args = [request["node"], request["binary"], "start", "--tool", "cursor", "--project", request["projectId"],
        "--prompt=--literal 中文 CursorStartNeedle"]
process = subprocess.Popen(args, cwd=request["cwd"], env=dict(os.environ, TERM="xterm-256color"),
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()
verified = False

def drain(wait=.05):
    if select.select([master], [], [], wait)[0]:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            return
    assert len(output) <= 1024 * 1024, "Cursor PTY output exceeded its bound"

try:
    deadline = time.monotonic() + 60
    ready = Path(request["readyFile"])
    while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
        drain()
    assert ready.exists(), "Installed start did not launch the synthetic native child: " + output[-6000:].decode(errors="replace")
    child = json.loads(ready.read_text())
    if request.get("managedEntry"):
        parent = subprocess.check_output(["/bin/ps", "-p", str(child["parentPid"]), "-o", "command="], timeout=5).decode()
        assert request["managedEntry"] in parent, "Installed bootstrap did not delegate start to the selected managed runtime: " + parent
    if request["mode"] == "cancel":
        # Parent-only cancellation is deliberate. openpty does not establish a
        # foreground controlling group, so a literal Ctrl+C is not an OS signal.
        process.send_signal(signal.SIGINT)
    else:
        os.write(master, b"finish\n")
    while process.poll() is None and time.monotonic() < deadline:
        drain()
    assert process.poll() is not None, "Installed start did not join its native child: " + output[-6000:].decode(errors="replace")
    while select.select([master], [], [], 0)[0]:
        drain(0)
    assert termios.tcgetattr(slave) == before, "Installed start did not restore exact terminal attributes"
    try:
        os.kill(child["pid"], 0)
    except ProcessLookupError:
        pass
    else:
        raise AssertionError("Installed start left its immediate native child alive")
    expected = 130 if request["mode"] == "cancel" else 7 if request["mode"] in ("failed", "confirmed-failed") else 0
    assert process.returncode == expected, (process.returncode, expected, output[-6000:].decode(errors="replace"))
    print(json.dumps({"exitCode": process.returncode, "output": output.decode(errors="replace"),
                      "terminalRestored": True, "childJoined": True,
                      "managedDelegation": bool(request.get("managedEntry")), **child}))
    verified = True
finally:
    if not verified:
        # Only the fixture's own process group is cleaned up on fixture failure.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.wait()
    os.close(master)
    os.close(slave)
