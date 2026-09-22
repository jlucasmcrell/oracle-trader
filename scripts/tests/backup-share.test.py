"""A backup that reads a live log must not stop the app from appending to it.

Incident 2026-09-21T13-35: the hourly state backup was copying
cf-reference-shadow/2026-09-21.jsonl and five reference observations were rejected
with EBUSY while it did. shutil.copy2 on Windows delegates to the Win32 CopyFile2
API, which opens the source with FILE_SHARE_READ only, so every write to that file
from another process fails for the length of the copy. The same collision on
order-journal.jsonl latches the journal's permanent `submissions blocked` failure,
so this is not only about shadow data.
"""
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time

SCRIPTS = Path(__file__).resolve().parents[1]
SIZE = 24 << 20  # big enough that a copy takes long enough to collide with an appender


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


win_share = load('win_share', SCRIPTS / 'lib' / 'win_share.py')
state_backup = load('state_backup', SCRIPTS / 'state-backup.py')


def appended(path):
    """True when one append succeeds right now."""
    try:
        with open(path, 'ab') as f:
            f.write(b'{"probe":1}\n')
        return True
    except OSError:
        return False


def appends_during(log, copy, seconds):
    """Hammer `log` with appends while `copy()` runs in a loop. Returns (ok, failed)."""
    tally = [0, 0]
    stop = threading.Event()

    def writer():
        while not stop.is_set():
            tally[0 if appended(log) else 1] += 1

    t = threading.Thread(target=writer)
    t.start()
    try:
        end = time.time() + seconds
        while time.time() < end and not tally[1]:
            copy()
    finally:
        stop.set()
        t.join()
    assert tally[0] > 0, 'the writer never ran; the test proves nothing'
    return tally


passed = 0
with tempfile.TemporaryDirectory(prefix='oracle-share-') as tmp:
    tmp = Path(tmp)
    src_dir = tmp / 'src'
    src_dir.mkdir()
    log = src_dir / '2026-09-21.jsonl'
    log.write_bytes(b'{"seed":1}\n' * (SIZE // 11))
    plain = tmp / 'plain.jsonl'

    # 1. The cause: shutil.copy2 denies writers for the length of the copy.
    ok, failed = appends_during(log, lambda: shutil.copy2(log, plain), 5)
    assert failed > 0, f'shutil.copy2 no longer locks the source ({ok} appends, 0 failed); re-check the fix'
    passed += 1

    # 2. The fix: a shared read handle sees the same bytes and blocks nobody.
    with win_share.open_shared(log) as held:
        assert held.read(11) == b'{"seed":1}\n'
        assert appended(log), 'open_shared blocked an append'
    passed += 1

    # 3. copy_shared is a drop-in for shutil.copy2: same bytes, same mtime.
    copy = tmp / 'copy.jsonl'
    win_share.copy_shared(log, copy)
    assert copy.read_bytes() == log.read_bytes(), 'copy_shared lost bytes'
    assert abs(copy.stat().st_mtime - log.stat().st_mtime) < 1, 'copy_shared dropped the mtime'
    passed += 1

    # 4. End to end: the backup's mirror runs against a log that is being appended
    #    to, and every append during it succeeds.
    state_backup.DEST = str(tmp / 'dest')
    mirrored = [0]

    def mirror_once():
        copied, _, total = state_backup.mirror('probe', str(src_dir))
        assert total == 1, f'mirror walked {total} files'
        mirrored[0] += copied

    ok, failed = appends_during(log, mirror_once, 5)
    assert mirrored[0] > 0, 'the mirror copied nothing'
    assert failed == 0, f'{failed} of {ok + failed} appends failed during the mirror'
    copy = (tmp / 'dest' / 'mirror' / 'probe' / log.name).read_bytes()
    assert log.read_bytes().startswith(copy), 'the mirrored copy is not a prefix of the live log'
    passed += 1

print(f'backup-share: {passed} scenarios passed')
