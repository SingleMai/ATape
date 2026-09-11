import json,pathlib,sqlite3,hashlib,argparse
parser=argparse.ArgumentParser(description="Read completed retention probe and its quiescent SQLite database; preserve original evidence")
parser.add_argument("--input",type=pathlib.Path,required=True,help="Runner output directory")
parser.add_argument("--output",type=pathlib.Path,required=True,help="New compact JSON file")
parser.add_argument("--database",type=pathlib.Path,help="Optional relocated completed database")
a=parser.parse_args();p=a.input.resolve();assert not a.output.exists(), "refuse to replace original evidence"
lines=[json.loads(l) for l in (p/"clean.jsonl").read_text().splitlines()]
f=next(v for v in lines if v["type"]=="final")
assert f["ok"] and len(f["rounds"])==5
db=(a.database or pathlib.Path(f["dir"])/"journal.sqlite").resolve()
assert db.is_file()
for suffix in ["-wal","-shm"]:
 sidecar=pathlib.Path(str(db)+suffix)
 assert not sidecar.exists() or sidecar.stat().st_size==0, "immutable verification requires completed, checkpointed DB with no active sidecars"
c=sqlite3.connect(db.as_uri()+"?mode=ro&immutable=1",uri=True);c.row_factory=sqlite3.Row
q=lambda s:[dict(r) for r in c.execute(s)]
verify={"currentMembership":q("SELECT kind,count(*) count FROM capture_records WHERE capture_id='capture-5' GROUP BY kind"),"historicalMembershipCount":q("SELECT count(*) count FROM capture_records WHERE capture_id!='capture-5'"),"sourceVersionRevisionCounts":q("SELECT revision,count(*) count FROM source_record_versions GROUP BY revision"),"firstRawProofs":q("SELECT disposition,(body IS NULL) reclaimed,(receipt_json IS NOT NULL) receipt,count(*) count FROM units WHERE capture_id='capture-1' AND kind='raw' GROUP BY disposition,reclaimed,receipt"),"danglingRawBindings":q("SELECT count(*) count FROM capture_records r LEFT JOIN units u ON u.scope_key=r.scope_key AND u.capture_id=r.unit_capture AND u.kind=r.unit_kind AND u.ordinal=r.unit_ordinal WHERE r.kind='raw' AND r.unit_capture IS NOT NULL AND u.capture_id IS NULL"),"fileAllocation":q("PRAGMA page_count"),"freePages":q("PRAGMA freelist_count")}
assert {r['kind']:r['count'] for r in verify['currentMembership']}=={'event':10000,'raw':20001,'session':1,'thread':1}
assert verify['historicalMembershipCount'][0]['count']==0
assert verify['firstRawProofs']==[{'disposition':'acknowledged','reclaimed':1,'receipt':1,'count':201}]
assert verify['danglingRawBindings'][0]['count']==0
for row in q("SELECT ordinal,receipt_json FROM units WHERE capture_id='capture-1' AND kind='raw'"):
 assert json.loads(row['receipt_json'])=={'fixture':'SIMULATED-MODULE-ACK-NOT-HTTP','captureId':'capture-1','ordinal':row['ordinal']}
c.close()
rounds=[]
for r in f['rounds']:
 rounds.append({'round':r['round'],'prepareMs':r['preparationMs'],'cleanupMs':r['cleanupMs'],'pruneMs':r['pruneMs'],'canonicalBytes':r['prepared']['value']['bytes'],'raw':r['prepared']['value']['raw'],'pruned':r['prunedRecords'],'pruneBatches':r['pruneBatches'],'maxPruneBatch':r['maxPruneBatch'],'metadataBeforePrune':r['beforePrune']['account']['metadata_entries'],'metadataAfterPrune':r['afterCleanup']['account']['metadata_entries'],'actualRows':r['afterCleanup']['tables'],'retainedBytes':r['afterCleanup']['account']['retained_bytes'],'currentEvents':r['currentEventCount'],'stableOriginalRawRefs':r['stableOriginalRawRefs'],'rssBytes':r['afterCleanup']['rssBytes'],'processMaxRSSKiB':r['afterCleanup']['processMaxRSSKiB'],'filesAfterPreparation':r['afterPreparation']['files'],'filesAfterCleanup':r['afterCleanup']['files']})
out={'baseline':f['baseline'],'platform':f['platform'],'arch':f['arch'],'node':f['node'],'elapsedMs':f['elapsedMs'],'limits':f['limits'],'rounds':rounds,'resources':f['resources'],'afterClose':f['afterClose'],'reopenedReadonlyVerification':verify,'receiptEvidence':f['receiptEvidence']}
a.output.write_text(json.dumps(out,indent=2))
print(json.dumps(out,indent=2))
