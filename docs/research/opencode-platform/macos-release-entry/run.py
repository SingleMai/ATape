#!/usr/bin/env python3
"""Run the exact supplied tarball against a fresh native macOS arm64 OpenCode fixture.
No build/pack, no user history, no installation outside a new scratch directory.
"""
import argparse,hashlib,json,os,platform,shutil,signal,subprocess,sys
from pathlib import Path

OFFICIAL_SHA="2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62"

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    for name in ['binary','tarball','output']:ap.add_argument('--'+name,type=Path,required=True)
    ap.add_argument('--sha256',required=True);ap.add_argument('--candidate',required=True)
    ap.add_argument('--version',default='0.4.8');ap.add_argument('--node',default='node')
    a=ap.parse_args()
    assert platform.system()=='Darwin' and platform.machine()=='arm64'
    assert sha(a.binary)==OFFICIAL_SHA,'official binary hash mismatch'
    assert sha(a.tarball)==a.sha256,'candidate tarball hash mismatch'
    node=Path(shutil.which(a.node) or a.node).resolve();assert node.is_file()
    nodeInfo=json.loads(subprocess.check_output([str(node),'-p','JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],text=True))
    assert nodeInfo['platform']=='darwin' and nodeInfo['arch']=='arm64' and nodeInfo['version'].startswith('v24.')
    scripts=Path(__file__).resolve().parent;out=a.output.resolve()
    assert not out.is_relative_to(scripts.parents[3]),'output must be outside repository'
    out.mkdir(parents=True,exist_ok=False);(out/'home').mkdir()
    (out/'npm-user.conf').write_text('');(out/'npm-global.conf').write_text('')
    shutil.copyfile(a.tarball,out/'adapter.tgz')
    env={'PATH':str(node.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(out/'home'),'TMPDIR':str(out),'LANG':'en_US.UTF-8','NPM_CONFIG_USERCONFIG':str(out/'npm-user.conf'),'NPM_CONFIG_GLOBALCONFIG':str(out/'npm-global.conf'),'NPM_CONFIG_CACHE':str(out/'npm-cache')}
    provenance={'candidateCommit':a.candidate,'tarballSHA256':sha(out/'adapter.tgz'),'officialBinarySHA256':sha(a.binary),'officialVersion':'1.18.30','officialSourceCommit':'3104c1428ec91f809e5ab86631300de41eb6952e','platform':platform.platform(),'node':nodeInfo,'expectedAdapterVersion':a.version,'scriptsSHA256':{n:sha(scripts/n) for n in ['generate-native.py','verify-native.mjs','run.py']}}
    (out/'run-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    def run(command,log):
        with (out/log).open('w') as f:
            child=subprocess.Popen(command,env=env,cwd=out,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
            try:code=child.wait(timeout=180)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGKILL);child.wait();raise
        assert code==0, f'{command[0]} failed; see {out/log}'
    run([sys.executable,str(scripts/'generate-native.py'),'--binary',str(a.binary.resolve())],'generation.stdout')
    npm=node.parent/'npm';assert npm.exists()
    run([str(npm),'install','--offline','--ignore-scripts','--no-audit','--no-fund','--prefix',str(out/'installed'),str(out/'adapter.tgz')],'install.stdout')
    entry=out/'installed/node_modules/@atape/adapter-opencode/dist/index.js'
    run([str(node),str(scripts/'verify-native.mjs'),str(entry),str(out),a.version],'verification.stdout')
    assert sha(a.tarball)==a.sha256,'input tarball changed during validation'
    print((out/'verification.stdout').read_text())
    print('evidence='+str(out))

if __name__=='__main__':main()
