import os
import shutil
import tempfile
from pathlib import Path

import pytest

_PRODUCTION_UPLOADS = Path(__file__).resolve().parent / "private_uploads"


def _upload_snapshot():
    if not _PRODUCTION_UPLOADS.exists():
        return {}
    return {str(path.relative_to(_PRODUCTION_UPLOADS)): (path.stat().st_size, path.stat().st_mtime_ns)
            for path in _PRODUCTION_UPLOADS.rglob("*") if path.is_file()}


_PRODUCTION_UPLOADS_BEFORE = _upload_snapshot()


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    root_value = os.environ.get("CARESYNC_TEST_ROOT")
    if not root_value:
        return
    test_root = Path(root_value).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if test_root.parent != temp_root or not test_root.name.startswith("caresync-tests-"):
        return
    if test_root.exists():
        shutil.rmtree(test_root)
    if _upload_snapshot() != _PRODUCTION_UPLOADS_BEFORE:
        raise AssertionError("Automated tests modified files under private_uploads/")
