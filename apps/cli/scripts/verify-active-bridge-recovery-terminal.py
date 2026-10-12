"""Recover through the genuine unchanged public npm bootstrap in a real PTY."""
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

entry, root, version = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
process = subprocess.Popen([os.environ["TOOL_UPGRADE_NODE"], entry], cwd=root,
                           env=dict(os.environ, TERM="xterm-256color", ATAPE_RUNTIME_DIRECT="0"),
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
transcript = b""
output = b""

def drain():
    global transcript, output
    if select.select([master], [], [], .1)[0]:
        try:
            chunk = os.read(master, 65536)
            transcript += chunk
            output += chunk
        except OSError:
            pass

def wait(text, timeout=60):
    global output
    deadline = time.monotonic() + timeout
    while text not in output and time.monotonic() < deadline and process.poll() is None:
        drain()
    assert text in output, "Missing " + repr(text) + ": " + transcript[-8000:].decode(errors="replace")
    value = output
    output = b""
    return value

try:
    # The header precedes asynchronous Project loading. Navigate only once the
    # actual keyboard actions are rendered, and observe each focus transition.
    wait(b"Tab Actions")
    assert b"Your Projects" in transcript
    assert b"Upgrade now or skip for this session." not in transcript, "Recovery required a manual upgrade choice"
    os.write(master, b"\t")
    wait(b"Actions: Tools and updates")
    os.write(master, b"\r")
    tools = wait(b"Check again")
    assert b"ATape: " + version.encode() in tools, tools[-8000:].decode(errors="replace")
    os.write(master, b"\x1b")
    wait(b"Your Projects")
    os.write(master, b"q")
    deadline = time.monotonic() + 15
    while process.poll() is None and time.monotonic() < deadline:
        drain()
    assert process.poll() == 0, transcript[-8000:].decode(errors="replace")
    assert termios.tcgetattr(slave) == before, "Recovered console did not restore terminal attributes"
    print(json.dumps({"actualPublicBootstrapRecovery": True, "selectedVersionShown": version,
                      "terminalRestored": True, "exit": process.returncode}))
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
