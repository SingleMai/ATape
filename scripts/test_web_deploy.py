"""Contract tests through the deployment script's command-line Interface."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).with_name("deploy-web.sh")
SHA = "a" * 40
MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["ATAPE_DEPLOY_STATE_DIRECTORY"])
args = sys.argv[1:]
with (root / "commands.jsonl").open("a") as log:
    log.write(json.dumps([pathlib.Path(sys.argv[0]).name, *args]) + "\n")
if pathlib.Path(sys.argv[0]).name == "curl":
    print(json.dumps({"commit": os.environ["EXPECTED_SHA"]}))
elif pathlib.Path(sys.argv[0]).name == "flock":
    import fcntl
    fcntl.flock(int(args[-1]), fcntl.LOCK_EX)
elif args[0] == "inspect":
    print("sha256:previous" if args[2] == "{{.Image}}" else "old-commit")
elif args[0] == "build":
    if os.environ.get("FAIL_BUILD") == "1": sys.exit(1)
elif args[0] == "create":
    print("asset-container")
elif args[0] == "cp":
    dest = pathlib.Path(args[-1])
    dest.mkdir()
    (dest / "old-chunk.js").write_text("old lazy import")
elif args[0] == "compose":
    if "ps" in args: print("web-container")
    elif "config" in args: print('{"services":{"web":{"build":{"args":{}}}}}')
    elif "up" in args:
        attempts = root / "attempts"
        count = int(attempts.read_text()) if attempts.exists() else 0
        attempts.write_text(str(count + 1))
        if count == 0 and os.environ.get("FAIL_ROLLOUT") == "1": sys.exit(1)
'''


class DeployWebContract(unittest.TestCase):
    def test_ssm_document_accepts_environment_and_legacy_interpolation(self):
        template = SCRIPT.parent.parent / "deploy/aws/web-deployment.yaml"
        prefix = template.read_text().split("#!/usr/bin/env bash\n", 1)[1].split("directory=$(mktemp", 1)[0]
        script = textwrap.dedent(prefix) + 'printf "%s" "$sha"\n'
        for interpolated in ("$SSM_CommitSha", SHA):
            with self.subTest(interpolation=interpolated):
                result = subprocess.run(["bash", "-c", script.replace("{{ CommitSha }}", interpolated)],
                                        env={**os.environ, "SSM_CommitSha": SHA}, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, SHA)

    def run_deployment(self, failure=None, sha=SHA):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "bin").mkdir()
        (root / "source/deploy").mkdir(parents=True)
        (root / "source/deploy/web.Dockerfile").touch()
        (root / "compose.yaml").write_text("services: {}\n")
        (root / ".last-web-release").write_text("previous-commit\n")
        for executable in ("docker", "curl", "flock"):
            path = root / "bin" / executable
            path.write_text(MOCK)
            path.chmod(0o755)
        env = {**os.environ, "PATH": f'{root / "bin"}:{os.environ["PATH"]}',
               "ATAPE_APP_DIRECTORY": str(root), "ATAPE_DEPLOY_STATE_DIRECTORY": str(root),
               "EXPECTED_SHA": SHA}
        if failure:
            env[failure] = "1"
        result = subprocess.run(["bash", str(SCRIPT), sha, str(root / "source")],
                                env=env, text=True, capture_output=True)
        commands = root / "commands.jsonl"
        calls = [json.loads(line) for line in commands.read_text().splitlines()] if commands.exists() else []
        return root, result, calls

    def test_success_changes_only_web_and_records_revision(self):
        root, result, calls = self.run_deployment()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / ".last-web-release").read_text(), SHA + "\n")
        self.assertEqual((root / ".previous-web-release").read_text(), "previous-commit\n")
        ups = [call for call in calls if call[0] == "docker" and "up" in call]
        self.assertEqual(len(ups), 1)
        self.assertEqual(ups[0][-1], "web")
        self.assertIn("--no-deps", ups[0])
        self.assertIn("--no-build", ups[0])

    def test_failed_health_check_rolls_back_without_advancing_revision(self):
        root, result, calls = self.run_deployment("FAIL_ROLLOUT")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / ".last-web-release").read_text(), "previous-commit\n")
        self.assertIn(f"atape-web:rollback-{SHA}", (root / "compose.web-release.yaml").read_text())
        self.assertEqual(len([call for call in calls if "up" in call]), 2)

    def test_build_failure_leaves_running_service_untouched(self):
        root, result, calls = self.run_deployment("FAIL_BUILD")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((root / "compose.web-release.yaml").exists())
        self.assertFalse(any("up" in call for call in calls))

    def test_rejects_non_sha_before_executing_commands(self):
        _, result, calls = self.run_deployment(sha="main; touch unexpected")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
