import copy
import json
from pathlib import Path

import pytest

DATA = Path(__file__).resolve().parent.parent / "data"


def _load(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


@pytest.fixture
def workflow() -> dict:
    return _load("workflow_fixture.json")


@pytest.fixture
def catalog() -> dict:
    return _load("skill_catalog.json")


@pytest.fixture
def objects() -> dict:
    return {o["object_id"]: o for o in _load("demo_cases.json")["objects"]}


def node(workflow: dict, node_id: str) -> dict:
    """ワークフロー内のノードを直接書き換えるための参照を返す。"""
    return next(n for n in workflow["nodes"] if n["id"] == node_id)


@pytest.fixture
def clone():
    return copy.deepcopy
