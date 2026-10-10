"""Run one installed entry with real TTY descriptors; never interact with its UI."""
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

node, entry, root = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
process = subprocess.Popen([node, entry], cwd=root, env=dict(os.environ, TERM="xterm-256color"),
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()

def drain(wait):
    if select.select([master], [], [], wait)[0]:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            return False
    assert len(output) <= 1024 * 1024, "TTY fixture output exceeded its bound"
    return True

try:
    deadline = time.monotonic() + 20
    while process.poll() is None and time.monotonic() < deadline:
        drain(.05)
    assert process.poll() is not None, "Installed TTY entry did not exit: " + output[-6000:].decode(errors="replace")
    while select.select([master], [], [], 0)[0]:
        if not drain(0):
            break
    print(json.dumps({"exitCode": process.returncode, "output": output.decode(errors="replace"),
                      "terminalRestored": termios.tcgetattr(slave) == before}))
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
