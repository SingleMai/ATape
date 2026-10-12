"""Real installed CLI console upgrade/rebind acceptance, confined to disposable HOME."""
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

entry, root, phase, version = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
process = subprocess.Popen([os.environ["TOOL_UPGRADE_NODE"], entry], cwd=root, env=dict(os.environ, TERM="xterm-256color", ATAPE_RUNTIME_DIRECT="1" if phase == "old-fenced" else "0"),
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = b""
transcript = b""

def drain(seconds=.1):
    global output, transcript
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], min(.05, max(0, deadline-time.monotonic())))[0]:
            try:
                chunk = os.read(master, 65536)
                output += chunk
                transcript += chunk
            except OSError:
                break

def wait(text, timeout=60):
    global output
    deadline = time.monotonic() + timeout
    while text.encode() not in output and time.monotonic() < deadline and process.poll() is None:
        drain()
    assert text.encode() in output, "Missing " + repr(text) + ": " + output[-8000:].decode(errors="replace")
    value = output
    output = b""
    return value

def send(keys):
    for key in keys:
        os.write(master, key.encode())
        drain()

try:
    if phase == "old-fenced":
        deadline = time.monotonic() + 30
        while process.poll() is None and time.monotonic() < deadline:
            drain()
        drain()
        assert process.poll() not in (None, 0), "Old executable unexpectedly retained reader/writer admission"
        assert b"durable recovery boundary" in transcript or b"reopen ATape" in transcript, transcript[-8000:].decode(errors="replace")
        assert b"Your Projects" not in transcript
        assert termios.tcgetattr(slave) == before
        print(json.dumps({"phase": phase, "exit": process.returncode, "oldRuntimeRejected": True, "terminalRestored": True}))
    else:
        deadline = time.monotonic() + 30
        while b"Your Projects" not in output and b"Upgrade now or skip for this session." not in output and time.monotonic() < deadline and process.poll() is None:
            drain()
        if b"Upgrade now or skip for this session." in output:
            output = b""
            send(["\x1b[B", "\r"])
        wait("Your Projects")
        send(["\t", "\r"])
        tools = wait("Check again")
        assert b"Tools and updates" in tools
        if phase == "reject":
            assert ("Update ATape to " + version).encode() in tools, tools.decode(errors="replace")
            send(["\r"])
            failed = wait("Update could not finish", 120)
            assert b"Could not prepare an official Adapter" in failed or b"Invalid atapeAdapter manifest" in failed or b"capture migration prerequisites" in failed or b"capture prerequisites" in failed or b"update handoff failed" in failed, failed.decode(errors="replace")
            send(["\x1b"])
            wait("Check again")
            send(["\x1b"])
            wait("Your Projects")
        elif phase == "rebound":
            assert b"ATape: " + version.encode() in tools, tools.decode(errors="replace")
            assert ("Update Codex sync to " + version).encode() in tools or ("Update ATape to " + version).encode() in tools
            send(["\x1b"])
            wait("Your Projects")
        elif phase == "complete":
            assert ("Update ATape to " + version).encode() in tools, tools.decode(errors="replace")
            send(["\r"])
            # Successful complete-bundle update closes the first console and opens
            # the installed generation through the existing restart Interface.
            wait("Your Projects", 120)
            send(["\t", "\r"])
            current = wait("Check again")
            assert b"Codex sync: " + version.encode() in current, current.decode(errors="replace")
            assert ("Update matching official integrations for ATape " + version).encode() not in current
            send(["\x1b"])
            wait("Your Projects")
        else:
            raise AssertionError("Unknown PTY acceptance phase")
        send(["q"])
        deadline = time.monotonic() + 15
        while process.poll() is None and time.monotonic() < deadline:
            drain()
        assert process.poll() == 0, "Console did not exit: " + transcript[-8000:].decode(errors="replace")
        assert termios.tcgetattr(slave) == before, "terminal attributes were not restored"
        print(json.dumps({"phase": phase, "terminalRestored": True, "exit": process.returncode,
                          "rejectionVisible": phase == "reject", "versionShown": version if phase == "rebound" else "0.5.9"}))
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
