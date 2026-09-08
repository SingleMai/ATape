"""Real PTY input handoff after Ink teardown; no user installation is involved."""
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time

node, parent, child = sys.argv[1:]
env = dict(os.environ, TERM="xterm-256color")
for key in ("CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER"):
    env.pop(key, None)

for attempt in range(3):
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    process = subprocess.Popen([node, parent, child], env=env, stdin=slave,
                               stdout=slave, stderr=slave, start_new_session=True)
    output = b""
    def wait(marker):
        global output
        deadline = time.monotonic() + 3
        while marker not in output and time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]:
                output += os.read(master, 65536)
        assert marker in output, f"Missing {marker!r}: {output!r}"
    try:
        wait(b"PARENT_READY")
        os.write(master, b"\r")
        wait(b"CHILD_READY")
        for key in (b"x", b"y", b"q"):
            os.write(master, key)
            wait(b"INPUT:" + key)
        assert process.wait(timeout=3) == 0
        assert termios.tcgetattr(slave) == before, "terminal attributes were not restored"
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
        os.close(slave)
