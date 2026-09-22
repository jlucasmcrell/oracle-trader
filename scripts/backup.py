"""Complete backup of the Oracle Trader repo (minus rebuildable dirs) and its Electron userData (minus browser caches)."""
import shutil, zipfile, os, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
from win_share import open_shared  # reading a live log must not block the app's appends

label_arg = sys.argv[1] if len(sys.argv) > 1 else "backup"
ts = time.strftime("%Y%m%d-%H%M%S")
out_dir = r"G:\PROJECTS\oracle-trader-backups"
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, f"oracle-trader-{label_arg}-{ts}.zip")

ROOTS = [
    ("repo", r"G:\PROJECTS\oracle-trader", {"node_modules", "out"}),
    ("userData", os.path.join(os.environ["APPDATA"], "oracle-trader"),
     {"Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "blob_storage",
      "Shared Dictionary", "Session Storage", "Local Storage", "Network", "Crashpad"}),
]

n = 0
raw = 0
skipped = []
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for label, root, excl in ROOTS:
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in excl]
            for f in fns:
                p = os.path.join(dp, f)
                rel = os.path.relpath(p, root).replace("\\", "/")
                try:
                    # ZipFile.write() opens the source without sharing it, which fails every
                    # concurrent append the running app makes to that file (incident 2026-09-21T13-35).
                    info = zipfile.ZipInfo.from_file(p, f"{label}/{rel}")
                    info.compress_type, info._compresslevel = zipfile.ZIP_DEFLATED, 6
                    with open_shared(p) as f_in, z.open(info, "w") as out_f:
                        shutil.copyfileobj(f_in, out_f, 1 << 20)
                    n += 1
                    raw += os.path.getsize(p)
                except Exception as e:  # locked files etc.
                    skipped.append((p, str(e)))

with zipfile.ZipFile(out) as z:
    bad = z.testzip()

print(f"wrote {out}")
print(f"files {n} raw_MB {raw/1e6:.1f} zip_MB {os.path.getsize(out)/1e6:.1f} testzip {bad}")
for p, e in skipped:
    print("skipped", p, e)
