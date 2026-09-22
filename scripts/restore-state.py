"""Restore the Kalshi trader's state from a state-backup zip, after a power loss or anything else that destroys it.

    python scripts/restore-state.py --zip D:/oracle-trader-backup/preserved/<name>.zip            # dry run
    python scripts/restore-state.py --zip D:/oracle-trader-backup/preserved/<name>.zip --apply    # app stopped

Restores BOTH `kalshi-auto.json` and `ladder.json` from the same instant. Restoring the config alone is not enough:
when the app boots on a destroyed config it reads every live arm's switch as off, and the ladder records that as
the operator switching each one off in the panel - it sets `operatorHold` and re-baselines the arm against an
empty ledger (2026-09-21: seven arms). Restoring the config afterwards clears the holds but zeroes every arm's
stage evidence; restoring the ladder file from the same zip undoes both.

Safety:
  * dry run unless --apply; --apply refuses while any electron process is running (the app rewrites both files
    within a minute, and would overwrite the restore);
  * the live arm is restored OFF unless --keep-arm, so the first boot books whatever settled while the app was
    down before anything new is placed. Arming afterwards is the operator's;
  * key and webhook VALUES are never printed - a changed secret shows as its length only;
  * the file being replaced is copied aside first, and each write is temp + fsync + rename.

Written from the 2026-09-22 restore (REVIEW-CHANGES section 155).
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, time, zipfile

SECRET = ('llmApiKey', 'oddsApiKey', 'metaculusApiKey', 'alertWebhookUrl')
UD = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader')


def member(z, base):
    # The zip also carries old parked profiles (DEMO-*, PRODUCTION-PARKED-*); the live file is the shortest path.
    c = [n for n in z.namelist() if n.replace(chr(92), '/').split('/')[-1] == base and 'DEMO' not in n and 'PARKED' not in n]
    if not c:
        sys.exit('REFUSING: %s is not in the zip' % base)
    return sorted(c, key=len)[0]


def electron_running():
    out = subprocess.run(['powershell', '-NoProfile', '-Command',
                          'Get-Process electron -ErrorAction SilentlyContinue | Measure-Object | % Count'],
                         capture_output=True, text=True).stdout.strip()
    return out not in ('', '0')


def write_atomic(path, obj):
    shutil.copy2(path, path + '.pre-restore-' + time.strftime('%Y%m%d-%H%M%S'))
    tmp = path + '.restore-tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    json.load(open(path, encoding='utf-8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', required=True)
    ap.add_argument('--sha', help='expected sha256 prefix of the zip, if one was recorded when it was preserved')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--keep-arm', action='store_true')
    a = ap.parse_args()

    if a.sha:
        h = hashlib.sha256()
        with open(a.zip, 'rb') as f:
            for b in iter(lambda: f.read(1 << 20), b''):
                h.update(b)
        if not h.hexdigest().startswith(a.sha):
            sys.exit('REFUSING: zip sha256 %s does not start with %s' % (h.hexdigest()[:16], a.sha))

    z = zipfile.ZipFile(a.zip)
    cfg_new = json.loads(z.read(member(z, 'kalshi-auto.json')))
    lad_new = json.loads(z.read(member(z, 'ladder.json')))
    if len(cfg_new.get('config', {})) < 100 or 'state' not in cfg_new or 'strategies' not in lad_new:
        sys.exit('REFUSING: the zip does not hold a live-shaped kalshi-auto.json and ladder.json')
    if not a.keep_arm:
        cfg_new['config']['liveArmed'] = False

    cfg_path, lad_path = os.path.join(UD, 'kalshi-auto.json'), os.path.join(UD, 'ladder.json')
    cfg_cur = json.load(open(cfg_path, encoding='utf-8'))
    lad_cur = json.load(open(lad_path, encoding='utf-8'))

    gc, cc = cfg_new['config'], cfg_cur.get('config', {})
    changed = sorted(k for k in set(gc) | set(cc) if gc.get(k) != cc.get(k))
    print('kalshi-auto.json: %d config / %d state keys now -> %d / %d restored; %d open trades, %d strategies in the ledger'
          % (len(cc), len(cfg_cur.get('state', {})), len(gc), len(cfg_new['state']),
             len(cfg_new['state'].get('openTrades', [])), len(cfg_new['state'].get('perfByStrategy', {}))))
    for k in changed:
        if k in SECRET:
            print('   %-30s restored (%d chars; value not shown)' % (k, len(gc.get(k) or '')))
        else:
            print('   %-30s %s -> %s' % (k, str(cc.get(k))[:30], str(gc.get(k))[:40]))
    print('   live arm on first boot: %s' % gc.get('liveArmed'))
    print('ladder.json:')
    for k in sorted(set(lad_new['strategies']) | set(lad_cur['strategies'])):
        g, c = lad_new['strategies'].get(k, {}), lad_cur['strategies'].get(k, {})
        if g.get('stage') != c.get('stage') or bool(g.get('operatorHold')) != bool(c.get('operatorHold')):
            print('   %-24s stage %-9s -> %-9s hold %-5s -> %s' % (k, c.get('stage'), g.get('stage'), bool(c.get('operatorHold')), bool(g.get('operatorHold'))))

    if not a.apply:
        print('\nDRY RUN - nothing written. Stop the app, then re-run with --apply.')
        return
    if electron_running():
        sys.exit('REFUSING: electron is running; it would overwrite the restore within a minute')
    write_atomic(cfg_path, cfg_new)
    write_atomic(lad_path, lad_new)
    print('\nWRITTEN both files. Start the app (Start-ScheduledTask OracleTrader-App), confirm openTrades matches the '
          "venue's position count and the settlements are booked, then arm.")


if __name__ == '__main__':
    main()
