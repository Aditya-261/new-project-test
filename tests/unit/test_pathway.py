"""
Unit Tests — Dense Depth Pathway & Clear Corridor Analyzer
===========================================================
"""

import numpy as np
import pytest

from assistive_navigation.navigation.pathway import (
    PathwayAnalyzer,
    PathwayAssessment,
    SectorStatus,
    SteeringAdvice,
)


@pytest.fixture
def analyzer():
    return PathwayAnalyzer()


def test_pathway_none_depth_returns_unknown(analyzer):
    res = analyzer.analyze(None)
    assert res.steering_advice == SteeringAdvice.UNKNOWN
    assert res.left_status == SectorStatus.UNKNOWN
    assert res.center_status == SectorStatus.UNKNOWN
    assert res.right_status == SectorStatus.UNKNOWN
    assert res.unclassified_hazard is False


def test_pathway_clear_corridor(analyzer):
    # Depth map with low values everywhere (e.g. 0.20 = far away)
    depth = np.full((480, 640), 0.20, dtype=np.float32)
    res = analyzer.analyze(depth)
    assert res.center_status == SectorStatus.CLEAR
    assert res.left_status == SectorStatus.CLEAR
    assert res.right_status == SectorStatus.CLEAR
    assert res.steering_advice == SteeringAdvice.PROCEED_AHEAD
    assert "clear ahead" in res.guidance_text.lower()
    assert res.unclassified_hazard is False


def test_pathway_blocked_center_clear_right(analyzer):
    # Left is caution/blocked, center is blocked (0.75), right is clear (0.25)
    depth = np.full((480, 640), 0.20, dtype=np.float32)
    # Center sector: x in [0.35 * 640, 0.65 * 640] = [224, 416]
    depth[:, 224:416] = 0.75
    depth[:, :224] = 0.70  # left also blocked

    res = analyzer.analyze(depth)
    assert res.center_status == SectorStatus.BLOCKED
    assert res.left_status == SectorStatus.BLOCKED
    assert res.right_status == SectorStatus.CLEAR
    assert res.steering_advice == SteeringAdvice.STEER_RIGHT
    assert "steer right" in res.guidance_text.lower()


def test_pathway_blocked_center_clear_left(analyzer):
    depth = np.full((480, 640), 0.20, dtype=np.float32)
    depth[:, 224:416] = 0.75
    depth[:, 416:] = 0.70  # right also blocked

    res = analyzer.analyze(depth)
    assert res.center_status == SectorStatus.BLOCKED
    assert res.left_status == SectorStatus.CLEAR
    assert res.right_status == SectorStatus.BLOCKED
    assert res.steering_advice == SteeringAdvice.STEER_LEFT
    assert "steer left" in res.guidance_text.lower()


def test_pathway_completely_blocked_stops(analyzer):
    depth = np.full((480, 640), 0.85, dtype=np.float32)
    res = analyzer.analyze(depth)
    assert res.center_status == SectorStatus.BLOCKED
    assert res.left_status == SectorStatus.BLOCKED
    assert res.right_status == SectorStatus.BLOCKED
    assert res.steering_advice == SteeringAdvice.STOP_HAZARD
    assert "stop" in res.guidance_text.lower()


def test_pathway_unclassified_hazard_detection(analyzer):
    # An obstacle is directly ahead with high depth (0.80), but confirmed_objects is empty
    depth = np.full((480, 640), 0.20, dtype=np.float32)
    depth[:, 250:390] = 0.80

    res = analyzer.analyze(depth, confirmed_objects=[])
    assert res.unclassified_hazard is True
    assert res.hazard_direction == "ahead"
    assert res.hazard_proximity in ("close", "very close")
