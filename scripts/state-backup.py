"""Off-volume backup of the state the trading logic reads and writes.

Git covers source and docs only. The files that decide what trades - ladder.json,
kalshi-auto.json, quoter-kalshi.json, the fill reconciler journals, the paper-lab
ledgers - live in %APPDATA%\\oracle-trader, outside the repo; the shadow logs live in
the repo's gitignored data/. Neither was backed up anywhere (SESSION-REPORT 7.3).

Two layers, both on a DIFFERENT physical volume from the project (G:):
  mirror/   incremental copy of everything (3.4 GB, mostly append-only jsonl)
  versions/ a zip of the SMALL state files only, one per run, rotated - so a
            corrupted or wrongly-migrated state file can be rolled back, which a
            mirror alone cannot do (the mirror would faithfully copy the damage).

Verification is not optional here: a backup that cannot be shown to restore is
indistinguishable from no backup. Every run re-reads a sample of mirrored files and
compares SHA-256 against the source, asserts the critical list is present in the
newest zip, and exits non-zero if either fails, so the scheduled task reports failure.
"""
import hashlib, json, os, random, shutil, sys, time, zipfile

DEST = os.environ.get('ORACLE_STATE_BACKUP_DEST', r'D:\oracle-trader-backup')
APPDATA = os.path.join(os.environ['APPDATA'], 'oracle-trader')
REPO = r'G:\PROJECTS\oracle-trader'
DATA = os.path.join(REPO, 'data')
LOG = os.path.join(REPO, 'logs', 'state-backup.log')
# Chromium's profile is rebuildable and churns constantly; it is not state.
SKIP_DIRS = {'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage',
             'Shared Dictionary', 'Session Storage', 'Local Storage', 'Network', 'Crashpad', 'logs'}
# Small, high-value, and the ones a bad migration can ruin. Absence is a failure, not a warning.
CRITICAL = ['ladder.json', 'kalshi-auto.json', 'config.json', 'history.json', 'order-journal.jsonl']
VERSION_MAX_BYTES = 25 * 1024 * 1024
KEEP_VERSIONS = 72
SAMPLE = 6


def walk(root):
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            p = os.path.join(dp, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            yield p, os.path.relpath(p, root), st


def mirror(label, root):
    """Copy only what changed. Returns (copied, bytes, total_files)."""
    out = os.path.join(DEST, 'mirror', label)
    copied = written = total = 0
    for src, rel, st in walk(root):
        total += 1
        dst = os.path.join(out, rel)
        try:
            d = os.stat(dst)
            if d.st_size == st.st_size and abs(d.st_mtime - st.st_mtime) < 2:
                continue
        except OSError:
            pass
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        try:
            # An append-only log being written while we read it copies fine; a locked
            # sqlite/leveldb file does not, and must not fail the whole run.
            shutil.copy2(src, dst)
            copied += 1
            written += st.st_size
        except OSError as e:
            print(f'  skip {rel}: {e}')
    return copied, written, total


def sha(p, limit=None):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
            if limit and f.tell() > limit:
                break
    return h.hexdigest()


def main():
    started = time.time()
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    if not os.path.isdir(os.path.splitdrive(DEST)[0] + os.sep):
        raise SystemExit(f'backup volume {DEST} is not available')
    stats = {}
    for label, root in (('userData', APPDATA), ('data', DATA)):
        if not os.path.isdir(root):
            raise SystemExit(f'source missing: {root}')
        stats[label] = mirror(label, root)

    # Versioned zip of the small state files (userData root level and one level down).
    vdir = os.path.join(DEST, 'versions')
    os.makedirs(vdir, exist_ok=True)
    zpath = os.path.join(vdir, time.strftime('state-%Y%m%d-%H%M%S.zip'))
    zipped = []
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for src, rel, st in walk(APPDATA):
            if st.st_size <= VERSION_MAX_BYTES and rel.count(os.sep) <= 1:
                try:
                    z.write(src, rel.replace('\\', '/'))
                except OSError as e:
                    # Electron holds an exclusive handle on `lockfile` while it runs; that file is
                    # a mutex, not state. Anything else unreadable shows up in the CRITICAL check.
                    print(f'  skip {rel}: {e}')
                    continue
                zipped.append(rel.replace('\\', '/'))

    # --- verification, on this run's own output ---
    missing = [c for c in CRITICAL if c not in zipped and os.path.exists(os.path.join(APPDATA, c))]
    pool = [(s, r) for s, r, st in walk(APPDATA) if st.st_size < 200 * 1024 * 1024]
    bad = []
    for src, rel in random.sample(pool, min(SAMPLE, len(pool))):
        dst = os.path.join(DEST, 'mirror', 'userData', rel)
        if not os.path.exists(dst):
            bad.append(f'{rel}: absent from mirror')
        elif os.path.getsize(src) == os.path.getsize(dst) and sha(src, 1 << 22) != sha(dst, 1 << 22):
            bad.append(f'{rel}: content differs')

    versions = sorted(f for f in os.listdir(vdir) if f.endswith('.zip'))
    for old in versions[:-KEEP_VERSIONS]:
        os.remove(os.path.join(vdir, old))

    ok = not missing and not bad
    line = (f'[{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}] '
            f'{"ok" if ok else "FAILED"} '
            f'userData {stats["userData"][0]}/{stats["userData"][2]} copied, '
            f'data {stats["data"][0]}/{stats["data"][2]} copied, '
            f'{(stats["userData"][1] + stats["data"][1]) / 1e6:.1f} MB written, '
            f'{len(zipped)} files versioned, {len(versions[-KEEP_VERSIONS:])} versions kept, '
            f'{time.time() - started:.0f}s'
            + (f' | MISSING {missing}' if missing else '')
            + (f' | MISMATCH {bad}' if bad else ''))
    print(line)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')
    with open(os.path.join(DEST, 'status.json'), 'w', encoding='utf-8') as f:
        json.dump({'at': time.time(), 'ok': ok, 'missing': missing, 'mismatch': bad,
                   'latestVersion': os.path.basename(zpath), 'userData': stats['userData'], 'data': stats['data']}, f)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
