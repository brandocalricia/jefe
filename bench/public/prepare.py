#!/usr/bin/env python3
"""Prepare the "public" split of the Jefe benchmark: a small, seeded sample of SWE-bench Verified.

    python3 bench/public/prepare.py                 # everything: fetch, validate, sample, generate, verify
    python3 bench/public/prepare.py --stage fetch|validate|sample|generate|verify
    python3 bench/public/prepare.py --repos django/django,sympy/sympy --jobs 3

Standard library only. Makes NO model calls. Network is used to download the dataset rows (Hugging Face
datasets-server JSON API), `git clone` the public repositories and `pip install` into virtualenvs under the cache.
Everything big lives OUTSIDE the repo, in ~/.cache/jefe-bench/public/ (override with JEFE_BENCH_PUBLIC_CACHE).
Only bench/public/ is written inside the repo: this script, README.md, manifest.json and envs/*.txt (pip freeze).

This is NOT the official SWE-bench harness (that one needs Docker). Each instance's own FAIL_TO_PASS and
PASS_TO_PASS tests are run in a plain virtualenv on this machine.
"""
import argparse
import concurrent.futures as cf
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get('JEFE_BENCH_PUBLIC_CACHE', str(Path.home() / '.cache' / 'jefe-bench' / 'public')))
PYTHON = '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3'
if not Path(PYTHON).exists():
    PYTHON = sys.executable
DATASET = 'SWE-bench/SWE-bench_Verified'
SEED = 20261117
SAMPLE_SIZE = 12
POOL_TARGET = 30
MAX_TEST_SECONDS = 100  # the runner stops a hidden-test run after 120 s; keep a margin
MAX_P2P_LOSS = 0.30  # drop an instance if more than this share of its PASS_TO_PASS cannot pass here
NET_RE = re.compile(r'ConnectionError|Name or service not known|nodename nor servname|getaddrinfo|Max retries exceeded|Temporary failure in name resolution|URLError', re.I)

# Repositories tried (pure Python, installable on 3.11 / macOS arm64 without compiling).
CANDIDATE_REPOS = {
    'django/django': {'key': 'django', 'kind': 'django', 'pythonpath': []},
    'sympy/sympy': {'key': 'sympy', 'kind': 'sympy', 'pythonpath': []},
    'pytest-dev/pytest': {'key': 'pytest', 'kind': 'pytest', 'pythonpath': ['src']},
    'pylint-dev/pylint': {'key': 'pylint', 'kind': 'pytest', 'pythonpath': []},
    'sphinx-doc/sphinx': {'key': 'sphinx', 'kind': 'pytest', 'pythonpath': []},
}
# Excluded without trying (reason recorded in the manifest).
EXCLUDED_REPOS = {
    'astropy/astropy': 'needs compiled extensions',
    'matplotlib/matplotlib': 'needs compiled extensions',
    'scikit-learn/scikit-learn': 'needs compiled extensions',
    'pydata/xarray': 'needs the compiled numpy/pandas stack',
    'mwaskom/seaborn': 'needs the compiled numpy/pandas/matplotlib stack (and has 1 instance meeting the file filter)',
    'psf/requests': 'no instance has 2 or more non-test source files',
    'pallets/flask': 'no instance has 2 or more non-test source files',
}

CHECK_SCRIPT = r'''#!/usr/bin/env python3
"""Jefe public benchmark hidden check. Runs from the project root with the instance's virtualenv python.
Puts the patched test files back in their real paths, runs exactly the FAIL_TO_PASS + PASS_TO_PASS tests,
prints one JEFE_RESULT json line and exits 0 only if every one of them passed."""
import json, os, re, shutil, subprocess, sys
from pathlib import Path

HID = Path(__file__).resolve().parent
ROOT = Path.cwd()
cfg = json.loads((HID / '_jefe_public_config.json').read_text())
for rel in cfg['files']:
    dst = ROOT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HID / '_jefe_public_files' / (rel + '.jefe'), dst)

env = dict(os.environ)
env['PYTHONPATH'] = os.pathsep.join([str(ROOT)] + [str(ROOT / p) for p in cfg.get('pythonpath', [])])
env['PYTHONDONTWRITEBYTECODE'] = '1'
env['PATH'] = str(Path(sys.executable).parent) + os.pathsep + env.get('PATH', '')
for k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy'):
    env[k] = 'http://127.0.0.1:9'
env['NO_PROXY'] = env['no_proxy'] = 'localhost,127.0.0.1'
f2p, p2p = cfg['f2p'], cfg['p2p']
kind = cfg['kind']
status = {}
cwd = ROOT
if kind == 'django':
    cwd = ROOT / 'tests'
    cmd = [sys.executable, 'runtests.py', '--parallel', '1', '-v', '2'] + cfg['modules']
elif kind == 'sympy':
    cmd = [sys.executable, '-m', 'pytest', '-p', 'no:cacheprovider', '-rA', '-q', '--color=no'] + cfg['files_to_run']
else:
    run_files = sorted({i.split('::')[0] for i in f2p + p2p})
    cmd = [sys.executable, '-m', 'pytest', '-p', 'no:cacheprovider', '-rA', '-q', '--color=no'] + run_files
try:
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, errors='replace', timeout=cfg.get('timeout', 170))
    out = r.stdout + '\n' + r.stderr
except subprocess.TimeoutExpired as e:
    print('JEFE_RESULT ' + json.dumps({'error': 'timeout'}))
    sys.exit(3)
def norm(name):
    # Python 3.11 prints "test_x (mod.Class.test_x)"; the dataset uses "test_x (mod.Class)"
    return re.sub(r'^(\w+) \(([\w.]+)\.\1\)$', r'\1 (\2)', name)


if kind == 'django':
    prev = None
    for ln in out.splitlines():
        ln = norm(ln) if ' ... ' not in ln else ln
        m = re.match(r'^(.*) \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$', ln)
        if m:
            name, st = norm(m.group(1)), m.group(2)
            st = 'passed' if st in ('ok', 'expected failure') else ('skipped' if st.startswith('skipped') else 'failed')
            keys = [name]
            if prev and re.match(r'^\w+ \([\w.]+\)$', prev) and not re.match(r'^\w+ \([\w.]+\)$', name):
                keys.append(prev)
            for k in keys:
                if status.get(k) != 'failed':
                    status[k] = st
        prev = ln
else:
    for ln in out.splitlines():
        m = re.match(r'^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S.*)$', ln)
        if not m:
            continue
        st, name = m.group(1), m.group(2)
        if st in ('FAILED', 'ERROR'):
            name = name.split(' - ')[0]
        if kind == 'sympy':
            name = name.split('::')[-1]
        v = 'passed' if st in ('PASSED', 'XFAIL') else ('failed' if st in ('FAILED', 'ERROR') else 'skipped')
        if status.get(name) != 'failed':
            status[name] = v
def lookup(i):
    if kind == 'django':
        return status.get(norm(i), 'missing')
    if i in status:
        return status[i]
    if kind == 'pytest':  # the dataset cuts some ids at the first space
        m = [v for k, v in status.items() if k.startswith(i)]
        if m:
            return 'passed' if all(v == 'passed' for v in m) else 'failed'
    return 'missing'


res = {i: lookup(i) for i in f2p + p2p}
bad = [i for i, v in res.items() if v != 'passed']
print('JEFE_RESULT ' + json.dumps({'status': res, 'returncode': r.returncode}))
print('jefe-public: %d of %d tests passed' % (len(res) - len(bad), len(res)))
if bad:
    print(out[-3000:])
sys.exit(0 if not bad else 1)
'''

LOCK = threading.Lock()
ENV_LOCKS = {}


def log(*a):
    with LOCK:
        print(time.strftime('%H:%M:%S'), *a, flush=True)


def safe(s):
    return re.sub(r'[^A-Za-z0-9._-]+', '_', s)


def sh(cmd, cwd=None, env=None, timeout=1800, check=True, logfile=None):
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, errors='replace', timeout=timeout)
    if logfile:
        with open(logfile, 'a') as f:
            f.write('$ %s\n%s%s\n' % (' '.join(map(str, cmd)), r.stdout[-4000:], r.stderr[-4000:]))
    if check and r.returncode != 0:
        raise RuntimeError('command failed (%s): %s' % (r.returncode, (r.stderr or r.stdout)[-500:]))
    return r


def discard(path):
    """Never delete: move into the discarded folder."""
    path = Path(path)
    if not path.exists():
        return
    d = CACHE.parent / 'discarded'
    d.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(d / ('%s-%d' % (path.name, time.time_ns()))))


# ---------------------------------------------------------------------------------------------- dataset

def fetch_rows():
    f = CACHE / 'rows.json'
    if f.exists():
        return json.loads(f.read_text())
    rows = []
    off = 0
    while True:
        q = urllib.parse.urlencode({'dataset': DATASET, 'config': 'default', 'split': 'test', 'offset': off, 'length': 100})
        url = 'https://datasets-server.huggingface.co/rows?' + q
        for attempt in range(5):
            try:
                d = json.load(urllib.request.urlopen(url, timeout=60))
                break
            except Exception:
                time.sleep(3 * (attempt + 1))
        else:
            raise SystemExit('could not download dataset rows')
        got = [x['row'] for x in d['rows']]
        rows += got
        off += 100
        if off >= d['num_rows_total']:
            break
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(rows))
    return rows


def diff_files(patch):
    return re.findall(r'^diff --git a/(\S+) b/', patch, re.M)


def is_test_path(f):
    return bool(re.search(r'(^|/)(tests?|testing)(/|$)|(^|/)test_[^/]*\.py$|_tests?\.py$|conftest', f))


def is_source(f):
    return f.endswith('.py') and not is_test_path(f) and not re.match(r'(docs?|extras|scripts)/', f)


def changed_lines(patch):
    return sum(1 for l in patch.splitlines() if l[:1] in '+-' and not l.startswith(('+++', '---')))


def candidates(rows):
    out = []
    for r in rows:
        if r['repo'] not in CANDIDATE_REPOS:
            continue
        if len([f for f in diff_files(r['patch']) if is_source(f)]) >= 2:
            out.append(r)
    return out


def listify(x):
    return json.loads(x) if isinstance(x, str) else list(x)


# ---------------------------------------------------------------------------------------------- repos, trees

def ensure_clone(repo):
    key = CANDIDATE_REPOS[repo]['key']
    d = CACHE / 'repos' / key
    with LOCK:
        lk = ENV_LOCKS.setdefault('clone-' + key, threading.Lock())
    with lk:
        if not (d / '.git').exists() and not (d / 'HEAD').exists():
            d.parent.mkdir(parents=True, exist_ok=True)
            sh(['git', 'clone', '-q', 'https://github.com/%s.git' % repo, str(d)], timeout=3600, check=False)
    return d


def extract_tree(repo, commit, dest):
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    clone = ensure_clone(repo)
    p = subprocess.Popen(['git', '-C', str(clone), 'archive', '--format=tar', commit], stdout=subprocess.PIPE)
    r = subprocess.run(['tar', '-x', '-C', str(dest)], stdin=p.stdout, capture_output=True)
    p.stdout.close()
    p.wait()
    if p.returncode != 0 or r.returncode != 0:
        raise RuntimeError('git archive failed for %s %s' % (repo, commit))


def apply_patch_to_files(repo, base, patch_text, tmp):
    """Apply patch_text to the base versions of just the files it touches, in a scratch folder.
    Returns {path: bytes} of the files that exist afterwards (added/modified)."""
    tmp = Path(tmp)
    clone = ensure_clone(repo)
    for f in diff_files(patch_text):
        r = subprocess.run(['git', '-C', str(clone), 'show', '%s:%s' % (base, f)], capture_output=True)
        if r.returncode == 0:
            (tmp / f).parent.mkdir(parents=True, exist_ok=True)
            (tmp / f).write_bytes(r.stdout)
    pf = tmp.parent / (tmp.name + '.patch')
    pf.write_text(patch_text)
    sh(['git', 'apply', '--whitespace=nowarn', str(pf)], cwd=tmp)
    out = {}
    for f in diff_files(patch_text):
        if (tmp / f).is_file():
            out[f] = (tmp / f).read_bytes()
    discard(pf)
    return out


# ---------------------------------------------------------------------------------------------- environments

def pip_env():
    e = dict(os.environ)
    e['PIP_DISABLE_PIP_VERSION_CHECK'] = '1'
    e['PYTHONDONTWRITEBYTECODE'] = '1'
    return e


def pip_try(venv, args, logfile, env=None):
    r = sh([str(venv / 'bin' / 'pip'), 'install', '-q'] + args, env=env or pip_env(), check=False, logfile=logfile, timeout=1800)
    return r.returncode == 0


def req_lines(path):
    out = []
    for ln in Path(path).read_text().splitlines():
        ln = ln.split('#')[0].strip()
        if ln and not ln.startswith('-'):
            out.append(ln)
    return out


def install_env(repo, version, venv, envsrc, logfile):
    key = CANDIDATE_REPOS[repo]['key']
    env = pip_env()
    if key == 'django':
        if not pip_try(venv, ['-e', str(envsrc)], logfile):
            raise RuntimeError('pip install -e failed')
        req = envsrc / 'tests' / 'requirements' / 'py3.txt'
        for ln in req_lines(req) if req.exists() else []:
            if re.match(r'(selenium|mysql|psycopg|cx_oracle|pylibmc|python-memcached|geoip|redis)', ln, re.I):
                continue
            pip_try(venv, [ln], logfile)
    elif key == 'sympy':
        if not pip_try(venv, ['mpmath', 'pytest', 'hypothesis'], logfile):
            raise RuntimeError('pip install deps failed')
    elif key == 'pytest':
        env['SETUPTOOLS_SCM_PRETEND_VERSION'] = version + '.0'
        if not pip_try(venv, ['-e', str(envsrc)], logfile, env):
            raise RuntimeError('pip install -e failed')
        pip_try(venv, ['hypothesis', 'pygments', 'mock', 'requests', 'xmlschema', 'pexpect', 'argcomplete', 'nose'], logfile, env)
    elif key == 'pylint':
        if not pip_try(venv, ['-e', str(envsrc)], logfile):
            raise RuntimeError('pip install -e failed')
        pip_try(venv, ['pytest==7.4.4', 'pytest-benchmark', 'pytest-timeout', 'pytest-xdist', 'coverage', 'gitpython', 'typing-extensions'], logfile)
    elif key == 'sphinx':
        pins = ['docutils<0.18', 'Jinja2<3.1', 'markupsafe<2.1', 'alabaster<0.7.14', 'Pygments<2.15', 'imagesize<1.5',
                'sphinxcontrib-applehelp<1.0.5', 'sphinxcontrib-devhelp<1.0.3', 'sphinxcontrib-htmlhelp<2.0.2',
                'sphinxcontrib-serializinghtml<1.1.6', 'sphinxcontrib-qthelp<1.0.4', 'pytest==7.4.4', 'html5lib', 'cython']
        if not pip_try(venv, pins, logfile):
            raise RuntimeError('pip install pins failed')
        if not pip_try(venv, ['-e', str(envsrc)], logfile):
            raise RuntimeError('pip install -e failed')
    else:
        raise RuntimeError('no installer')


def ensure_env(repo, row):
    key = CANDIDATE_REPOS[repo]['key']
    version = row['version']
    name = '%s-%s' % (key, version)
    venv = CACHE / 'venvs' / name
    with LOCK:
        lk = ENV_LOCKS.setdefault('env-' + name, threading.Lock())
    with lk:
        marker = venv / '.jefe_ready'
        failed = venv / '.jefe_failed'
        if failed.exists():
            raise RuntimeError('environment ' + name + ' failed to build: ' + failed.read_text()[:300])
        if marker.exists():
            return venv
        logfile = CACHE / 'logs' / ('env-%s.log' % name)
        logfile.parent.mkdir(parents=True, exist_ok=True)
        envsrc = CACHE / 'envsrc' / name
        try:
            if venv.exists():
                discard(venv)
            if envsrc.exists():
                discard(envsrc)
            log('building environment', name)
            extract_tree(repo, row['environment_setup_commit'], envsrc)
            sh([PYTHON, '-m', 'venv', str(venv)])
            install_env(repo, version, venv, envsrc, logfile)
            # pip freeze into the manifest folder (home path made generic)
            fr = sh([str(venv / 'bin' / 'pip'), 'freeze', '--exclude-editable'], check=False).stdout
            (HERE / 'envs').mkdir(exist_ok=True)
            (HERE / 'envs' / (name + '.txt')).write_text(
                '# %s at environment_setup_commit %s, Python %s\n' % (repo, row['environment_setup_commit'], '3.11') + fr)
            # a quick import smoke test is done by the gold check itself
            marker.write_text('ok')
        except Exception as e:
            venv.mkdir(parents=True, exist_ok=True)
            failed.write_text(str(e))
            raise
    return venv


def extras_for(repo, version, envsrc_name):
    """Generated files the repo needs but git does not track (pytest's _version.py)."""
    out = {}
    if CANDIDATE_REPOS[repo]['key'] == 'pytest':
        f = CACHE / 'envsrc' / envsrc_name / 'src' / '_pytest' / '_version.py'
        if f.exists():
            out['src/_pytest/_version.py'] = f.read_bytes()
    return out


# ---------------------------------------------------------------------------------------------- hidden payload

def build_config(repo, row, f2p, p2p, test_files):
    ad = CANDIDATE_REPOS[repo]
    cfg = {'kind': ad['kind'], 'pythonpath': ad['pythonpath'], 'f2p': f2p, 'p2p': p2p, 'files': sorted(test_files), 'timeout': 170}
    if ad['kind'] == 'django':
        mods = set()
        for i in f2p + p2p:
            m = re.search(r'\(([\w.]+)\)$', i)
            if m:
                parts = m.group(1).split('.')
                name = i.split(' ')[0]
                if parts[-1] == name:
                    parts = parts[:-1]
                if len(parts) >= 2:
                    mods.add('.'.join(parts[:-1]))
        for f in test_files:
            m = re.match(r'tests/(.+)\.py$', f)
            if m and not f.endswith('__init__.py') and re.match(r'tests/[\w/]+\.py$', f) and f.count('/') >= 2:
                mods.add(m.group(1).replace('/', '.'))
        cfg['modules'] = sorted(mods)
    elif ad['kind'] == 'sympy':
        cfg['files_to_run'] = sorted(f for f in test_files if f.endswith('.py'))
    return cfg


def write_hidden(dest, cfg, payload):
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / '_jefe_public_check.py').write_text(CHECK_SCRIPT)
    (dest / '_jefe_public_config.json').write_text(json.dumps(cfg, indent=1))
    for rel, data in payload.items():
        p = dest / '_jefe_public_files' / (rel + '.jefe')
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


def run_check(venv, root, hidden, timeout=200):
    t = time.time()
    try:
        r = subprocess.run([str(venv / 'bin' / 'python'), str(Path(hidden) / '_jefe_public_check.py')], cwd=root,
                           capture_output=True, text=True, errors='replace', timeout=timeout)
    except subprocess.TimeoutExpired:
        return {'seconds': time.time() - t, 'timeout': True, 'status': {}, 'rc': None, 'tail': 'timeout'}
    secs = time.time() - t
    status, rc = {}, None
    for ln in r.stdout.splitlines():
        if ln.startswith('JEFE_RESULT '):
            try:
                d = json.loads(ln[len('JEFE_RESULT '):])
                status, rc = d.get('status', {}), d.get('returncode')
            except Exception:
                pass
    return {'seconds': secs, 'timeout': False, 'status': status, 'rc': r.returncode, 'tail': (r.stdout + r.stderr)[-2500:]}


# ---------------------------------------------------------------------------------------------- validation

def state_file(iid):
    return CACHE / 'state' / (safe(iid) + '.json')


def validate_one(row):
    iid = row['instance_id']
    repo = row['repo']
    sf = state_file(iid)
    if sf.exists():
        return json.loads(sf.read_text())
    rec = {'instance_id': iid, 'repo': repo, 'version': row['version']}
    logf = CACHE / 'logs' / (safe(iid) + '.txt')
    logf.parent.mkdir(parents=True, exist_ok=True)
    f2p, p2p = listify(row['FAIL_TO_PASS']), listify(row['PASS_TO_PASS'])
    patch_files = diff_files(row['patch'])
    rec.update({'gold_files': len(patch_files), 'gold_lines': changed_lines(row['patch']), 'f2p': len(f2p), 'p2p_original': len(p2p)})
    vdir = CACHE / 'val' / safe(iid)
    try:
        venv = ensure_env(repo, row)
        if vdir.exists():
            discard(vdir)
        extract_tree(repo, row['base_commit'], vdir)
        for rel, data in extras_for(repo, row['version'], '%s-%s' % (CANDIDATE_REPOS[repo]['key'], row['version'])).items():
            (vdir / rel).parent.mkdir(parents=True, exist_ok=True)
            (vdir / rel).write_bytes(data)
        scratch = CACHE / 'val' / (safe(iid) + '-tp')
        scratch.mkdir(parents=True, exist_ok=True)
        payload = apply_patch_to_files(repo, row['base_commit'], row['test_patch'], scratch)
        discard(scratch)
        cfg = build_config(repo, row, f2p, p2p, payload.keys())
        hidden = CACHE / 'hidden' / safe(iid)
        if hidden.exists():
            discard(hidden)
        write_hidden(hidden, cfg, payload)
        # 1. base + test_patch: every FAIL_TO_PASS test must fail
        b = run_check(venv, vdir, hidden)
        logf.write_text('--- before gold\n' + b['tail'])
        if b['timeout']:
            raise Drop('tests do not finish within the time limit')
        passing_before = [i for i in f2p if b['status'].get(i) == 'passed']
        if passing_before:
            raise Drop('%d FAIL_TO_PASS tests already pass without the gold patch in this environment' % len(passing_before))
        # 2. gold patch: everything passes, twice
        pf = CACHE / 'val' / (safe(iid) + '.gold.patch')
        pf.write_text(row['patch'])
        r = sh(['git', 'apply', '--whitespace=nowarn', str(pf)], cwd=vdir, check=False)
        discard(pf)
        if r.returncode != 0:
            raise Drop('gold patch does not apply')
        g1 = run_check(venv, vdir, hidden)
        with open(logf, 'a') as fh:
            fh.write('\n--- gold run 1\n' + g1['tail'])
        if g1['timeout']:
            raise Drop('tests do not finish within the time limit')
        bad = [i for i in f2p if g1['status'].get(i) != 'passed']
        if bad:
            raise Drop(('needs the network' if NET_RE.search(g1['tail']) else 'FAIL_TO_PASS fails with the gold patch (%d of %d; %s)%s' % (len(bad), len(f2p), g1['status'].get(bad[0], 'missing'), first_error(g1['tail']))))
        g2 = run_check(venv, vdir, hidden)
        with open(logf, 'a') as fh:
            fh.write('\n--- gold run 2\n' + g2['tail'])
        bad2 = [i for i in f2p if g2['status'].get(i) != 'passed']
        if bad2:
            raise Drop('flaky: FAIL_TO_PASS differs between two gold runs')
        eff = [i for i in p2p if g1['status'].get(i) == 'passed' and g2['status'].get(i) == 'passed']
        flaky = [i for i in p2p if (g1['status'].get(i) == 'passed') != (g2['status'].get(i) == 'passed')]
        if p2p and (len(p2p) - len(eff)) / len(p2p) > MAX_P2P_LOSS:
            raise Drop('%d of %d PASS_TO_PASS tests cannot pass in this environment (skipped or failing)' % (len(p2p) - len(eff), len(p2p)))
        secs = max(g1['seconds'], g2['seconds'])
        if secs > MAX_TEST_SECONDS:
            raise Drop('tests take %.0f s (limit %d s)' % (secs, MAX_TEST_SECONDS))
        rec.update({'status': 'valid', 'p2p_effective': eff, 'f2p_list': f2p, 'p2p_dropped': len(p2p) - len(eff), 'p2p_flaky': len(flaky),
                    'seconds': round(secs, 1)})
    except Drop as e:
        rec.update({'status': 'dropped', 'reason': str(e)})
    except Exception as e:
        rec.update({'status': 'dropped', 'reason': 'environment or setup error: ' + str(e)[:300]})
    finally:
        discard(vdir)
    sf.parent.mkdir(parents=True, exist_ok=True)
    sf.write_text(json.dumps(rec))
    log(iid, rec['status'], rec.get('reason', '%ss' % rec.get('seconds')))
    return rec


def first_error(tail):
    for ln in tail.splitlines():
        if ln.startswith('JEFE_RESULT'):
            continue
        m = re.search(r'((?:Import|Type|Attribute|Module[A-Za-z]*|Syntax|Runtime|Name)Error: [^\n]{0,110})', ln)
        if m:
            return ': ' + re.sub(r'/\S+', '<path>', m.group(1))
    return ''


class Drop(Exception):
    pass


def validate_all(cands, jobs):
    groups = {}
    for r in cands:
        groups.setdefault((r['repo'], r['version']), []).append(r)

    def work(rows):
        return [validate_one(r) for r in rows]

    out = []
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        for res in ex.map(work, [groups[k] for k in sorted(groups)]):
            out += res
    return out


# ---------------------------------------------------------------------------------------------- generate / verify

def first_sentence(text, n=140):
    t = re.sub(r'\s+', ' ', text.strip())
    return t[:n].rstrip() + ('...' if len(t) > n else '')


def generate_task(row, rec, tasks_dir):
    iid = row['instance_id']
    repo = row['repo']
    key = CANDIDATE_REPOS[repo]['key']
    venv = ensure_env(repo, row)
    tdir = tasks_dir / safe(iid)
    if tdir.exists():
        discard(tdir)
    fixture = tdir / 'fixture'
    extract_tree(repo, row['base_commit'], fixture)
    for rel, data in extras_for(repo, row['version'], '%s-%s' % (key, row['version'])).items():
        (fixture / rel).parent.mkdir(parents=True, exist_ok=True)
        (fixture / rel).write_bytes(data)
    f2p = rec['f2p_list']
    p2p = rec['p2p_effective']
    scratch = tdir / '_tp'
    scratch.mkdir(parents=True)
    payload = apply_patch_to_files(repo, row['base_commit'], row['test_patch'], scratch)
    cfg = build_config(repo, row, f2p, p2p, payload.keys())
    write_hidden(tdir / 'hidden', cfg, payload)
    discard(scratch)
    scratch = tdir / '_gp'
    scratch.mkdir()
    sol = apply_patch_to_files(repo, row['base_commit'], row['patch'], scratch)
    for rel, data in sol.items():
        (tdir / 'solution' / rel).parent.mkdir(parents=True, exist_ok=True)
        (tdir / 'solution' / rel).write_bytes(data)
    discard(scratch)
    py = venv / 'bin' / 'python'
    (tdir / 'prompt.md').write_text(
        'Please resolve this issue in the repository.\n\n' + row['problem_statement'].rstrip() + '\n\nANSWERS:\n'
        '- Language and runtime: Python 3.11 (the project\'s dependencies are installed in the virtualenv at %s; its interpreter is %s)\n'
        '- Where: this repository\n'
        '- Design: follow the project\'s existing conventions\n'
        '- Scope: fix the issue only; do not modify the existing tests\n' % (venv, py))
    meta = {'id': safe(iid), 'size': 'job', 'split': 'public', 'language': 'python',
            'summary': first_sentence(row['problem_statement'].splitlines()[0] if row['problem_statement'].strip() else iid),
            'test': [str(py), 'tests/_jefe_public_check.py'], 'testEnv': {'PATH_PREPEND': str(venv / 'bin')},
            'expectedFiles': len(diff_files(row['patch'])),
            'source': {'dataset': 'SWE-bench_Verified', 'instance_id': iid}}
    (tdir / 'task.json').write_text(json.dumps(meta, indent=1) + '\n')
    return tdir


def copy_tree(src, dst):
    shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)


def verify_task(tdir):
    meta = json.loads((tdir / 'task.json').read_text())
    work = CACHE / 'work' / ('%s-%d' % (tdir.name, time.time_ns()))
    copy_tree(tdir / 'fixture', work)
    (work / 'tests').mkdir(exist_ok=True)
    for p in sorted((tdir / 'hidden').iterdir()):
        if p.is_dir():
            copy_tree(p, work / 'tests' / p.name)
        else:
            shutil.copy2(p, work / 'tests' / p.name)
    env = dict(os.environ)
    env['PATH'] = meta['testEnv']['PATH_PREPEND'] + os.pathsep + env['PATH']

    def run():
        t = time.time()
        try:
            r = subprocess.run(meta['test'], cwd=work, env=env, capture_output=True, text=True, errors='replace', timeout=120)
            return r.returncode, time.time() - t, r.stdout[-300:]
        except subprocess.TimeoutExpired:
            return 'timeout', time.time() - t, ''

    rc1, t1, _ = run()
    copy_tree(tdir / 'solution', work)
    rc2, t2, tail = run()
    discard(work)
    cfg = json.loads((tdir / 'hidden' / '_jefe_public_config.json').read_text())
    return {'fails_before': rc1 not in (0, 'timeout'), 'passes_after': rc2 == 0, 'seconds_after': round(t2, 1),
            'seconds_before': round(t1, 1), 'f2p': len(cfg['f2p']), 'p2p': len(cfg['p2p']), 'tail': tail if rc2 != 0 else ''}


# ---------------------------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='all', choices=['all', 'fetch', 'validate', 'sample', 'generate', 'verify'])
    ap.add_argument('--repos', default=','.join(CANDIDATE_REPOS))
    ap.add_argument('--jobs', type=int, default=3)
    ap.add_argument('--limit', type=int, default=0, help='debug: validate at most N candidates')
    ap.add_argument('--stop-at', type=int, default=0, help='stop validating a version group early once this many valid exist overall (0 = never)')
    a = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    started = time.time()
    rows = fetch_rows()
    byid = {r['instance_id']: r for r in rows}
    repos = set(a.repos.split(','))
    cands = [r for r in candidates(rows) if r['repo'] in repos]
    log('dataset rows:', len(rows), 'eligible candidates:', len(cands))
    if a.stage == 'fetch':
        return
    if a.limit:
        cands = cands[:a.limit]
    recs = validate_all(cands, a.jobs) if a.stage in ('all', 'validate', 'sample', 'generate', 'verify') else []
    valid = sorted(r['instance_id'] for r in recs if r['status'] == 'valid')
    dropped = {r['instance_id']: r['reason'] for r in recs if r['status'] == 'dropped'}
    log('validated pool: %d of %d candidates' % (len(valid), len(cands)))
    if a.stage == 'validate':
        return
    k = min(SAMPLE_SIZE, len(valid))
    chosen = random.Random(SEED).sample(valid, k)
    log('chosen:', chosen)
    if a.stage == 'sample':
        return
    tasks_dir = CACHE / 'tasks'
    tasks_dir.mkdir(exist_ok=True)
    recmap = {r['instance_id']: r for r in recs}
    for iid in chosen:
        generate_task(byid[iid], recmap[iid], tasks_dir)
        log('generated', iid)
    table = []
    for iid in chosen:
        v = verify_task(tasks_dir / safe(iid))
        rec = recmap[iid]
        table.append({'instance_id': iid, 'repo': byid[iid]['repo'], 'gold_files': rec['gold_files'], 'gold_lines': rec['gold_lines'],
                      'f2p': v['f2p'], 'p2p': v['p2p'], 'seconds': v['seconds_after'], 'fails_before': v['fails_before'],
                      'passes_after': v['passes_after']})
        log('verified', iid, v['fails_before'], v['passes_after'], v['tail'][-150:] if v['tail'] else '')
    reasons = {}
    for r in dropped.values():
        key = re.sub(r'\d+', 'N', r)[:90]
        reasons[key] = reasons.get(key, 0) + 1
    manifest = {
        'dataset': DATASET, 'dataset_url': 'https://huggingface.co/datasets/' + DATASET, 'split': 'test',
        'seed': SEED, 'sample': 'random.Random(%d).sample(sorted(validated_ids), %d)' % (SEED, SAMPLE_SIZE),
        'filter': {
            'repositories_tried': sorted(CANDIDATE_REPOS), 'repositories_excluded': EXCLUDED_REPOS,
            'gold_patch': 'at least 2 non-test Python source files (not under docs/, doc/, extras/, scripts/)',
            'relaxation': 'not needed: %d candidates met the filter before validation (threshold for relaxing was 30)' % len(candidates(rows)),
            'tests_time': 'FAIL_TO_PASS + PASS_TO_PASS finish in under %d s here' % MAX_TEST_SECONDS,
            'gold_check': 'base + test_patch: all FAIL_TO_PASS fail; + gold patch: all FAIL_TO_PASS and PASS_TO_PASS pass in two runs, network blocked; PASS_TO_PASS tests that cannot pass in this environment are removed, and the instance is dropped if more than %d%% of them are' % int(MAX_P2P_LOSS * 100),
        },
        'candidates_before_validation': len(cands), 'validated_pool_size': len(valid), 'chosen': chosen,
        'validated_ids': valid, 'dropped': dropped, 'dropped_reason_counts': reasons,
        'tasks': table,
        'official_harness': False,
    }
    (HERE / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')
    log('wrote manifest; preparation took %.0f s' % (time.time() - started))
    hdr = '| instance | repo | gold files | gold lines | F2P | P2P | test s | fails before | passes after |\n|---|---|---|---|---|---|---|---|---|'
    print(hdr)
    for t in table:
        print('| %s | %s | %d | %d | %d | %d | %s | %s | %s |' % (t['instance_id'], t['repo'], t['gold_files'], t['gold_lines'], t['f2p'], t['p2p'],
                                                               t['seconds'], 'yes' if t['fails_before'] else 'NO', 'yes' if t['passes_after'] else 'NO'))


if __name__ == '__main__':
    main()
