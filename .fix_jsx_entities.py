from pathlib import Path
root=Path(r'G:\PROJECTS\oracle-trader\src\renderer\src')
patches={
'AutoTraderPanel.tsx':{
'          <= % bal':'          &lt;= % bal',
'          day loss <= %':'          day loss &lt;= %',
'          per-asset <=':'          per-asset &lt;=',
'          &gt;24h <=':'          &gt;24h &lt;=',
'                p <=':'                p &lt;=',
'                p >=':'                p &gt;=',
'                edge >= c':'                edge &gt;= c',
'                >= close-':'                &gt;= close-',
'              alerts  -> ':'              alerts to ',
},
'MiniAutoPanel.tsx':{
'              p <=':'              p &lt;=',
'              p >=':'              p &gt;=',
'                  liq >= M$':'                  liq &gt;= M$',
'                  bettors >=':'                  bettors &gt;=',
'                  spread <= c':'                  spread &lt;= c',
'                  side $ >=':'                  side $ &gt;=',
'              bal <= %':'              bal &lt;= %',
'<option value={6}><= 6h</option>':'<option value={6}>&lt;= 6h</option>',
'<option value={12}><= 12h</option>':'<option value={12}>&lt;= 12h</option>',
'<option value={24}><= 24h</option>':'<option value={24}>&lt;= 24h</option>',
'<option value={48}><= 2 days</option>':'<option value={48}>&lt;= 2 days</option>',
'<option value={72}><= 3 days</option>':'<option value={72}>&lt;= 3 days</option>',
'              >=':'              &gt;=',
}}
for name,repls in patches.items():
 p=root/name; s=p.read_text(encoding='utf-8')
 for a,b in repls.items(): s=s.replace(a,b)
 p.write_text(s,encoding='utf-8')
