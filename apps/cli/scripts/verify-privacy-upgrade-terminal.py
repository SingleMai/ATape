"""Settings entry acceptance through a genuine old/new npm bootstrap, in a disposable HOME."""
import fcntl
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
process = subprocess.Popen([os.environ["PRIVACY_FIXTURE_NODE"], entry], cwd=root, env=dict(os.environ, TERM="xterm-256color"),
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = b""
stage = "opening the installed console"

def drain(seconds=.15):
    global output
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], min(.05, max(0, deadline-time.monotonic())))[0]:
            try: output += os.read(master, 65536)
            except OSError: break

def wait(text):
    global output, stage
    stage = "waiting for " + repr(text)
    deadline = time.monotonic() + 20
    while text.encode() not in output and time.monotonic() < deadline and process.poll() is None: drain()
    assert text.encode() in output, "Missing " + repr(text) + ": " + output[-6000:].decode(errors="replace")
    output = b""
    stage = "reached " + repr(text)

def send(events):
    for event in events:
        os.write(master, event.encode())
        drain()

try:
    deadline = time.monotonic() + 20
    while b"Your Projects" not in output and b"Upgrade now or skip for this session." not in output and time.monotonic() < deadline and process.poll() is None:
        drain()
    if b"Upgrade now or skip for this session." in output:
        output = b""
        send(["\x1b[B", "\r"])
    wait("Your Projects")
    send(["\t", "\x1b[C", "\r"])
    wait("Accounts")
    send(["\x1b[B"]*3 + ["\r"])
    wait("Add custom rule")
    stage = "quitting Privacy rules with Escape, Escape, q"
    send(["\x1b", "\x1b", "q"])
    deadline = time.monotonic() + 10
    while process.poll() is None and time.monotonic() < deadline: drain()
    assert process.poll() == 0, ("Upgraded Settings console failed to exit cleanly; exit=" + repr(process.poll()) +
                                 "; stage=" + stage + "; output=" + output[-6000:].decode(errors="replace"))
    drain()
    assert termios.tcgetattr(slave) == before, "terminal attributes were not restored"
    assert b"\x1b[?1049l" in output and b"\x1b[?25h" in output, "terminal screen/cursor were not restored"
    print("Verified Privacy rules is reachable through the installed bootstrap and the terminal is restored.")
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
