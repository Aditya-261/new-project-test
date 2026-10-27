"""
Dense Depth Pathway & Clear Corridor Analyzer
==============================================
Analyzes the monocular depth map to evaluate navigable free space, detect
unclassified obstacles (doors, walls, stairs, drop-offs, pillars), and
provide proactive steering advice (e.g. "Path blocked ahead, steer right").

This bridges the COCO detection gap: while YOLO only recognises 80 object
classes, the dense depth map captures ALL physical geometry in the scene.
"""

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)


class SectorStatus(str, Enum):
    CLEAR = "CLEAR"
    CAUTION = "CAUTION"
    BLOCKED = "BLOCKED"
    UNKNOWN = "UNKNOWN"


class SteeringAdvice(str, Enum):
    PROCEED_AHEAD = "proceed_ahead"
    STEER_LEFT = "steer_left"
    STEER_RIGHT = "steer_right"
    STOP_HAZARD = "stop_hazard"
    UNKNOWN = "unknown"


@dataclass
class PathwayAssessment:
    """
    Summary of pathway clearance and steering guidance.
    """
    left_status: SectorStatus
    center_status: SectorStatus
    right_status: SectorStatus

    left_depth: float       # 85th percentile depth in left corridor (0.0 to 1.0)
    center_depth: float     # 85th percentile depth in center corridor
    right_depth: float      # 85th percentile depth in right corridor

    steering_advice: SteeringAdvice
    guidance_text: str      # Spoken advice string

    unclassified_hazard: bool
    hazard_direction: Optional[str] = None
    hazard_proximity: Optional[str] = None


class PathwayAnalyzer:
    """
    Evaluates walking corridors (Left, Center, Right) directly from the dense depth map.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        cfg = config or {}
        spat_cfg = cfg.get("spatial", {})
        prox_cfg = cfg.get("proximity", {})
        path_cfg = cfg.get("pathway", {})

        # Horizontal zone boundaries (fractions of frame width)
        self._left_zone_end = float(spat_cfg.get("left_zone_end", 0.35))
        self._right_zone_start = float(spat_cfg.get("right_zone_start", 0.65))

        # Vertical corridor evaluation window (ground to torso height)
        self._y_top_frac = float(path_cfg.get("corridor_top_frac", 0.35))
        self._y_bottom_frac = float(path_cfg.get("corridor_bottom_frac", 0.95))

        # Proximity thresholds for corridor clearance
        self._blocked_threshold = float(path_cfg.get("blocked_threshold", 0.62))
        self._caution_threshold = float(path_cfg.get("caution_threshold", 0.42))

        # Minimum depth difference to classify a non-COCO hazard
        self._hazard_depth_threshold = float(path_cfg.get("hazard_threshold", 0.68))

    def analyze(
        self,
        depth_map: Optional[np.ndarray],
        confirmed_objects: Optional[List[Any]] = None,
    ) -> PathwayAssessment:
        """
        Analyze the depth map and return a PathwayAssessment.

        Args:
            depth_map: 2D float32 numpy array normalized to [0.0, 1.0], or None.
            confirmed_objects: Optional list of confirmed objects from temporal filter.
        """
        if depth_map is None or not isinstance(depth_map, np.ndarray) or depth_map.size == 0:
            return PathwayAssessment(
                left_status=SectorStatus.UNKNOWN,
                center_status=SectorStatus.UNKNOWN,
                right_status=SectorStatus.UNKNOWN,
                left_depth=0.0,
                center_depth=0.0,
                right_depth=0.0,
                steering_advice=SteeringAdvice.UNKNOWN,
                guidance_text="",
                unclassified_hazard=False,
            )

        h, w = depth_map.shape[:2]
        y1 = int(np.clip(self._y_top_frac * h, 0, h - 1))
        y2 = int(np.clip(self._y_bottom_frac * h, y1 + 1, h))

        x_left_end = int(np.clip(self._left_zone_end * w, 1, w - 2))
        x_right_start = int(np.clip(self._right_zone_start * w, x_left_end + 1, w - 1))

        # Extract 3 corridor slices
        corridor_roi = depth_map[y1:y2, :]
        left_slice = corridor_roi[:, :x_left_end]
        center_slice = corridor_roi[:, x_left_end:x_right_start]
        right_slice = corridor_roi[:, x_right_start:]

        left_d = self._eval_depth_percentile(left_slice)
        center_d = self._eval_depth_percentile(center_slice)
        right_d = self._eval_depth_percentile(right_slice)

        left_status = self._classify_sector(left_d)
        center_status = self._classify_sector(center_d)
        right_status = self._classify_sector(right_d)

        # Steering decision logic
        advice, guidance = self._derive_steering(left_status, center_status, right_status, left_d, right_d)

        # Check for unclassified obstacle in path (e.g. wall, door, steps)
        unclassified_hazard = False
        hazard_dir = None
        hazard_prox = None

        if center_d >= self._hazard_depth_threshold:
            # Check if there is already a confirmed YOLO object in center
            has_matching_yolo = False
            if confirmed_objects:
                for obj in confirmed_objects:
                    # Check if center matches and object is close
                    d_label = getattr(obj, "direction_label", "")
                    if "ahead" in d_label.lower() or getattr(obj, "direction", None) == "CENTER":
                        has_matching_yolo = True
                        break

            if not has_matching_yolo:
                unclassified_hazard = True
                hazard_dir = "ahead"
                hazard_prox = "close" if center_d < 0.80 else "very close"
                if advice == SteeringAdvice.STOP_HAZARD:
                    guidance = "Obstacle directly ahead. Stop."
                elif advice == SteeringAdvice.STEER_RIGHT:
                    guidance = "Obstacle ahead. Clear path on your right, steer right."
                elif advice == SteeringAdvice.STEER_LEFT:
                    guidance = "Obstacle ahead. Clear path on your left, steer left."

        return PathwayAssessment(
            left_status=left_status,
            center_status=center_status,
            right_status=right_status,
            left_depth=round(float(left_d), 3),
            center_depth=round(float(center_d), 3),
            right_depth=round(float(right_d), 3),
            steering_advice=advice,
            guidance_text=guidance,
            unclassified_hazard=unclassified_hazard,
            hazard_direction=hazard_dir,
            hazard_proximity=hazard_prox,
        )

    def _eval_depth_percentile(self, slice_arr: np.ndarray) -> float:
        """Computes the 85th percentile depth in a corridor slice (robust to noise)."""
        if slice_arr.size == 0:
            return 0.0
        valid = slice_arr[np.isfinite(slice_arr) & (slice_arr > 0)]
        if valid.size == 0:
            return 0.0
        return float(np.percentile(valid, 85))

    def _classify_sector(self, depth_val: float) -> SectorStatus:
        if depth_val >= self._blocked_threshold:
            return SectorStatus.BLOCKED
        if depth_val >= self._caution_threshold:
            return SectorStatus.CAUTION
        return SectorStatus.CLEAR

    def _derive_steering(
        self,
        left: SectorStatus,
        center: SectorStatus,
        right: SectorStatus,
        left_d: float,
        right_d: float,
    ) -> Tuple[SteeringAdvice, str]:
        """Derives proactive steering advice based on sector states."""
        if center == SectorStatus.CLEAR:
            return SteeringAdvice.PROCEED_AHEAD, "Path clear ahead."

        if center == SectorStatus.CAUTION:
            # Approaching obstacle ahead
            if right == SectorStatus.CLEAR and left != SectorStatus.CLEAR:
                return SteeringAdvice.STEER_RIGHT, "Obstacle approaching ahead. Veer right."
            if left == SectorStatus.CLEAR and right != SectorStatus.CLEAR:
                return SteeringAdvice.STEER_LEFT, "Obstacle approaching ahead. Veer left."
            return SteeringAdvice.PROCEED_AHEAD, "Caution, obstacle ahead."

        # Center is BLOCKED
        if right == SectorStatus.CLEAR and left != SectorStatus.CLEAR:
            return SteeringAdvice.STEER_RIGHT, "Path blocked ahead. Steer right."

        if left == SectorStatus.CLEAR and right != SectorStatus.CLEAR:
            return SteeringAdvice.STEER_LEFT, "Path blocked ahead. Steer left."

        if left == SectorStatus.CLEAR and right == SectorStatus.CLEAR:
            # Both sides clear, pick the one with lower depth
            if left_d <= right_d:
                return SteeringAdvice.STEER_LEFT, "Path blocked ahead. Clear corridor on your left."
            return SteeringAdvice.STEER_RIGHT, "Path blocked ahead. Clear corridor on your right."

        # Both sides are also blocked/caution
        return SteeringAdvice.STOP_HAZARD, "Path blocked ahead. Stop."
