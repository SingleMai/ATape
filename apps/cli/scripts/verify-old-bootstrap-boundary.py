"""Genuine retained .10 public bootstrap cannot decode a future private ledger."""
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

entry, root = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
process = subprocess.Popen([os.environ["TOOL_UPGRADE_NODE"], entry], cwd=root,
                           env=dict(os.environ, TERM="xterm-256color", ATAPE_RUNTIME_DIRECT="0"),
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
transcript = b""
try:
    deadline = time.monotonic() + 30
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            try:
                transcript += os.read(master, 65536)
            except OSError:
                break
    assert process.poll() not in (None, 0), "Retained old bootstrap unexpectedly recovered an unknown capture ledger"
    while select.select([master], [], [], .05)[0]:
        try:
            transcript += os.read(master, 65536)
        except OSError:
            break
    assert b"migration" in transcript.lower(), transcript[-8000:].decode(errors="replace")
    assert b"Your Projects" not in transcript
    assert termios.tcgetattr(slave) == before
    print(json.dumps({"exit": process.returncode, "oldBootstrapRejectedUnknownCaptureLedger": True,
                      "terminalRestored": True, "fixture": "opaque future private ledger under pending stable update control"}))
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
