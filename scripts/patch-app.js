const fs = require('fs');
let code = fs.readFileSync('G:/PROJECTS/oracle-trader/src/renderer/src/App.tsx', 'utf8');

code = code.replace(
  "import SettingsPanel from './SettingsPanel'",
  "import SettingsPanel from './SettingsPanel'\nimport QuantPanel from './QuantPanel'"
);

code = code.replace(
  "const [showResearch, setShowResearch] = useState(false)",
  "const [showResearch, setShowResearch] = useState(false)\n  const [showQuant, setShowQuant] = useState(false)"
);

code = code.replace(
  '<button className="ghost" onClick={() => setShowResearch(true)} title="Research">',
  '<button className="ghost" onClick={() => setShowQuant(true)} style={{ color: "#60a5fa", borderColor: "#2563eb" }} title="Quant Hub">\n           Quant Hub\n        </button>\n        <button className="ghost" onClick={() => setShowResearch(true)} title="Research">'
);

code = code.replace(
  '{showResearch && (',
  '{showQuant && <QuantPanel onClose={() => setShowQuant(false)} />}\n\n      {showResearch && ('
);

fs.writeFileSync('G:/PROJECTS/oracle-trader/src/renderer/src/App.tsx', code, 'utf8');
console.log('App.tsx updated successfully');
