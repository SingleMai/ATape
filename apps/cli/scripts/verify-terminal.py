"""Installed-binary PTY acceptance. All state and capture sources are disposable."""
import base64
import fcntl
import hashlib
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
           CURSOR_CONFIG_DIR=str(root / "absent-cursor"), CURSOR_DATA_DIR=str(root / "absent-cursor"), ATAPE_GROK_HOME=str(root / "absent-grok"), OPENCODE_DB=str(root / "absent-opencode.db"), ATAPE_CODEX_HOME=str(root / "absent-codex"), ATAPE_CLAUDE_HOME=str(root / "absent-claude"), ATAPE_CODEBUDDY_HOME=str(root / "absent-codebuddy"), ATAPE_KIMI_HOME=str(root / "absent-kimi"),
           TERM="xterm-256color", ATAPE_DEVELOPMENT_ALLOW_HTTP="true")
for name in ("CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
             "ATAPE_CONFIG_FILE", "ATAPE_COLLECTOR_STATE_FILE", "ATAPE_COLLECTOR_PROCESS_FILE", "ATAPE_COLLECTOR_STATUS_FILE",
             "ATAPE_COLLECTOR_LOG_FILE", "ATAPE_ADAPTER_DIRECTORY"):
    env.pop(name, None)

# UI-only update choices use a fresh catalog, never a public lookup. Record any
# attempted release transport before refusing it, while local Server calls keep
# their normal production fetch implementation.
release_requests = root / "unexpected-release-fetch.jsonl"
release_guard = root / "guard-release-fetch.mjs"
release_guard.write_text("""import { appendFileSync } from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async (input, ...args) => {
  const address = input instanceof Request ? input.url : String(input);
  const url = new URL(address);
  if (url.hostname === "registry.npmjs.org" || url.hostname === "api.github.com" && url.pathname.includes("/releases/")) {
    appendFileSync(process.env.TERMINAL_FIXTURE_RELEASE_REQUESTS, JSON.stringify(address) + "\\n");
    throw new Error("Fresh catalog terminal fixture forbids public release transport");
  }
  return Reflect.apply(original, globalThis, [input, ...args]);
};
""")
env["TERMINAL_FIXTURE_RELEASE_REQUESTS"] = str(release_requests)
env["NODE_OPTIONS"] = " ".join(filter(None, [env.get("NODE_OPTIONS"), "--import=" + release_guard.resolve().as_uri()]))

fixture_script = Path(__file__).resolve().parent.parent / "src/runtime/fixtures/terminal-state.ts"

def fixture(*args):
    subprocess.run(["node", str(fixture_script), *args], env=env, cwd=root, capture_output=True, text=True, timeout=40, check=True)

def config():
    path = root / "home/config/client.json"
    value = json.loads(path.read_text()) if path.exists() else {"projects": [], "enabledAdapterIds": []}
    for project in value["projects"]:
        project["adapterIds"] = value.get("enabledAdapterIds", [])
    return value

def running():
    path = root / "home/state/collector-process.json"
    if not path.exists(): return False
    try: os.kill(json.loads(path.read_text())["pid"], 0)
    except ProcessLookupError: return False
    return True

def cli(*args):
    return subprocess.run([binary, *args], env=env, cwd=root, capture_output=True, text=True, timeout=40, check=True).stdout

class Terminal:
    def __init__(self, args=(), overrides=None, skip_updates=True):
        # These scenarios intentionally exercise the manual startup Upgrade/Skip
        # choice. Default-on unattended updates are accepted separately against
        # the packaged independent worker in verify-automatic-update.mjs.
        path = Path((overrides or {}).get("ATAPE_HOME", env["ATAPE_HOME"])) / "config/client.json"
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        saved = json.loads(path.read_text()) if path.exists() else {"version": 3, "projects": [], "adapters": [], "toolsConfigured": False, "enabledAdapterIds": []}
        saved["autoUpdateEnabled"] = False
        # Login startup is accepted separately using a controlled OS command
        # Adapter. PTY checks must never register a service in the user's session.
        saved["autoStartEnabled"] = False
        path.write_text(json.dumps(saved))
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

def verify_privacy_rules():
    # No Projects or enabled integrations: this exercises the installed Settings
    # flow independently of capture startup and the authenticated setup below.
    home = root / "privacy-home"
    (home / "config").mkdir(mode=0o700, parents=True)
    client = home / "config/client.json"
    client.write_text(json.dumps({"version": 3, "projects": [], "adapters": [],
                                  "toolsConfigured": True, "enabledAdapterIds": [],
                                  "autoUpdateEnabled": False, "autoStartEnabled": False}))
    privacy_cache = home / "cache/release-discovery/catalog.json"
    privacy_cache.parent.mkdir(mode=0o700, parents=True)
    privacy_cache.write_bytes(cache.read_bytes())
    overrides = {"ATAPE_HOME": str(home), "ATAPE_REDACT_VALUES": "[]"}
    terminal = Terminal(overrides=overrides)
    terminals.append(terminal)
    terminal.resize(100, 40)
    terminal.wait("Your Projects")
    terminal.send("\t\x1b[C\r")
    terminal.wait("Accounts")
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Add custom rule")
    rules = home / "config/redaction.json"
    before_client = client.read_bytes()

    def capture_state():
        return {str(path.relative_to(home)): path.read_bytes() for path in home.rglob("*")
                if path.is_file() and ("state" in path.relative_to(home).parts
                                       or ".redaction-key" in path.name)}

    before_capture = capture_state()
    assert not rules.exists(), "opening Privacy rules created a configuration file"
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Background sync: stopped")
    terminal.send("\r")
    terminal.wait("Background sync: stopped")
    terminal.send("\x1b[B\r")
    terminal.wait("Add custom rule")
    assert capture_state() == before_capture, "observing background privacy created Collector state"
    assert not rules.exists(), "observing background privacy created a configuration file"
    terminal.send("\r")
    terminal.wait("Custom rule 1")

    def field(index, hint, value):
        terminal.send("\x1b[B" * index + "\r")
        terminal.wait(hint)
        terminal.send("\x15\x1b[200~" + value + "\x1b[201~")
        terminal.send("\r")
        terminal.wait("Custom rule 1")

    name = '内部 "ticket" \\ 标签'
    field(0, "A label for this rule.", name)
    field(1, "Replacement label:", "INTERNAL")
    terminal.send("\x1b[B" * 2 + "\r")
    terminal.wait("RE2 value pattern")
    terminal.send("\x1b[200~bad\ncontrol\x1b[201~")
    terminal.wait("Input was not inserted:")
    # A rejected paste also blocks Enter until the user edits or leaves the
    # field; Escape returns to the unchanged draft instead of accepting it.
    terminal.send("\r\x1b")
    terminal.wait("Custom rule 1")
    terminal.send("\x1b[B" * 5 + "\r")
    terminal.wait("Use this for exact line breaks")
    terminal.send("\x1b[B" * 2 + "\r")
    terminal.wait("Enter a JSON string including quotes")
    pattern = "ticket=(private-\\w+)\n\t\x1b"
    terminal.send("\x15\x1b[200~" + json.dumps(pattern) + "\x1b[201~")
    terminal.send("\r")
    terminal.wait("Custom rule 1")
    field(4, "JSON number for the capture group", "1")
    terminal.send("\x1b[B" * 7 + "\r")
    terminal.wait("Add custom rule")
    terminal.send("\x1b[B" * 2 + "\r")
    terminal.wait("Rules are valid. Validation does not save them.")
    assert not rules.exists(), "validation saved a draft"
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Save global privacy rules?")
    terminal.send("\r")  # The default review action is Cancel.
    terminal.wait("Add custom rule")
    assert not rules.exists(), "the default Cancel saved privacy rules"
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Save global privacy rules?")
    terminal.send("\x1b[B\r")
    terminal.wait("Privacy rules saved.")
    expected = {"patterns": [{"name": name, "type": "INTERNAL", "pattern": pattern, "capture_group": 1}]}
    assert json.loads(rules.read_text()) == expected, "the installed editor changed escaped rule input"
    saved = rules.read_bytes()
    sample = root / "privacy-sample.txt"
    sample.write_text("ticket=private-alpha\n\t\x1b")
    tested = subprocess.run([binary, "redaction-test", str(sample)], env=dict(env, **overrides), cwd=root,
                            capture_output=True, text=True, timeout=40, check=True)
    assert tested.stdout == "ticket=[REDACTED:INTERNAL]\n\t\x1b", "saved rules did not reach the installed redaction command"

    # Invalid edits retain the accepted file. No repair/reset is inferred.
    terminal.send("\x1b[B\r")
    terminal.wait("Custom rule 1")
    field(2, "Enter a JSON string including quotes", json.dumps("("))
    terminal.send("\x1b[B" * 7 + "\r")
    terminal.wait("Add custom rule")
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Rules are invalid or exceed a limit.")
    assert rules.read_bytes() == saved, "invalid RE2 input replaced accepted rules"
    terminal.send("\x1b[B" * 5 + "\r")
    terminal.wait("Background sync: stopped")
    terminal.send("\x1b")
    terminal.wait("Add custom rule")
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Rules are invalid or exceed a limit.")
    assert rules.read_bytes() == saved, "background status changed the invalid unsaved draft"
    terminal.send("\x1b[B" * 4 + "\r")
    terminal.wait("Discard unsaved rules?")
    terminal.send("\x1b[B\r")
    terminal.wait("Add custom rule")
    terminal.send("\x1b[B\r")
    terminal.wait("Custom rule 1")
    terminal.send("\x1b[B" * 6 + "\r")
    terminal.wait("Delete this custom rule?")
    terminal.send("\r")
    terminal.wait("Custom rule 1")
    assert rules.read_bytes() == saved, "the default Cancel deleted accepted rules"
    terminal.send("\x1b[B" * 6 + "\r")
    terminal.wait("Delete this custom rule?")
    terminal.send("\x1b[B\r")
    terminal.wait("Custom rules: 0")
    assert rules.read_bytes() == saved, "deleting a draft changed the saved configuration"
    terminal.send("\x1b[B" * 2 + "\r")
    terminal.wait("Save global privacy rules?")
    terminal.send("\x1b[B\r")
    terminal.wait("Privacy rules saved.")
    assert json.loads(rules.read_text()) == {"patterns": []}, "confirmed deletion did not persist"
    assert client.read_bytes() == before_client, "privacy editing changed capture configuration"
    assert capture_state() == before_capture, "privacy editing changed Collector progress or its identity key"
    terminal.send("\x1b")
    terminal.wait("Accounts")
    terminal.send("\x1b")
    terminal.wait("Your Projects")
    terminal.finish("q")
    terminals.pop()

terminals = []
try:
    # Seed a complete future bundle for the installed runtime's capture/control
    # pair. These canonical SRI values describe metadata-only UI fixture bytes;
    # this acceptance always skips package execution. Real acquired tarballs are
    # exercised separately by verify-automatic-update.mjs.
    current = cli("--version").strip().split()[-1].split(".")
    available = f"{int(current[0]) + 1}.0.0"
    runtime = json.loads((Path(binary).resolve().parent.parent / "package.json").read_text())["atapeRuntime"]
    packages = ["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude", "@atape/adapter-codebuddy",
                "@atape/adapter-kimi", "@atape/adapter-opencode", "@atape/adapter-grok", "@atape/adapter-cursor"]
    bundle = {"protocol": "atape.release-bundle.v1", "version": available,
              "captureStateContract": runtime["stateContract"], "updateControlProtocol": runtime["updateControlProtocol"],
              "packages": [{"name": name,
                            "integrity": "sha512-" + base64.b64encode(hashlib.sha512((name + "@" + available).encode()).digest()).decode(),
                            "tarball": f"https://registry.npmjs.org/{name}/-/{name.removeprefix('@atape/')}-{available}.tgz"}
                           for name in packages]}
    cache = root / "home/cache/release-discovery/catalog.json"
    # Python's parents=True uses the default mode for intermediate directories;
    # credentials require ATAPE_HOME itself to remain private.
    (root / "home").mkdir(mode=0o700, exist_ok=True)
    cache.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    cache.write_text(json.dumps({"checkedAt": int(time.time() * 1000),
                                 "catalog": {"protocol": "atape.update-catalog.v1", "revision": 1, "bundles": [bundle]}}))
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
        fixture(adapter, "enabled")
        terminal = Terminal()
        terminal.wait("n Add")
        terminal.send("n")
        terminals.append(terminal)
        terminal.wait("Project directory")
        terminal.send("项sp")
        terminal.drain(.5)
        assert "Search: 项sp".encode() in terminal.output, "typing did not start project-name search"
        assert "项目 space".encode() in terminal.output, "fuzzy project result was not shown"
        terminal.send("\x1b")
        # The project title stays visible behind the modal. Wait for the active
        # home controls before sending a key that must not reach the closing picker.
        terminal.wait("n Add")
        terminal.send("n")
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
            terminal.wait("n Add")
            terminal.finish("\x1b")
        elif ending == "sigterm":
            terminal.process.send_signal(signal.SIGTERM)
            terminal.finish("", allowed=(0, 143, -signal.SIGTERM))
        else:
            terminal.finish()
        terminals.pop()
        # Restore an unconfigured fixture for the next independent first-use run.
        (root / "home" / "config" / "client.json").unlink()

    for args, overrides in (((), {"CI": "true"}), (("--version",), {}), (("--help",), {})):
        terminal = Terminal(args, overrides)
        terminals.append(terminal)
        terminal.process.wait(timeout=10)
        terminal.drain()
        assert b"\x1b" not in terminal.output, terminal.output
        assert b"Update available" not in terminal.output
        assert termios.tcgetattr(terminal.slave) == terminal.before
        terminal.abort()
        terminals.pop()
    piped = subprocess.run([binary], env=env, cwd=root, capture_output=True, text=True, timeout=10)
    assert piped.returncode == 2 and not piped.stdout
    assert "interactive macOS or Linux terminal" in piped.stderr and "\x1b" not in piped.stderr

    fixture(adapter)
    smoke_index = 7  # Seven official tools precede the fixture integration.
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
    terminal.send("\x1b[B" * smoke_index + " \r")
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
    snapshot = config()
    assert not snapshot["projects"], "setup enabled capture before confirmation"
    terminal.send("\r")
    terminal.wait("No conversations yet", seconds=30)
    terminal.finish("q")
    terminals.pop()
    assert running(), "exiting the console stopped background collection"
    run_state = json.loads((root / "home/state/collector-status.json").read_text())
    assert any(job["adapterId"] == "smoke" and job.get("lastSuccessAt") and not job.get("lastFailureAt") for job in run_state["jobs"]), run_state
    snapshot = config()
    assert len(snapshot["projects"]) == 1 and snapshot["projects"][0]["adapterIds"] == ["smoke"]
    assert snapshot["projects"][0]["path"] == str(project.resolve())

    # A direct same-version package replacement is completed when the installed
    # interactive app opens. No removed business command is involved.
    process_file = root / "home/state/collector-process.json"
    previous_process = json.loads(process_file.read_text())
    entry = Path(binary).resolve()
    entry.write_text(entry.read_text() + "\n// package replacement before console startup\n")
    terminal = Terminal(("--no-browser",))
    terminals.append(terminal)
    terminal.wait("n Add")
    refreshed_process = json.loads(process_file.read_text())
    assert refreshed_process["pid"] != previous_process["pid"], "opening updated ATape retained the old Host"
    for field in ("intervalMs", "concurrency"):
        assert refreshed_process[field] == previous_process[field], "Host refresh changed " + field
    # Observe the actual installed daemon's pinned snapshot through Settings.
    # This also verifies that only the owned daemon receives write authority.
    status_file = root / "home/state/collector-status.json"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        observed = json.loads(status_file.read_text()).get("redaction", {})
        if observed.get("generation") == hashlib.sha256(refreshed_process["token"].encode()).hexdigest() and any(
                job.get("snapshot") for job in observed.get("jobs", [])):
            break
        time.sleep(.1)
    else:
        raise AssertionError("installed daemon did not report its pinned privacy snapshot")
    assert refreshed_process["token"] not in json.dumps(observed), "privacy status exposed daemon ownership token"
    terminal.send("\t\x1b[C\r")
    terminal.wait("Accounts")
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Add custom rule")
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Background sync: running")
    for _ in range(20):
        if b"This job loaded the compared file revision." in terminal.output:
            break
        os.write(terminal.master, b"\x1b[6~")
        terminal.drain(.15)
    terminal.wait("This job loaded the compared file revision.")
    terminal.send("\r")
    terminal.wait("Background sync: running")
    terminal.send("\x1b")
    terminal.wait("Add custom rule")
    terminal.send("\x1b")
    terminal.wait("Accounts")
    terminal.send("\x1b")
    terminal.wait("Your Projects")
    # Restore the original Projects focus and Tools action selection before
    # continuing the existing navigation acceptance below.
    terminal.send("\x1b[D\t")
    terminal.send("n")
    terminal.wait("Add project")
    terminal.wait("Project directory")
    terminal.send("\x1b")
    terminal.wait("n Add")
    terminal.send("/")
    terminal.send("q-no-such-project")
    terminal.wait("No matching projects")
    assert terminal.process.poll() is None, "q in search exited the console"
    terminal.send("\x1b")
    terminal.send("\t")
    terminal.wait("Actions: Tools and updates")
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
    terminal.send("\t\r")
    updates = terminal.wait("Check again")
    assert b"Tools and updates" in updates, "global tools did not open the updates page"
    assert f"Update ATape to {available}".encode() in updates, "skipped startup update is unavailable in Tools"
    assert b"manual update" in updates, "custom installation should remain on its original source"
    terminal.send("\x1b[B\r")
    terminal.wait("Which conversations should ATape sync?")
    terminal.send("\x1b[B" * smoke_index + " \r")
    terminal.wait("Apply tools to all projects?")
    # Escape cancels the global change without changing capture authorization.
    terminal.send("\x1b")
    terminal.wait("Which conversations should ATape sync?")
    assert config()["projects"][0]["adapterIds"] == ["smoke"]
    terminal.send("\r")
    terminal.wait("Apply tools to all projects?")
    terminal.send("\x1b[B\r")
    terminal.wait("Check again")
    terminal.send("\x1b")
    terminal.wait("Your Projects")
    terminal.finish("q")
    terminals.pop()
    assert config()["projects"][0]["adapterIds"] == []
    # Exercise the replacement for package maintenance and language/stop commands
    # through the installed application, including default-Cancel reviews.
    terminal = Terminal()
    terminals.append(terminal)
    terminal.wait("Your Projects")
    terminal.send("\t\r")
    terminal.wait("Check again")
    terminal.send("\x1b[B" * 3 + "\r")
    terminal.wait("Install from a package or path")
    terminal.send("\r")
    terminal.wait("Enter an npm package")
    terminal.send(str(adapter) + "\r")
    terminal.wait("Install integration?")
    # The same safety boundary must apply when npm replaces the CLI while the
    # console is already open, before Integration maintenance activates a slot.
    previous_process = json.loads(process_file.read_text())
    entry.write_text(entry.read_text() + "\n// package replacement during console lifetime\n")
    terminal.send("\x1b[B\r")
    terminal.wait("Integration installed.", seconds=30)
    refreshed_process = json.loads(process_file.read_text())
    assert refreshed_process["pid"] != previous_process["pid"], "integration activation retained the old Host"
    for field in ("intervalMs", "concurrency"):
        assert refreshed_process[field] == previous_process[field], "integration refresh changed " + field
    assert config()["enabledAdapterIds"] == [], "installation enabled capture"
    terminal.send("\x1b[B\r")
    terminal.wait("Remove unused integration versions?")
    terminal.send("\x1b[B\r")
    terminal.wait("unused versions.")
    terminal.send("\x1b")
    terminal.wait("Check again")
    terminal.send("\x1b")
    terminal.wait("Your Projects")
    terminal.finish("q")
    terminals.pop()
    terminal = Terminal()
    terminals.append(terminal)
    terminal.wait("Your Projects")
    terminal.send("\t\x1b[C\r")
    terminal.wait("Accounts")
    terminal.send("\x1b[B" * 4 + "\r")
    terminal.wait("English")
    terminal.send("\r")
    terminal.wait("Language saved.")
    assert config()["locale"] == "en"
    terminal.send("\x1b")
    terminal.wait("Accounts")
    terminal.send("\x1b[B" * 6 + "\r")
    terminal.wait("Stop background sync?")
    assert running(), "opening the stop review stopped sync"
    terminal.send("\x1b[B\r")
    terminal.wait("Your Projects")
    assert not running(), "confirmed stop did not stop the owned Collector"
    terminal.finish("q")
    terminals.pop()
    verify_privacy_rules()
    assert not release_requests.exists(), "fresh catalog UI choices attempted public release transport: " + release_requests.read_text()
    print("Verified installed Ink controls, restoration, global tools, login/Web Refresh, confirmed setup, global cancellation, integration maintenance, executable replacement handoff, language, privacy editing/validation/cancellation/escaped input and background lifetime.")
finally:
    for terminal in terminals:
        terminal.abort()
    try: fixture("stop")
    except Exception: pass
