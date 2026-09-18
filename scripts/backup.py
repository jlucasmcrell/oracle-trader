"""Complete backup of the Oracle Trader repo (minus rebuildable dirs) and its Electron userData (minus browser caches)."""
import zipfile, os, sys, time

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
                    z.write(p, f"{label}/{rel}")
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
