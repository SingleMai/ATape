#!/usr/bin/env python3
"""Fresh isolated Linux arm64 native probe; no host OpenCode execution.

Requires Docker and an already-built exact candidate adapter tarball. Output must be a
new directory outside the checkout. Only the selected tarball and controlled
scripts/binary enter the disposable container. No host directories are mounted.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
import uuid

IMAGE = "node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2"
URL = "https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-linux-arm64.tar.gz"
ARCHIVE_SHA = "4111a55c2a02c0fac314bd51e9a2330280e6d29d2b85b9554fff6d62612566ed"
ORIGINAL_TARBALL_SHA = "57e02deb5cb44654e76f0cdfafc5ca957c50065ee029252cfd82a8b714b9ac54"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tarball", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--archive", type=Path, help="Optional existing official archive; hash still checked")
    parser.add_argument("--expected-tarball-sha256", default=ORIGINAL_TARBALL_SHA,
                        help="Explicitly change when testing a different candidate; never replace recorded original results")
    args = parser.parse_args()
    assert digest(args.tarball) == args.expected_tarball_sha256, "candidate tarball hash mismatch"
    output = args.output.resolve()
    source = Path(__file__).resolve().parent
    assert not output.is_relative_to(source.parents[3]), "output must be outside repository"
    output.mkdir(parents=True, exist_ok=False)
    stage = output / "input"
    stage.mkdir()
    archive = stage / "opencode-linux-arm64.tar.gz"
    if args.archive:
        shutil.copyfile(args.archive, archive)
    else:
        urllib.request.urlretrieve(URL, archive)
    assert digest(archive) == ARCHIVE_SHA, "official archive hash mismatch"
    (stage / "bin").mkdir()
    with tarfile.open(archive) as bundle:
        assert bundle.getnames() == ["opencode"]
        binary = stage / "bin/opencode"
        binary.write_bytes(bundle.extractfile("opencode").read())
        binary.chmod(0o755)
    for name in ["generate-linux.py", "verify-native.mjs"]:
        shutil.copyfile(source / name, stage / name)
    shutil.copyfile(args.tarball, stage / "adapter.tgz")
    (stage / "inside.py").write_text(INSIDE)
    (output / "run-provenance.json").write_text(json.dumps({
        "imageIndex": IMAGE, "releaseURL": URL, "archiveSHA256": digest(archive),
        "binarySHA256": digest(binary), "adapterTarballSHA256": digest(args.tarball),
        "network": "none", "mounts": [], "platformRequested": "linux/arm64",
    }, indent=2))
    name = "atape-native-" + uuid.uuid4().hex[:12]
    subprocess.run(["docker", "create", "--name", name, "--platform", "linux/arm64",
                    "--network", "none", "--memory", "2g", "--cpus", "2", "--cap-drop", "ALL",
                    "--security-opt", "no-new-privileges", "--workdir", "/evidence", IMAGE,
                    "python3", "/evidence/inside.py"], check=True)
    try:
        subprocess.run(["docker", "cp", str(stage) + "/.", name + ":/evidence"], check=True)
        with (output / "stdout.txt").open("w") as log:
            result = subprocess.run(["docker", "start", "--attach", name], stdout=log,
                                    stderr=subprocess.STDOUT, timeout=600)
        # Includes synthetic source database and executable locally, never commit them.
        subprocess.run(["docker", "cp", name + ":/evidence", str(output / "container")], check=True)
        result.check_returncode()
    finally:
        subprocess.run(["docker", "rm", "--force", name], check=True)
    print(output / "container/adapter-results.json")


INSIDE = r"""import subprocess, pathlib, platform, json
p=pathlib.Path('/evidence')
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/evidence/harness-home','TMPDIR':'/evidence','LANG':'C.UTF-8'}
pathlib.Path(env['HOME']).mkdir()
(p/'container-platform.json').write_text(json.dumps({'platform':platform.platform(),'machine':platform.machine(),'libc':platform.libc_ver(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'network':'none'},indent=2))
for command, log in [(['python3','/evidence/generate-linux.py','--binary','/evidence/bin/opencode'],'generation.stdout'),(['npm','install','--offline','--ignore-scripts','--no-audit','--no-fund','--prefix','/evidence/installed','/evidence/adapter.tgz'],'install.stdout'),(['node','/evidence/verify-native.mjs','/evidence/installed/node_modules/@atape/adapter-opencode/dist/index.js','/evidence'],'verification.stdout')]:
    with (p/log).open('w') as f:
        subprocess.run(command,env=env,cwd=p,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=180)
    print((p/log).read_text(),flush=True)
"""

if __name__ == "__main__":
    main()
