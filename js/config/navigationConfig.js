/**
 * Navigation, spatial reasoning and decision constants.
 *
 * Pure data. Importable in Node.
 *
 * A note on the numbers: most of them are image-space heuristics calibrated for
 * a chest/hand-held rear camera at roughly 60-70 degrees horizontal field of
 * view. The `distance` section is the exception: it converts image cues into
 * rough metres, and every consumer must present those values as an estimate
 * with an uncertainty range rather than a measurement.
 */

export const NavigationConfig = {
    /* ------------------------------------------------------------- corridor */

    corridor: {
        /**
         * Starting walking-corridor half-width, as a fraction of frame width
         * either side of centre. The corridor adapts at runtime
         * (navigation/corridorModel.js); this is the conservative seed.
         */
        baseHalfWidth: 0.20,
        minHalfWidth: 0.15,
        /**
         * 0.24 gives a 48%-of-frame corridor at its widest. Wider than this and
         * objects well off to the side start counting as "in the path", which
         * makes the system warn about things the user will walk past.
         */
        maxHalfWidth: 0.24,
        /**
         * Vertical extent treated as "the ground in front of me". Above
         * `farBoundary` the image is distance/sky and only very large objects
         * matter; below `nearBoundary` is within a stride.
         */
        farBoundary: 0.42,
        nearBoundary: 0.78,
        /** Corridor overlap fraction below which an object is not in the path. */
        minOverlapRatio: 0.12,
        /**
         * How fast the corridor is allowed to move per update. Slow, because a
         * corridor that jumps around produces exactly the direction churn we are
         * eliminating.
         */
        adaptRate: 0.12,
        /**
         * Hard clamp on how far the corridor centre may ever sit from the middle
         * of the frame. Currently the centre does not move at all - see the note
         * in corridorModel.js about why chasing free space caused oscillation -
         * but the clamp stays so that a future orientation-driven centre cannot
         * point the user sideways.
         */
        maxCentreOffset: 0.06
    },

    /* ----------------------------------------------------------- free space */

    freeSpace: {
        /** Horizontal quantisation of the occupancy grid. */
        columns: 24,
        /**
         * Contiguous free width, as a fraction of the frame, that a person needs
         * to walk through. Roughly a shoulder width at conversational distance.
         */
        minPassableWidth: 0.17,
        /** Column free-depth above which the column counts as walkable. */
        passableDepthThreshold: 0.42,
        /**
         * Weighting between average free depth and worst-case free depth when
         * scoring a sector. Worst case is weighted heavily on purpose: an
         * average-clear sector with one blocked column is not clear.
         */
        meanWeight: 0.45,
        minWeight: 0.55,
        /** Ground band within which an obstacle blocks the floor. */
        groundBandTop: 0.42,
        /**
         * How a detected wall/barrier converts its estimated distance into
         * remaining free depth. A wall is a hard obstruction, not an object
         * whose box merely overlaps the floor, so these bands are much more
         * pessimistic than the generic bottomY mapping.
         */
        structuralDepthBands: [
            { meters: 2.5, depth: 0.05 },
            { meters: 5.0, depth: 0.20 },
            { meters: 8.0, depth: 0.55 },
            { meters: 12.0, depth: 0.80 }
        ],
        /** Used only when a structural track has no distance estimate yet. */
        structuralFallbackDepthCap: 0.45,
        /** Extra horizontal footprint for a wall, which is wider than its box. */
        structuralMargin: 0.035
    },

    /* --------------------------------------------------------- structural */
    /**
     * Classical wall/barrier detection from the 64x48 luminance thumbnail.
     *
     * COCO has no wall class, so this is deliberately a geometry detector, not
     * an appearance classifier: it looks for a broad, coherent wall/floor
     * boundary with vertical structure above it. It is conservative by design -
     * a missed wall still leaves the tracker/free-space stages in charge, while
     * a false wall would stop the user for no reason.
     */
    structural: {
        enabled: true,
        /** Frames a candidate must persist before it is emitted. */
        confirmFrames: 2,
        /** Ignore horizons/sky above this row. */
        boundaryMinY: 0.30,
        /** Ignore the bottom sliver of the frame. */
        boundaryMaxY: 0.97,
        /** Luma step (0-255) that counts as a boundary edge. */
        edgeThreshold: 14,
        /** Rows within this normalised distance are one boundary, not many. */
        rowTolerance: 0.06,
        /** Minimum contiguous run width, as a fraction of frame width. */
        minRunWidth: 0.28,
        /** Minimum wall height above the boundary, as a fraction of frame. */
        minWallHeight: 0.16,
        /** Above-region luminance std-dev that counts as wall texture. */
        minAboveTexture: 5.5,
        /** Above/below mean luma difference that counts as a boundary. */
        minAboveContrast: 7,
        /** Fraction of above-region column pairs with a vertical edge. */
        minVerticalEdgeDensity: 0.02,
        /**
         * A featureless surface above a boundary is indistinguishable from sky
         * in a single frame. Only trust it once its boundary is this low in the
         * frame, i.e. close enough that waiting for more evidence is unsafe.
         */
        uniformWallMinY: 0.55,
        /**
         * Whole-row brightness alternation (stairs, tiles, slats) is rejected
         * when the spread of row means is at least this large and this fraction
         * of the overall above-region spread. A real textured wall varies
         * within rows, so its row-mean spread stays small.
         */
        minBandRowStd: 4.0,
        maxBandRowRatio: 0.55,
        /**
         * Similar parallel edges above which a pattern (stairs/tiles) is
         * assumed. One is allowed for a skirting board or picture rail; two
         * or more is the signature of a staircase or tiled wall, which must
         * not be reported as a wall in the walking path.
         */
        maxSimilarRows: 1,
        /** Coverage at or above which the label is "wall" rather than "barrier". */
        wallWidthFraction: 0.5,
        confidenceFloor: 0.45,
        confidenceCeil: 0.92,
        /** Very strong first-frame evidence may skip the confirmation frame. */
        strongConfidence: 0.86,
        /** Temporal blending of the box between frames. */
        smoothAlpha: 0.55,
        /** Association gates for temporal persistence. */
        matchIou: 0.12,
        matchBoundaryY: 0.09,
        /** Below this row a contrast-only boundary needs extra evidence. */
        contrastOnlyMaxY: 0.80,
        /**
         * A boundary this close to the bottom is a close wall, not a floor
         * seam. Keep this aligned with `risk.structuralCriticalBottomY` (0.86)
         * so a wall at arm's length cannot be rejected by the close-evidence
         * gate just before it becomes a stop.
         */
        closeFloorMaxFraction: 0.15,
        /** Number of candidate rows examined, best first. */
        maxCandidateRows: 8
    },

    /* ----------------------------------------------------------- distance */
    /**
     * Monocular distance estimation.
     *
     * These are estimates, not measurements. The ground-contact anchors are
     * calibrated for a chest/hand-held rear camera and are deliberately coarse.
     * Every consumer must show the uncertainty range rather than a single
     * authoritative number.
     */
    distance: {
        enabled: true,
        /**
         * bottomY -> metres. A lower ground-contact row means the object is
         * closer. Values between anchors are linearly interpolated.
         */
        anchors: [
            { bottomY: 0.42, meters: 7.0 },
            { bottomY: 0.50, meters: 4.5 },
            { bottomY: 0.60, meters: 2.8 },
            { bottomY: 0.70, meters: 1.8 },
            { bottomY: 0.80, meters: 1.2 },
            { bottomY: 0.90, meters: 0.8 },
            { bottomY: 0.98, meters: 0.5 }
        ],
        /** Focal length as a fraction of frame height (roughly 60 deg vFOV). */
        focalLengthFraction: 0.90,
        /** Ground contact is the more trustworthy cue for floor-standing objects. */
        groundWeight: 0.78,
        heightWeight: 0.22,
        /** Exponential smoothing of the per-track metre estimate. */
        smoothingAlpha: 0.35,
        /** Box heights below this make the height cue unusable. */
        minBoxHeight: 0.035,
        baseUncertaintyRatio: 0.16,
        structuralUncertaintyRatio: 0.20,
        minUncertaintyM: 0.18,
        maxUncertaintyRatio: 0.60,
        minMeters: 0.25,
        maxMeters: 20,
        /** Drop a track's smoothing state after this long unseen. */
        staleMs: 1200,
        /** Category boundaries used by the structural risk rules. */
        veryNearM: 1.0,
        nearM: 2.2,
        mediumM: 4.5,
        /** Farther than this is not worth showing in the object-ahead panel. */
        objectAheadMaxM: 9
    },

    /* -------------------------------------------------------- distance bands */

    /**
     * Approximate proximity bands. Deliberately coarse: the separate `distance`
     * section provides the metre estimate and its range. `bottomY` is the
     * ground-contact cue and is the primary signal; `area` is the secondary
     * signal.
     */
    proximity: {
        VERY_NEAR: { minBottomY: 0.86, minArea: 0.26, proximity: 1.00, label: "very near" },
        NEAR: { minBottomY: 0.74, minArea: 0.13, proximity: 0.78, label: "near" },
        MEDIUM: { minBottomY: 0.58, minArea: 0.045, proximity: 0.50, label: "medium" },
        FAR: { minBottomY: 0.00, minArea: 0.000, proximity: 0.22, label: "far" }
    },

    /* --------------------------------------------------------------- risk */

    risk: {
        /** Approach-rate multipliers. */
        approachFactor: 1.30,
        rapidApproachFactor: 1.70,
        recedingFactor: 0.72,
        /** Lateral motion into the corridor. */
        convergingFactor: 1.22,
        divergingFactor: 0.80,
        /** Minimum weight given to a barely-stable track. */
        minStabilityFactor: 0.55,
        /** Risk at or above this is treated as a critical, immediate threat. */
        criticalThreshold: 78,
        /** Risk at or above this warrants an avoidance manoeuvre. */
        avoidThreshold: 46,
        /** Risk below this is not worth mentioning. */
        noticeThreshold: 26,

        /* --- structural (wall/barrier) hazards ------------------------- */
        /**
         * A wall is a continuous surface, so its distance is a stronger signal
         * than its box area. These thresholds are in estimated metres.
         */
        structuralCriticalDistanceM: 1.2,
        structuralStopDistanceM: 1.6,
        structuralCautionDistanceM: 5.0,
        /**
         * A wall this far away is still shown in the object-ahead panel. It
         * must not be forgotten just because it is not yet urgent: a wall
         * straight ahead is the situation that used to produce "Path clear".
         */
        structuralNoticeDistanceM: 9.0,
        /** Wall overlap with the walking corridor needed to count as "in front". */
        structuralMinPathOverlap: 0.20,
        /** A wall whose visible base is this low is at arm's length. */
        structuralCriticalBottomY: 0.86,
        /** Risk floors for a structural obstacle that is genuinely in the path. */
        structuralCriticalRiskFloor: 84,
        structuralStopRiskFloor: 80,
        structuralCautionRiskFloor: 48,
        structuralNoticeRiskFloor: 32
    },

    /* -------------------------------------------------------- path scoring */

    pathScore: {
        /**
         * Weights for combining free space and obstacle risk into a 0-100 path
         * score. Free space dominates deliberately (requirement 65).
         */
        freeSpaceWeight: 0.60,
        riskWeight: 0.40,
        /** A sector narrower than a shoulder width is unusable regardless of score. */
        impassablePenalty: 0.25,
        /** Score at or above this counts as a safe path. */
        safeThreshold: 55,
        /** Score below this counts as blocked. */
        blockedThreshold: 32,
        /** Deviating from straight ahead has a cost; do not steer for nothing. */
        lateralMoveCost: 8,
        /** Large deviation ("move left") costs more than a small one. */
        largeMoveCost: 14
    },

    /* --------------------------------------------------------- hysteresis */

    hysteresis: {
        /**
         * A new direction must beat the held direction's path score by this
         * margin before the system will switch. This single number is what
         * stops LEFT/RIGHT/LEFT oscillation (requirement 30).
         */
        switchMarginPoints: 14,
        /** Minimum time a non-critical direction is held, in milliseconds. */
        holdMs: 1400,
        /** Minimum time before returning to CONTINUE after a manoeuvre. */
        clearHoldMs: 900,
        /** Consecutive frames of agreement required to adopt a new direction. */
        confirmFrames: 2,
        /** Decision confidence below which we advise caution instead of a side. */
        minDirectionConfidence: 0.52
    },

    /* -------------------------------------------------------- path status */

    pathClear: {
        /**
         * "Path clear" is only spoken after an obstacle state, and only once the
         * path has stayed clear this long (requirement 38).
         */
        stabilityMs: 1600
    }
};

export default NavigationConfig;
