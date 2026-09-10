from pathlib import Path
import subprocess,os,signal,json,re,time,argparse,platform,shutil
parser=argparse.ArgumentParser(description="macOS whole-process capacity probe; new external output, never overwrite original measurements")
parser.add_argument("--bundle",type=Path,required=True)
parser.add_argument("--output",type=Path,required=True)
parser.add_argument("--node",default="node")
parser.add_argument("--case",action="append",choices=["1000-off-normal","1000-on-normal","10000-off-normal","10000-on-normal","1000-off-target-limit"])
args=parser.parse_args()
assert platform.system()=="Darwin", "time -l RSS byte units are macOS-specific; do not relabel Linux results"
bundle=args.bundle.resolve();assert bundle.is_file()
node=shutil.which(args.node);assert node, "Node executable unavailable"
root=args.output.resolve();assert not root.is_relative_to(Path(__file__).resolve().parents[4]), "output must be outside repository"
root.mkdir(parents=True,exist_ok=False)
cases=[(1000,"off","normal"),(1000,"on","normal"),(10000,"off","normal"),(10000,"on","normal"),(1000,"off","target-limit")]
if args.case:cases=[c for c in cases if f"{c[0]}-{c[1]}-{c[2]}" in args.case]
results=[]
for n,raw,mode in cases:
 name=f"{n}-{raw}-{mode}"
 print("START "+name,flush=True)
 start=time.monotonic()
 proc=subprocess.Popen(["/usr/bin/time","-l",node,str(bundle),str(n),raw,mode],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
 timed_out=False
 try:stdout,stderr=proc.communicate(timeout=120)
 except subprocess.TimeoutExpired:
  timed_out=True;os.killpg(proc.pid,signal.SIGKILL);stdout,stderr=proc.communicate()
 elapsed=time.monotonic()-start
 (root/(name+".stdout.json")).write_text(stdout)
 (root/(name+".time.txt")).write_text(stderr)
 rss=re.search(r"(\d+)\s+maximum resident set size",stderr)
 item={"case":name,"exitCode":proc.returncode,"timeout":timed_out,"processWallSeconds":elapsed,"maxRSSBytes":int(rss.group(1)) if rss else None}
 try:item["output"]=json.loads(stdout)
 except Exception:item["stdoutTail"]=stdout[-1000:]
 results.append(item);(root/"results.json").write_text(json.dumps(results,ensure_ascii=False,indent=2))
 p=item.get("output",{}).get("result",{}).get("prepared",{})
 print(json.dumps({"case":name,"wall":round(elapsed,3),"rss":item["maxRSSBytes"],"prepared":p,"error":item.get("output",{}).get("error"),"timeout":timed_out},ensure_ascii=False),flush=True)

# Exit status alone is insufficient: capacity.ts reports typed failures as JSON.
for item in results:
 assert item["exitCode"]==0 and not item["timeout"] and item["maxRSSBytes"] is not None,item
 output=item["output"];assert "error" not in output,output
 result=output["result"];prepared=result["prepared"]
 if output["case"]["mode"]=="normal":
  assert prepared["ok"] and result["captureState"]=="sealed",result
  assert result["activationReceipt"] is None and result["checkpoint"] is None,result
  assert result["contentTransportCalls"]==0,result
 else:
  assert not prepared["ok"] and prepared["error"]["reason"]=="capacity",result
  assert result["captureState"]=="preparing" and result["seal"] is None,result
  assert result["checkpoint"]==result["baseline"]["checkpoint"]=="baseline-head",result
print(json.dumps({"status":"PASS","cases":len(results),"scope":"whole process on macOS; local preparation, no real HTTP ACK"}))
