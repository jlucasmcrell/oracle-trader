"""Reset the Polymarket US paper lab (poly-paper.json) to a fresh start at a chosen cash per account.

Run with the APP STOPPED (it owns the file). Archives the old ledger next to it, keeps the market/quote caches so
the arms keep their signal history, clears every order, position and trade, and stamps `started` and
`startingCash` so the panel and the account card read against the new baseline.

  python scripts/poly-paper-reset.py --cash 44.37          # each of the eight accounts starts with $44.37
  python scripts/poly-paper-reset.py --cash 44.37 --dry    # show what would change
"""
import argparse, json, os, shutil, time

ap = argparse.ArgumentParser()
ap.add_argument('--cash', type=float, required=True, help='starting cash per simulated account, USD')
ap.add_argument('--dry', action='store_true')
a = ap.parse_args()
if not (a.cash > 0):
    raise SystemExit('cash must be positive')

p = os.path.join(os.environ['APPDATA'], 'oracle-trader', 'poly-paper.json')
s = json.load(open(p, encoding='utf-8'))
if s.get('version') != 1 or not isinstance(s.get('cash'), dict):
    raise SystemExit('not a version-1 poly-paper ledger; refusing')
old = {'cash': {k: round(v, 2) for k, v in s['cash'].items()}, 'orders': len(s['orders']), 'positions': len(s['positions']), 'trades': len(s['trades']),
       'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(s['started'] / 1000))}
print('before:', old)
stamp = time.strftime('%Y%m%d-%H%M%S')
if a.dry:
    print(f'dry run: would archive to {p}.pre-reset-{stamp} and start every account at ${a.cash:.2f}')
    raise SystemExit(0)
shutil.copy2(p, f'{p}.pre-reset-{stamp}')
now = int(time.time() * 1000)
s['cash'] = {k: round(a.cash, 2) for k in s['cash']}
s['startingCash'] = round(a.cash, 2)
s['orders'], s['positions'], s['trades'], s['cooldowns'] = [], [], [], {}
s['started'] = now
s['scans'] = 0
s.pop('lastError', None)
tmp = p + '.tmp'
json.dump(s, open(tmp, 'w', encoding='utf-8'))
os.replace(tmp, p)
print(f'reset: {len(s["cash"])} accounts at ${a.cash:.2f}, archived {p}.pre-reset-{stamp}')
