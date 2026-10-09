"""Real published 0.5.3 Stop control in a disposable package acceptance home."""
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
process = subprocess.Popen([sys.argv[1]], env=dict(os.environ, TERM="xterm-256color"),
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = b""

def wait(text):
    global output
    deadline = time.monotonic() + 20
    while text.encode() not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .05)[0]:
            try:
                output += os.read(master, 65536)
            except OSError:
                break
        if process.poll() is not None:
            break
    assert text.encode() in output, f"Missing {text!r}: {output[-7000:].decode(errors='replace')}"
    output = b""

def send(text):
    os.write(master, text.encode())
    time.sleep(.15)

try:
    wait("n Add")
    send("\t")
    wait("Actions: Tools and updates")
    send("\x1b[C")
    wait("Actions: Settings")
    send("\r")
    wait("Accounts")
    for _ in range(4):
        send("\x1b[B")
    send("\r")
    wait("Stop background sync?")
    send("\x1b[B")
    send("\r")
    wait("Sync stopped")
    assert not (Path(os.environ["ATAPE_HOME"]) / "state/collector-process.json").exists()
    # The compatibility contract is the old Stop's persisted effect. End this
    # owned historical UI after observing it, without adding its exit-focus
    # behavior to the current package's separate terminal acceptance contract.
    process.terminate()
    deadline = time.monotonic() + 10
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .05)[0]:
            try:
                os.read(master, 65536)
            except OSError:
                break
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)
    print("Verified the published 0.5.3 TUI Stop control.")
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
    os.close(slave)
