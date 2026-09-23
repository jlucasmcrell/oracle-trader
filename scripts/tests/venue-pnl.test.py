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

    # --by-arm (backlog 102b). KXA: arm fade bought 2 YES at 40c, lead-lag bought 1 NO at 30c (a YES-book sale with
    # outcome_side 'no'), YES won: the settlement's +0.87 splits +1.18 / -0.31. KXB's only fill has no journal row and
    # KXC has no fills in the dump; both land in unattributed, so the arms still sum to the venue total (+1.25).
    k = Path(tmp) / 'k.json'
    k.write_text(json.dumps({'balance': {}, 'settlements': [
        {'ticker': 'KXA-1', 'market_result': 'yes', 'settled_time': '2026-09-22T12:00:00Z', 'revenue': 100, 'yes_count_fp': '2.00',
         'no_count_fp': '1.00', 'yes_total_cost_dollars': '0.80', 'no_total_cost_dollars': '0.30', 'fee_cost': '0.03'},
        {'ticker': 'KXB-1', 'market_result': 'no', 'settled_time': '2026-09-22T13:00:00Z', 'revenue': 0, 'yes_count_fp': '1.00',
         'no_count_fp': '0', 'yes_total_cost_dollars': '0.20', 'no_total_cost_dollars': '0', 'fee_cost': '0.01'},
        {'ticker': 'KXC-1', 'market_result': 'no', 'settled_time': '2026-09-22T14:00:00Z', 'revenue': 100, 'yes_count_fp': '0',
         'no_count_fp': '1.00', 'yes_total_cost_dollars': '0', 'no_total_cost_dollars': '0.40', 'fee_cost': '0.01'},
        {'ticker': 'KXOLD-1', 'market_result': 'yes', 'settled_time': '2026-09-01T00:00:00Z', 'revenue': 100, 'yes_count_fp': '1.00'}],
        'fills': [
        {'ticker': 'KXA-1', 'order_id': 'o1', 'action': 'buy', 'side': 'yes', 'outcome_side': 'yes', 'count_fp': '2.00',
         'yes_price_dollars': '0.4000', 'no_price_dollars': '0.6000', 'fee_cost': '0.02'},
        {'ticker': 'KXA-1', 'order_id': 'o2', 'action': 'sell', 'side': 'no', 'outcome_side': 'no', 'count_fp': '1.00',
         'yes_price_dollars': '0.7000', 'no_price_dollars': '0.3000', 'fee_cost': '0.01'},
        {'ticker': 'KXB-1', 'order_id': 'o3', 'action': 'buy', 'side': 'yes', 'outcome_side': 'yes', 'count_fp': '1.00',
         'yes_price_dollars': '0.2000', 'no_price_dollars': '0.8000', 'fee_cost': '0.01'}]}), encoding='utf-8')
    # Polymarket US: our execution is the passive one (isAggressor false); the aggressor's order is the counterparty's.
    pu = Path(tmp) / 'pu.json'
    pu.write_text(json.dumps({'balances': {}, 'activities_all': {'activities': [
        {'trade': {'marketSlug': 'aec-x-2026-09-22', 'isAggressor': False,
                   'aggressorExecution': {'order': {'id': 'CTHEIRSXXXXX'}}, 'passiveExecution': {'order': {'id': 'CNH06JH0CWP7'}}}},
        {'positionResolution': {'marketSlug': 'aec-x-2026-09-22', 'updateTime': '2026-09-22T20:00:00Z',
                                'beforePosition': {'realized': {'value': '0.10'}}, 'afterPosition': {'realized': {'value': '0.60'}}}},
        {'positionResolution': {'marketSlug': 'aec-y-2026-09-22', 'updateTime': '2026-09-22T21:00:00Z',
                                'beforePosition': {'realized': {'value': '0'}}, 'afterPosition': {'realized': {'value': '-0.25'}}}}]}}), encoding='utf-8')
    j = Path(tmp) / 'order-journal.jsonl'
    j.write_text('\n'.join(json.dumps(r) for r in [
        {'venue': 'kalshi', 'marketId': 'KXA-1', 'ref': 'auto:fade:maker:fade:KXA-1', 'clientOrderId': 'c1', 'state': 'pending'},
        {'venue': 'kalshi', 'marketId': 'KXA-1', 'ref': 'auto:fade:maker:fade:KXA-1', 'clientOrderId': 'c1', 'state': 'acknowledged', 'orderId': 'o1'},
        {'venue': 'kalshi', 'marketId': 'KXA-1', 'ref': 'leadlag', 'clientOrderId': 'c2', 'state': 'acknowledged', 'orderId': 'o2'},
        {'venue': 'polymarket-us', 'marketId': 'aec-x-2026-09-22', 'ref': 'mini:lag:aec-x-2026-09-22', 'clientOrderId': 'c4',
         'state': 'acknowledged', 'orderId': 'CNH06JH0CWP7'}]) + '\n{"venue":"kal', encoding='utf-8')
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        module.main([str(k), str(pu), '--since', '2026-09-21T00:00:00', '--by-arm', '--journal', str(j)])
    text = out.getvalue()
    assert 'Kalshi since 2026-09-21T00:00:00: 3 settlements, net $1.25' in text, text
    for want in ('auto:fade                n=1   $1.18', 'leadlag                  n=1   $-0.31', 'unattributed             n=2   $0.38',
                 'mini:lag                 n=1   $0.50', 'unattributed             n=1   $-0.25'):
        assert '    ' + want in text, (want, text)
    try:
        module.main([str(k), '--by-arm', '--journal', str(Path(tmp) / 'missing.jsonl')])
        raise AssertionError('A missing journal read as all-unattributed')
    except FileNotFoundError:
        pass
print('venue-pnl: 4 scenarios passed')
