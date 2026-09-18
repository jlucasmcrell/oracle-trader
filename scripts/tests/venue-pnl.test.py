"""Account reporting must not choose the venue from an arbitrary dump filename."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location('venue_pnl', Path(__file__).resolve().parents[1] / 'venue-pnl.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='oracle-pnl-') as tmp:
    p = Path(tmp) / 'p-2026-09-15.json'
    p.write_text(json.dumps({'balances': {}, 'activities_all': {'activities': []}}), encoding='utf-8')
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        module.main([str(p)])
    assert out.getvalue().startswith('Polymarket US'), out.getvalue()
    p.write_text(json.dumps({'error': 'export failed'}), encoding='utf-8')
    try:
        module.main([str(p)])
        raise AssertionError('Failed export reported as zero P&L')
    except ValueError:
        pass
print('venue-pnl: 2 scenarios passed')
