import subprocess,os,signal,time,json,pathlib,sys,argparse,platform,shutil
parser=argparse.ArgumentParser(description="Five-round retention probe; original macOS time -l units, new external output only")
parser.add_argument("--bundle",type=pathlib.Path,required=True)
parser.add_argument("--output",type=pathlib.Path,required=True)
parser.add_argument("--node",default="node")
a=parser.parse_args()
assert platform.system()=="Darwin", "time -l resource units require macOS"
bundle=a.bundle.resolve();assert bundle.is_file()
node=shutil.which(a.node);assert node
p=a.output.resolve();assert not p.is_relative_to(pathlib.Path(__file__).resolve().parents[4]), "output must be outside repository"
p.mkdir(parents=True,exist_ok=False)
deadline=time.monotonic()+450
results=[]
for mode in ["clean"]:
    with (p/(mode+".jsonl")).open("w") as out,(p/(mode+".time.txt")).open("w") as err:
        child=subprocess.Popen(["/usr/bin/time","-l",node,str(bundle),mode],stdout=out,stderr=err,start_new_session=True)
        try: child.wait(timeout=max(0.01,deadline-time.monotonic()))
        except subprocess.TimeoutExpired:
            os.killpg(child.pid,signal.SIGKILL);child.wait();results.append({"mode":mode,"timeout":True});break
    results.append({"mode":mode,"returncode":child.returncode})
    print(json.dumps(results[-1]),flush=True)
    if child.returncode: break
(p/"controller-results.json").write_text(json.dumps(results,indent=2))

assert len(results)==1 and results[0].get("returncode")==0 and not results[0].get("timeout"),results
lines=[json.loads(line) for line in (p/"clean.jsonl").read_text().splitlines()]
final=next(value for value in lines if value["type"]=="final")
assert final["ok"] and len(final["rounds"])==5,final
print(json.dumps({"status":"PASS","rounds":5,"sourceAndJournalScratch":final["dir"],"scope":"Module TestAdapter receipts only; no HTTP ACK"}))
