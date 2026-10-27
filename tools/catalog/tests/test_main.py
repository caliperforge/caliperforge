import pytest

from catalog_desk import main


def test_no_command_exits_2():
    with pytest.raises(SystemExit) as exited:
        main([])
    assert exited.value.code == 2
