from pathlib import Path
from ftfy import fix_text
import unicodedata
root=Path(r'G:\PROJECTS\oracle-trader\src\renderer\src')
files=['AutoTraderPanel.tsx','BacktestPanel.tsx','MiniAutoPanel.tsx','ResearchPanel.tsx','SettingsPanel.tsx']
repl={
'—':' - ','–':'-','…':'...','·':' - ','¢':'c','→':' -> ','↔':' <-> ','≥':'>=','≤':'<=','∈':' in ',
'×':'x','±':'+/-','σ':'sigma','Φ':'Phi','τ':'tau','Δ':'delta','√':'sqrt','∞':'infinity',
'“':'"','”':'"','’':"'",'‘':"'",'✓':'PASS','✗':'X','⚠':'WARNING','⛔':'STOP',
'▸':'>','▾':'v','−':'-','≈':'~','™':'','⏱':'','⚙':'','🔬':'','📊':'','🧪':'','📡':'','🎯':'','📈':'','🔍':'',
}
for name in files:
    p=root/name
    s=fix_text(p.read_text(encoding='utf-8-sig'))
    for a,b in repl.items(): s=s.replace(a,b)
    s=unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode('ascii')
    # Normalize spacing introduced by separators without changing JSX structure.
    s=s.replace('  -  ',' - ').replace(' -  ',' - ').replace('  - ',' - ')
    p.write_text(s,encoding='utf-8')
    print(name)
