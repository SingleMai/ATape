#!/usr/bin/env python3
"""Download the pinned official Darwin arm64 release into scratch, never install."""
import hashlib
from pathlib import Path
import platform
import tempfile
import urllib.request
import zipfile

assert platform.system() == "Darwin" and platform.machine() == "arm64", "Only verified Darwin arm64 asset supported"
target = Path(tempfile.mkdtemp(prefix="atape-opencode-11830-binary-"))
archive = target / "opencode-darwin-arm64.zip"
urllib.request.urlretrieve("https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-darwin-arm64.zip", archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == "a5e43d6887386efc7d68ce49ae28e3bbdfdee3dfd1d7169b612c3ce67e53b1e8"
with zipfile.ZipFile(archive) as payload:
    assert payload.namelist() == ["opencode"]
    payload.extract("opencode", target)
binary = target / "opencode"
binary.chmod(0o755)
print(binary)
