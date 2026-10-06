import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bot.config import Settings  # noqa: E402


@pytest.fixture
def s(tmp_path) -> Settings:
    st = Settings()
    st.DB_PATH = str(tmp_path / "test.db")
    st.REPORTS_DIR = str(tmp_path / "reports")
    st.STOP_FILE = str(tmp_path / "STOP")
    return st
