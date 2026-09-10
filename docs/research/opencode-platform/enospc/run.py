#!/usr/bin/env python3
"""Run a previously built probe in a disposable 16 MiB tmpfs, never host disk."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid

IMAGE="node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2"
p=argparse.ArgumentParser(description=__doc__)
p.add_argument("--bundle",type=Path,required=True)
p.add_argument("--output",type=Path,required=True)
p.add_argument("--expected-reason",choices=["io","capacity"],default="io",
               help="io reproduces original 000668f failure; capacity tests a separately identified fix")
a=p.parse_args()
assert a.bundle.is_file()
assert not a.output.exists(), "do not overwrite original evidence"
name="atape-enospc-"+uuid.uuid4().hex[:12]
subprocess.run(["docker","create","--name",name,"--platform","linux/arm64","--network","none","--memory","256m","--tmpfs","/disk:rw,size=16777216,mode=700",IMAGE,"node","/prototype.mjs","orchestrate"],check=True)
try:
    subprocess.run(["docker","cp",str(a.bundle.resolve()),name+":/prototype.mjs"],check=True)
    result=subprocess.run(["docker","start","--attach",name],capture_output=True,text=True,timeout=300)
    a.output.write_text(result.stdout)
    a.output.with_suffix(".stderr.txt").write_text(result.stderr)
    result.check_returncode()
finally:
    subprocess.run(["docker","rm","--force",name],check=True)
# The original prototype collects diagnostics and can exit zero after a phase
# error. Validate its public results here; container exit alone proves nothing.
rows=json.loads(result.stdout)["results"]
assert len(rows)==7
phases=[]
for row in rows:
    assert row.get("status")==0 and row.get("signal") is None, row
    value=json.loads(row["stdout"])
    assert "error" not in value, value
    phases.append(value)
seed,before,write,reopen,free,recover,after=phases
w=write["result"]; original=seed["result"]["before"]
assert w["fillResult"]["code"]=="ENOSPC"
assert w["fillResult"]["fs"]["availableBytes"]==0
assert w["error"]["reason"]==a.expected_reason, w["error"]
assert w["before"]==w["after"]==reopen["result"]==recover["result"]["before"]==recover["result"]["after"]==original
assert original["checkpoint"] is None
assert original["capture"]["activationReceipt"] is None
assert all(unit["disposition"]=="pending" and unit["receiptJson"] is None for unit in original["units"])
assert w["next"]["units"]==[] and w["next"]["capture"]["retainedBytes"]==0
assert recover["result"]["nextPayload"]["bytes"]==2097152
for physical in [before,after]: assert physical["result"]["integrity"]==[{"integrity_check":"ok"}]
print(json.dumps({"status":"PASS","expectedPublicFailureReason":a.expected_reason,"realENOSPC":True,"retainedSnapshotUnchanged":True,"failedAppendLeftNoUnit":True,"recoverySucceeded":True}))
