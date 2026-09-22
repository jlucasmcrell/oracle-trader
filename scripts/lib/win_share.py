"""Read a file on Windows without locking out the process that is appending to it.

Python's builtin open() asks the filesystem for FILE_SHARE_READ only, so while a
backup reads a live append-only log every write to that log from another process
fails with a sharing violation (Node reports it as EBUSY). Incident 2026-09-21T13-35:
the hourly state backup was mirroring cf-reference-shadow/2026-09-21.jsonl and five
reference observations were dropped in the 12 ms it took; the same collision on
order-journal.jsonl would have latched `Order journal write failed; submissions
blocked` and stopped the app submitting orders until a restart.

CreateFileW with all three share flags reads the same bytes and blocks nobody. A
concurrent append can still land between our reads, so a copy made this way is a
prefix-consistent snapshot of an append-only file - which is exactly what a mirror
of a jsonl log should be.
"""
import os
import shutil

if os.name == 'nt':
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _GENERIC_READ = 0x80000000
    _SHARE_READ_WRITE_DELETE = 0x1 | 0x2 | 0x4
    _OPEN_EXISTING = 3
    _FILE_ATTRIBUTE_NORMAL = 0x80
    _INVALID_HANDLE = wintypes.HANDLE(-1).value

    _CreateFileW = ctypes.windll.kernel32.CreateFileW
    _CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                             wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _CreateFileW.restype = wintypes.HANDLE

    def open_shared(path):
        """Binary read handle that permits concurrent writers, renames and deletes."""
        handle = _CreateFileW(os.fspath(path), _GENERIC_READ, _SHARE_READ_WRITE_DELETE, None,
                              _OPEN_EXISTING, _FILE_ATTRIBUTE_NORMAL, None)
        if handle is None or handle == _INVALID_HANDLE:
            raise ctypes.WinError()
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except OSError:
            ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(handle))
            raise
        return os.fdopen(fd, 'rb')  # closing the file object closes the handle
else:
    def open_shared(path):
        return open(path, 'rb')


def copy_shared(src, dst):
    """shutil.copy2 that does not block writers on `src` (metadata copied as copy2 does)."""
    with open_shared(src) as f, open(dst, 'wb') as out:
        shutil.copyfileobj(f, out, 1 << 20)
    shutil.copystat(src, dst)
    return dst
