"""Installed-binary PTY acceptance. All state and capture sources are disposable."""
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
import urllib.request
from pathlib import Path

binary, root, adapter, origin = sys.argv[1:]
root = Path(root)
project = root / "项目 space"
project.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, ATAPE_HOME=str(root / "home"), ATAPE_INSTANCE_URL=origin,
           ATAPE_CODEX_HOME=str(root / "absent-codex"), ATAPE_CLAUDE_HOME=str(root / "absent-claude"),
           TERM="xterm-256color", ATAPE_DEVELOPMENT_ALLOW_HTTP="true")
for name in ("CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
             "ATAPE_CONFIG_FILE", "ATAPE_COLLECTOR_STATE_FILE", "ATAPE_COLLECTOR_PROCESS_FILE", "ATAPE_COLLECTOR_STATUS_FILE",
             "ATAPE_COLLECTOR_LOG_FILE", "ATAPE_ADAPTER_DIRECTORY"):
    env.pop(name, None)

def cli(*args):
    return subprocess.run([binary, *args], env=env, cwd=root, capture_output=True, text=True, timeout=40, check=True).stdout

class Terminal:
    def __init__(self, args=(), overrides=None, skip_updates=True):
        self.master, self.slave = pty.openpty()
        self.before = termios.tcgetattr(self.slave)
        self.resize(80, 24)
        self.process = subprocess.Popen([binary, *args], env=dict(env, **(overrides or {})), cwd=root,
                                        stdin=self.slave, stdout=self.slave, stderr=self.slave, start_new_session=True)
        self.output = b""
        if skip_updates and not (overrides or {}).get("CI") and (not args or args[0] in ("setup", "--no-browser")):
            self.wait("Update available")
            self.send("\x1b[B\r")
    def resize(self, columns, rows):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        if hasattr(self, "process"):
            self.process.send_signal(signal.SIGWINCH)
    def drain(self, seconds=.12):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], min(.05, max(0, deadline - time.monotonic())))[0]:
                try: self.output += os.read(self.master, 65536)
                except OSError: break
    def wait(self, text, seconds=20):
        marker = text.encode()
        deadline = time.monotonic() + seconds
        while marker not in self.output and time.monotonic() < deadline:
            self.drain()
            if self.process.poll() is not None: break
        assert marker in self.output, f"Missing {text!r}: {self.output[-7000:].decode(errors='replace')}"
        output = self.output
        self.output = b""
        return output
    def send(self, text):
        # Keys are separate terminal events, while paste remains one packet.
        if "\x1b[200~" in text:
            os.write(self.master, text.encode())
            self.drain(.18)
            return
        import re
        for event in re.findall(r"\x1b\[[A-D]|[^\x00-\x1f\x7f]+|.", text, re.S):
            os.write(self.master, event.encode())
            self.drain(.12)
    def finish(self, text="\x03", allowed=(0,)):
        if text: self.send(text)
        deadline = time.monotonic() + 10
        while self.process.poll() is None and time.monotonic() < deadline:
            self.drain()
        assert self.process.poll() is not None, "Terminal did not exit: " + self.output.decode(errors="replace")
        self.drain()
        assert self.process.returncode in allowed, self.output.decode(errors="replace")
        assert termios.tcgetattr(self.slave) == self.before, "terminal attributes were not restored"
        assert b"\x1b[?1049l" in self.output, "primary screen was not restored"
        assert b"\x1b[?25h" in self.output, "cursor was not restored"
        os.close(self.master)
        os.close(self.slave)
    def abort(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)

terminals = []
try:
    # Seed a future release in this disposable home's cache: packaged startup
    # choices are deterministic and never depend on the public npm registry.
    current = cli("--version").strip().split()[-1].split(".")
    available = f"{int(current[0]) + 1}.0.0"
    cache = root / "home" / "cache" / "cli-update.json"
    (root / "home").mkdir(mode=0o700, exist_ok=True)
    cache.parent.mkdir(mode=0o700, exist_ok=True)
    cache.write_text(json.dumps({"checkedAt": int(time.time() * 1000), "version": available}))
    terminal = Terminal(skip_updates=False)
    terminals.append(terminal)
    terminal.drain(.5)
    assert b"Welcome to ATape" not in terminal.output, "startup bypassed the update choice"
    terminal.wait("Upgrade and continue")
    terminal.send("\x1b[B\r")
    terminal.wait("Welcome to ATape")
    terminal.send("\r")
    terminal.wait("Which conversations should ATape sync?")
    terminal.finish()
    terminals.pop()

    # Controls can be exercised without any authentication or package execution.
    for ending in ("escape", "ctrl-c", "sigterm"):
        terminal = Terminal()
        terminals.append(terminal)
        terminal.wait("Welcome to ATape")
        terminal.send("\r")
        terminal.wait("Which conversations should ATape sync?")
        # Cancelling first-use tool selection does not install or enable anything.
        terminal.send("\x1b")
        terminal.wait("Welcome to ATape")
        terminal.finish()
        terminals.pop()
        # Path controls run with an explicitly saved, inert fixture integration.
        cli("adapters", "install", adapter, "--json")
        cli("tools", "configure", "--adapter", "smoke", "--apply", "--json")
        terminal = Terminal(("setup",))
        terminals.append(terminal)
        terminal.wait("Connect a Project")
        terminal.send("项sp")
        terminal.drain(.5)
        assert "Search: 项sp".encode() in terminal.output, "typing did not start project-name search"
        assert "项目 space".encode() in terminal.output, "fuzzy project result was not shown"
        terminal.send("\x1b")
        terminal.wait("Use current directory")
        terminal.send("\x15" + str(root) + "/项")
        terminal.drain(.4)
        terminal.wait("项目 space")  # Candidates are visible before completion.
        # Down selects the explicit connection row, then the matching folder.
        terminal.send("\x1b[B\x1b[B\r")
        assert b"Finding your Project" not in terminal.output, "browsing connected the directory"
        terminal.wait("../")
        # Enter on the parent candidate browses back without starting setup.
        terminal.send("\x1b[B\r")
        assert b"Finding your Project" not in terminal.output, "parent navigation connected a directory"
        terminal.wait("Use current directory")
        terminal.resize(38, 12)
        terminal.send("\x15")
        terminal.send("\x1b[200~" + str(project) + "\n\x1b[201~")
        terminal.drain(.3)
        assert b"Finding your Project" not in terminal.output, "paste submitted the form"
        if ending == "escape":
            terminal.send("\x1b")
            terminal.wait("Your Projects")
            terminal.finish("\x1b")
        elif ending == "sigterm":
            terminal.process.send_signal(signal.SIGTERM)
            terminal.finish("", allowed=(0, 143, -signal.SIGTERM))
        else:
            terminal.finish()
        terminals.pop()
        # Restore an unconfigured fixture for the next independent first-use run.
        (root / "home" / "config" / "client.json").unlink()

    for args, overrides in (((), {"CI": "true"}), (("--version",), {}), (("status", "--json"), {})):
        terminal = Terminal(args, overrides)
        terminals.append(terminal)
        terminal.process.wait(timeout=10)
        terminal.drain()
        assert b"\x1b" not in terminal.output, terminal.output
        assert b"Update available" not in terminal.output
        if args == ("status", "--json"):
            json.loads(terminal.output)
        assert termios.tcgetattr(terminal.slave) == terminal.before
        terminal.abort()
        terminals.pop()
    piped = cli()
    assert "Interactive setup needs" in piped and "\x1b" not in piped

    cli("adapters", "install", adapter, "--json")
    # Configure tools once, then exercise login and the zero-Team detour during
    # Project connection without a second tool-selection step.
    def team_mode(enabled):
        request = urllib.request.Request(origin + "/__terminal-fixture/teams", data=json.dumps({"enabled": enabled}).encode(), method="POST")
        with urllib.request.urlopen(request, timeout=5) as response: response.read()
    team_mode(False)
    terminal = Terminal(("--no-browser",))
    terminals.append(terminal)
    terminal.wait("Welcome to ATape")
    terminal.send("\r")
    terminal.wait("Which conversations should ATape sync?")
    terminal.send("\x1b[B\x1b[B \r")
    terminal.wait("Connect a Project")
    terminal.send("\x15" + str(project) + "\r")
    assert b"Finding your Project" not in terminal.output, "finishing a path edit submitted setup"
    terminal.wait("Use current directory")
    terminal.send("\r")
    terminal.wait("Code: Q7KM4W")
    terminal.wait("Create or join a Team")
    terminal.send("\r")
    terminal.wait("/onboarding")
    team_mode(True)
    terminal.send("\x1b[B\r")
    terminal.wait("Review and connect")
    config = json.loads(cli("projects", "list", "--json"))
    assert not config["projects"], "setup enabled capture before confirmation"
    terminal.send("\r")
    terminal.wait("No conversations yet", seconds=30)
    terminal.finish("q")
    terminals.pop()
    status = json.loads(cli("status", "--json"))
    assert status["running"], "exiting the console stopped background collection"
    config = json.loads(cli("projects", "list", "--json"))
    assert len(config["projects"]) == 1 and config["projects"][0]["adapterIds"] == ["smoke"]
    assert config["projects"][0]["path"] == str(project.resolve())

    terminal = Terminal(("--no-browser",))
    terminals.append(terminal)
    terminal.wait("Your Projects")
    terminal.send("n")
    terminal.wait("Connect a Project")
    terminal.send("\x1b")
    terminal.wait("Your Projects")
    terminal.send("/")
    terminal.send("q-no-such-project")
    terminal.wait("No matching projects")
    assert terminal.process.poll() is None, "q in search exited the console"
    terminal.send("\x1b")
    terminal.send("\t")
    terminal.wait("Actions: Add project")
    terminal.send("\t")
    terminal.send("/")
    terminal.send("Package")
    terminal.send("\r")
    # The Project name is also present in the list. Wait for a detail-only
    # action before sending keys to the asynchronously loaded detail screen.
    terminal.wait("Disconnect project")
    terminal.send("\x1b")
    terminal.wait("/ Package")
    terminal.send("r")
    terminal.drain(.4)
    assert b"/ Package" in terminal.output, "refresh discarded the search"
    assert b"Working" not in terminal.output, "refresh replaced the Project list"
    terminal.send("\r")
    terminal.wait("Disconnect project")
    assert b"Open Project in Web" not in terminal.output, "Project details still offer Web navigation"
    terminal.send("r")
    terminal.wait("Status updated. Sync timing is unchanged.")
    terminal.send("\x1b")
    terminal.wait("Your Projects")
    terminal.send("\t\x1b[C\r")
    updates = terminal.wait("Check again")
    assert b"Tools and updates" in updates, "global tools did not open the updates page"
    assert f"Update ATape to {available}".encode() in updates, "skipped startup update is unavailable in Tools"
    assert b"manual update" in updates, "custom installation should remain on its original source"
    terminal.send("\x1b[B\r")
    terminal.wait("Which conversations should ATape sync?")
    terminal.send("\x1b[B\x1b[B \r")
    terminal.wait("Apply tools to all projects?")
    # Escape cancels the global change without changing capture authorization.
    terminal.send("\x1b")
    terminal.wait("Which conversations should ATape sync?")
    assert json.loads(cli("projects", "list", "--json"))["projects"][0]["adapterIds"] == ["smoke"]
    terminal.send("\r")
    terminal.wait("Apply tools to all projects?")
    terminal.send("\x1b[B\r")
    terminal.wait("Check again")
    terminal.send("\x1b")
    terminal.wait("Your Projects")
    terminal.finish("q")
    terminals.pop()
    assert json.loads(cli("projects", "list", "--json"))["projects"][0]["adapterIds"] == []
    print("Verified installed Ink controls, restoration, global tools, login/Web Refresh, confirmed setup, global cancellation and background lifetime.")
finally:
    for terminal in terminals:
        terminal.abort()
    try: cli("stop", "--json")
    except Exception: pass
