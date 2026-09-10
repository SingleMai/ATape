"""Start only a disposable PostgreSQL container and temporary dependency venv."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
import uuid

IMAGE = "postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
ROOT = Path(__file__).resolve().parent


def command(*args, capture=True):
    return subprocess.run(args, check=True, text=True, capture_output=capture)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=ROOT / "results.json")
    args = parser.parse_args()
    name = "atape-publication-probe-" + uuid.uuid4().hex[:12]
    password = uuid.uuid4().hex  # Disposable local fixture credential, never a real account.
    result = {"status": "failed", "model": "standalone-prototype-not-production-interface",
              "postgres_image": IMAGE, "host": platform.platform(), "container_removed": False}
    started = False
    try:
        with tempfile.TemporaryDirectory(prefix="atape-pg-publication-") as temporary:
            scratch = Path(temporary)
            python = scratch / "venv/bin/python"
            print("Preparing temporary Python dependencies", flush=True)
            command(sys.executable, "-m", "venv", str(scratch / "venv"))
            command(str(python), "-m", "pip", "install", "--disable-pip-version-check", "--quiet",
                    "psycopg[binary]==3.2.10", "typing_extensions==4.15.0", capture=False)
            command("docker", "run", "--detach", "--rm", "--name", name,
                    "--label", "atape.purpose=disposable-publication-probe",
                    "--tmpfs", "/var/lib/postgresql/data:rw", "--publish", "127.0.0.1::5432",
                    "--env", "POSTGRES_DB=atape_publication_probe", "--env", "POSTGRES_USER=probe",
                    "--env", "POSTGRES_PASSWORD=" + password, IMAGE)
            started = True
            deadline = time.monotonic() + 45
            while True:
                ready = subprocess.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "probe",
                                        "-d", "atape_publication_probe"], capture_output=True)
                if ready.returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("ephemeral PostgreSQL did not become ready")
                time.sleep(0.2)
            address = command("docker", "port", name, "5432/tcp").stdout.strip()
            assert address.startswith("127.0.0.1:"), address
            env = dict(os.environ, PROBE_PG_DSN=("host=127.0.0.1 port=" + address.rsplit(":", 1)[1]
                       + " dbname=atape_publication_probe user=probe password=" + password))
            output = scratch / "probe-results.json"
            print("Running real PostgreSQL / localhost HTTP scenarios", flush=True)
            execution = subprocess.run([str(python), str(ROOT / "probe.py"), str(output)], env=env)
            if output.exists():
                result.update(json.loads(output.read_text()))
            if execution.returncode:
                raise RuntimeError("probe exited " + str(execution.returncode))
    except Exception as error:
        result["status"] = "failed"
        result["runner_error"] = str(error)
    finally:
        if started:
            cleanup = subprocess.run(["docker", "rm", "--force", name], capture_output=True, text=True)
            result["container_removed"] = cleanup.returncode == 0
            if not result["container_removed"]:
                result["cleanup_error"] = cleanup.stderr
                result["status"] = "failed"
        args.results.parent.mkdir(parents=True, exist_ok=True)
        args.results.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("Result:", result["status"], "—", args.results, flush=True)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
