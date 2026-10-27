/**
 * Structural hazards (walls and barriers) and monocular distance.
 *
 * COCO cannot see a wall, which is how the old build ended up announcing "Path
 * clear" while the user walked into one. These tests pin the replacement:
 *
 *   - geometry-only wall/barrier detection, with floor markings, stairs and the
 *     horizon explicitly rejected,
 *   - a distance estimate that is always presented with a range and an
 *     explanation,
 *   - structural risk floors, free-space blocking and STOP/CAUTION decisions,
 *   - the object-ahead panel, which must never say "CLEAR" while a wall is
 *     still in front of the user.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    detectStructuralCandidates,
    StructuralDetector
} from "../../src/assistive_navigation/web/static/js/perception/structuralDetector.js";
import {
    DistanceEstimator,
    explainDistance,
    formatMeters,
    metersFromApparentHeight,
    metersFromGroundContact,
    metersToCategory
} from "../../src/assistive_navigation/web/static/js/perception/distanceEstimator.js";
import {
    FreeSpaceEstimator,
    structuralDepthForMeters
} from "../../src/assistive_navigation/web/static/js/perception/freeSpace.js";
import { CorridorModel } from "../../src/assistive_navigation/web/static/js/navigation/corridorModel.js";
import { RiskEngine } from "../../src/assistive_navigation/web/static/js/navigation/riskEngine.js";
import {
    Action,
    DecisionEngine,
    NavigationDecision,
    Urgency
} from "../../src/assistive_navigation/web/static/js/navigation/decisionEngine.js";
import {
    SpeechPolicy,
    SpeechVerdict,
    phraseForDecision
} from "../../src/assistive_navigation/web/static/js/audio/speechPolicy.js";
import { SpeechConfig } from "../../src/assistive_navigation/web/static/js/config/speechConfig.js";
import { NavigationConfig } from "../../src/assistive_navigation/web/static/js/config/navigationConfig.js";
import { PipelineHarness } from "../../src/assistive_navigation/web/static/js/testing/pipelineHarness.js";
import { StatusView } from "../../src/assistive_navigation/web/static/js/ui/statusView.js";
import { lumaPlane } from "./helpers.mjs";

const W = 64;
const H = 48;

/** A 64x48 frame with a striped wall above `boundaryRow` and floor below. */
function wallFrame(boundaryRow, { wallWidth = W } = {}) {
    return {
        luma: lumaPlane(W, H, (x, y) => (
            x < wallWidth && y < boundaryRow
                ? 70 + (x % 4) * 15
                : 140
        )),
        width: W,
        height: H
    };
}

function frame(fn) {
    return { luma: lumaPlane(W, H, fn), width: W, height: H };
}

function element() {
    return {
        textContent: "",
        className: "",
        hidden: false,
        style: {},
        setAttribute() {},
        removeAttribute() {}
    };
}

/* ------------------------------------------------------- structural detector */

test("a striped wall is detected, and a strong first frame is not delayed", () => {
    const sample = wallFrame(30);
    const candidates = detectStructuralCandidates(sample.luma, W, H);

    assert.ok(candidates.length >= 1, "expected a wall candidate");
    assert.equal(candidates[0].label, "wall");
    assert.ok(Math.abs(candidates[0].boundaryY - 30 / H) < 1e-3);
    assert.ok(
        candidates[0].confidence >= NavigationConfig.structural.strongConfidence,
        `expected a strong candidate, got ${candidates[0].confidence}`
    );

    const detector = new StructuralDetector();
    const result = detector.update(sample, { nowMs: 100 });
    assert.equal(result.detections.length, 1, "a strong wall must not wait for confirmation");
    assert.equal(result.detections[0].structural, true);
});

test("a one-row floor marking is not a wall", () => {
    const marking = frame((x, y) => (y === 34 ? 60 : 140));
    assert.deepEqual(detectStructuralCandidates(marking.luma, W, H), []);

    const detector = new StructuralDetector();
    detector.update(marking, { nowMs: 100 });
    const second = detector.update(marking, { nowMs: 180 });
    assert.equal(second.detections.length, 0);
});

test("stair/tile banding is not a wall", () => {
    const stairs = frame((x, y) => (
        y >= 10 && y < 37
            ? ((((y - 10) >> 1) % 2) ? 70 : 150)
            : 140
    ));
    assert.deepEqual(detectStructuralCandidates(stairs.luma, W, H), []);
});

test("a featureless sky/horizon is not a distant wall", () => {
    const sky = frame((x, y) => (y < 20 ? 180 : 120));
    assert.deepEqual(detectStructuralCandidates(sky.luma, W, H), []);
});

test("a featureless wall is confirmed over two frames", () => {
    const sample = frame((x, y) => (y < 35 ? 100 : 115));
    const detector = new StructuralDetector();

    assert.equal(detector.update(sample, { nowMs: 100 }).detections.length, 0);
    const second = detector.update(sample, { nowMs: 180 });
    assert.equal(second.detections.length, 1);
    assert.equal(second.detections[0].label, "wall");
});

test("a narrow structural surface is labelled a barrier", () => {
    const sample = wallFrame(30, { wallWidth: 24 });
    const candidates = detectStructuralCandidates(sample.luma, W, H);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].label, "barrier");
    assert.ok(candidates[0].coverage < NavigationConfig.structural.wallWidthFraction);
});

test("a wall at arm's length is detected on the first frame", () => {
    const sample = wallFrame(42);
    const result = new StructuralDetector().update(sample, { nowMs: 100 });

    assert.equal(result.detections.length, 1);
    assert.ok(result.detections[0].boundaryY >= 0.86);
});

/* --------------------------------------------------------------- distance */

test("ground contact maps to metres with interpolation and clamping", () => {
    const cfg = NavigationConfig.distance;

    assert.equal(metersFromGroundContact(0.42), 7.0);
    assert.equal(metersFromGroundContact(0.80), 1.2);
    assert.ok(Math.abs(metersFromGroundContact(0.65) - 2.3) < 0.05, "interpolates between anchors");
    assert.equal(metersFromGroundContact(NaN), null);
    assert.equal(metersFromGroundContact(2.0), cfg.minMeters, "clamps below the table");
    assert.ok(metersFromGroundContact(0.1) <= cfg.maxMeters, "clamps above the table");
});

test("apparent height gives an independent, bounded estimate", () => {
    assert.ok(Math.abs(metersFromApparentHeight(0.2, "person") - 7.65) < 0.01);
    assert.equal(metersFromApparentHeight(0.01, "person"), null, "a sliver has no usable height");
    assert.equal(metersFromApparentHeight(0.2, ""), 4.05, "unknown classes use the generic prior");
});

test("metres map to the categories the risk layer consumes", () => {
    assert.equal(metersToCategory(0.8), "VERY_NEAR");
    assert.equal(metersToCategory(1.5), "NEAR");
    assert.equal(metersToCategory(3.0), "MEDIUM");
    assert.equal(metersToCategory(10.0), "FAR");
    assert.equal(metersToCategory(null), "UNKNOWN");
    assert.equal(formatMeters(1.24), "1.2 m");
});

test("the distance explanation names the cue, the range and the limitation", () => {
    const wall = explainDistance({
        label: "wall",
        meters: 1.8,
        range: { min: 1.4, max: 2.2 },
        method: "structural",
        structural: true
    });
    assert.match(wall, /Wall estimated at 1\.8 m/);
    assert.match(wall, /1\.4 m–2\.2 m/);
    assert.match(wall, /wall meets the floor/);
    assert.match(wall, /monocular estimate/);

    const chair = explainDistance({
        label: "chair",
        meters: 2.0,
        range: { min: 1.7, max: 2.3 },
        method: "ground"
    });
    assert.match(chair, /touches the floor/);

    const unknown = explainDistance({ label: "chair", method: "none" });
    assert.match(unknown, /distance to the chair is unknown/);
});

test("the estimator writes a structural distance and a range onto a track", () => {
    const estimator = new DistanceEstimator();
    const wall = {
        id: 7,
        label: "wall",
        structural: true,
        confidence: 0.9,
        box: [0.2, 0.3, 0.8, 0.8],
        bottomY: 0.8
    };

    estimator.update([wall], 1000);

    assert.equal(wall.distanceMethod, "structural");
    assert.equal(wall.distanceStructural, true);
    assert.equal(wall.distanceHeightMeters, null, "a wall's visible height is not a size prior");
    assert.ok(Math.abs(wall.distanceMeters - 1.2) < 0.01);
    assert.ok(wall.distanceRange.min <= wall.distanceMeters);
    assert.ok(wall.distanceRange.max >= wall.distanceMeters);
    assert.equal(wall.distanceCategory, "NEAR");
    assert.match(wall.distanceExplanation, /wall meets the floor/);
});

test("distance estimates are smoothed frame to frame", () => {
    const estimator = new DistanceEstimator();
    const wall = {
        id: 3,
        label: "wall",
        structural: true,
        confidence: 0.9,
        box: [0.2, 0.3, 0.8, 0.8],
        bottomY: 0.8
    };

    estimator.update([wall], 1000);
    assert.ok(Math.abs(wall.distanceMeters - 1.2) < 0.01);

    wall.bottomY = 0.7;
    wall.box = [0.2, 0.2, 0.8, 0.7];
    estimator.update([wall], 1080);

    assert.ok(
        wall.distanceMeters > 1.2 && wall.distanceMeters < 1.8,
        `expected smoothing between 1.2 and 1.8, got ${wall.distanceMeters}`
    );
    assert.ok(Math.abs(wall.distanceMeters - 1.4) < 0.05);
});

test("a floor-standing object combines ground contact and apparent height", () => {
    const estimator = new DistanceEstimator();
    const chair = {
        id: 8,
        label: "chair",
        confidence: 0.9,
        box: [0.4, 0.4, 0.6, 0.8],
        bottomY: 0.8
    };

    estimator.update([chair], 1000);

    assert.equal(chair.distanceMethod, "combined");
    assert.ok(chair.distanceMeters > 1.2 && chair.distanceMeters < 1.6);
    assert.ok(chair.distanceHeightMeters > chair.distanceGroundMeters);
});

/* --------------------------------------------------------------- free space */

test("structural distance maps to a pessimistic free depth", () => {
    assert.equal(structuralDepthForMeters(1.0), 0.05);
    assert.ok(Math.abs(structuralDepthForMeters(3.75) - 0.125) < 1e-9);
    assert.equal(structuralDepthForMeters(15), 0.80);
    assert.equal(
        structuralDepthForMeters(NaN),
        NavigationConfig.freeSpace.structuralFallbackDepthCap
    );
});

test("a wall blocks the centre columns much harder than a chair at the same box", () => {
    const corridor = new CorridorModel();
    const wall = {
        id: 1,
        label: "wall",
        structural: true,
        confidence: 0.9,
        visibility: 1,
        box: [0.4, 0.35, 0.6, 0.7],
        bottomY: 0.7,
        distanceMeters: 2.0
    };
    const chair = {
        id: 2,
        label: "chair",
        structural: false,
        confidence: 0.9,
        visibility: 1,
        box: [0.4, 0.35, 0.6, 0.7],
        bottomY: 0.7,
        distanceMeters: null
    };

    const wallReport = new FreeSpaceEstimator().update([wall], corridor.bounds);
    const chairReport = new FreeSpaceEstimator().update([chair], corridor.bounds);

    assert.ok(wallReport.clearance.center < 0.2, `wall centre ${wallReport.clearance.center}`);
    assert.ok(wallReport.clearance.left > 0.9);
    assert.ok(wallReport.clearance.right > 0.9);
    assert.equal(wallReport.passable, true, "the flanks are still walkable");
    assert.ok(
        wallReport.clearance.center < chairReport.clearance.center,
        "the wall must be treated as a surface, not a box"
    );
});

/* -------------------------------------------------------------------- risk */

function wallTrack(overrides = {}) {
    return {
        id: 1,
        label: "wall",
        structural: true,
        confidence: 0.9,
        visibility: 1,
        box: [0.3, 0.3, 0.7, 0.7],
        bottomY: 0.7,
        distanceMeters: 1.0,
        distanceCategory: "UNKNOWN",
        centerX: 0.5,
        velocityX: 0,
        velocityY: 0,
        areaGrowthRate: 0,
        stability: 1,
        emergent: false,
        ...overrides
    };
}

test("a wall in the path gets the critical structural risk floor", () => {
    const corridor = new CorridorModel();
    const wall = wallTrack();
    const engine = new RiskEngine();

    engine.scoreAll([wall], corridor);

    assert.equal(wall.distanceCategory, "VERY_NEAR");
    assert.ok(
        wall.risk >= NavigationConfig.risk.structuralCriticalRiskFloor,
        `expected risk >= ${NavigationConfig.risk.structuralCriticalRiskFloor}, got ${wall.risk}`
    );
    assert.equal(wall.riskFactors.structuralFloor, NavigationConfig.risk.structuralCriticalRiskFloor);
});

test("a far wall is still above the notice threshold", () => {
    const corridor = new CorridorModel();
    const wall = wallTrack({
        box: [0.3, 0.25, 0.7, 0.5],
        bottomY: 0.5,
        distanceMeters: 7.0
    });
    const engine = new RiskEngine();

    engine.scoreAll([wall], corridor);

    assert.equal(wall.distanceCategory, "FAR");
    assert.ok(wall.risk >= NavigationConfig.risk.structuralNoticeRiskFloor);
    assert.ok(wall.risk >= NavigationConfig.risk.noticeThreshold);
});

test("an unknown structural distance is cautious, not arm's length", () => {
    const corridor = new CorridorModel();
    const wall = wallTrack({ distanceMeters: null });
    const engine = new RiskEngine();

    engine.scoreAll([wall], corridor);

    assert.equal(wall.riskFactors.structuralFloor, NavigationConfig.risk.structuralCautionRiskFloor);
    assert.ok(wall.risk < NavigationConfig.risk.structuralCriticalRiskFloor);
});

/* --------------------------------------------------------- decision/speech */

test("structural phrases name the surface", () => {
    const wallStop = new NavigationDecision({
        action: Action.STOP,
        reason: "structural_obstacle",
        primaryObstacle: { label: "wall" }
    });
    assert.equal(phraseForDecision(wallStop).text, SpeechConfig.phrases.STOP_WALL);

    const barrierStop = new NavigationDecision({
        action: Action.STOP,
        reason: "structural_obstacle",
        primaryObstacle: { label: "barrier" }
    });
    assert.equal(phraseForDecision(barrierStop).text, SpeechConfig.phrases.STOP_BARRIER);

    const wallCaution = new NavigationDecision({
        action: Action.CAUTION,
        reason: "structural_obstacle",
        primaryObstacle: { label: "wall" }
    });
    assert.equal(phraseForDecision(wallCaution).text, SpeechConfig.phrases.WALL_AHEAD);

    const barrierCaution = new NavigationDecision({
        action: Action.CAUTION,
        reason: "structural_obstacle",
        primaryObstacle: { label: "barrier" }
    });
    assert.equal(phraseForDecision(barrierCaution).text, SpeechConfig.phrases.BARRIER_AHEAD);
});

test("a retained obstacle suppresses Path clear in both engines", () => {
    const engine = new DecisionEngine();
    engine.wasObstructed = true;
    engine.clearSince = 1000;
    engine.current = new NavigationDecision({
        action: Action.CONTINUE,
        primaryObstacle: { label: "wall", risk: 40 }
    });

    assert.equal(engine.shouldAnnounceClear(3000), false);

    engine.current = new NavigationDecision({ action: Action.CONTINUE, primaryObstacle: null });
    assert.equal(engine.shouldAnnounceClear(3000), true);

    const policy = new SpeechPolicy();
    const verdict = policy.evaluate({
        decision: new NavigationDecision({
            action: Action.CONTINUE,
            primaryObstacle: { label: "wall", risk: 40 }
        }),
        nowMs: 1000,
        announceClear: true
    });
    assert.equal(verdict.speak, false);
    assert.equal(verdict.verdict, SpeechVerdict.SILENT_CLEAR_PATH);
});

test("a close wall drives the live pipeline to STOP and speaks a wall warning", () => {
    const harness = new PipelineHarness();
    const sample = wallFrame(42);
    let record = null;

    for (let i = 0; i < 3; i += 1) {
        record = harness.step([], { sample });
    }

    assert.equal(record.decision.action, Action.STOP);
    assert.equal(record.decision.reason, "structural_obstacle");
    assert.equal(record.decision.urgency, Urgency.CRITICAL);
    assert.equal(record.primary?.structural, true);
    assert.ok(record.primary.meters <= NavigationConfig.risk.structuralCriticalDistanceM + 0.3);
    assert.ok(
        harness.utterances.some((u) => u.text === SpeechConfig.phrases.STOP_WALL),
        `expected "${SpeechConfig.phrases.STOP_WALL}", got ${harness.utterances.map((u) => u.text).join(" | ")}`
    );
    assert.ok(
        !harness.utterances.some((u) => u.text === SpeechConfig.phrases.PATH_CLEAR),
        "a wall must never produce Path clear"
    );
});

test("a medium-distance wall never produces a CONTINUE decision", () => {
    const harness = new PipelineHarness();
    const sample = wallFrame(30);
    let record = null;

    for (let i = 0; i < 3; i += 1) {
        record = harness.step([], { sample });
    }

    assert.ok(record.primary?.structural, "the wall must remain the primary hazard");
    assert.notEqual(record.decision.action, Action.CONTINUE);
    assert.ok(
        !harness.utterances.some((u) => u.text === SpeechConfig.phrases.PATH_CLEAR),
        "a wall must never produce Path clear"
    );
});

/* -------------------------------------------------------- object-ahead UI */

test("the object-ahead panel names the wall and replaces CLEAR with WALL AHEAD", () => {
    const statusPill = element();
    const headline = element();
    const subline = element();
    const card = element();
    const objectPanel = element();
    const objectRisk = element();
    const objectName = element();
    const objectDirection = element();
    const objectDistance = element();
    const objectExplanation = element();

    const view = new StatusView({
        statusPill,
        headline,
        subline,
        card,
        objectPanel,
        objectRisk,
        objectName,
        objectDirection,
        objectDistance,
        objectExplanation,
        guidanceRegion: element(),
        statusRegion: element(),
        progressBar: null,
        progressLabel: null
    });

    const explanation = "Wall estimated at 2.1 m (likely 1.7 m–2.5 m). This comes from the line where the wall meets the floor.";
    const obstacle = {
        label: "wall",
        risk: 40,
        distanceMeters: 2.1,
        distanceRange: { min: 1.7, max: 2.5 },
        distanceCategory: "NEAR",
        distanceExplanation: explanation,
        pathOverlap: 1,
        corridorEval: { sector: "CENTER" }
    };

    view.updateDecision(new NavigationDecision({
        action: Action.CONTINUE,
        primaryObstacle: obstacle
    }));

    assert.equal(headline.textContent, "WALL AHEAD");
    assert.equal(card.className, "action-card action-caution");
    assert.equal(objectPanel.hidden, false);
    assert.equal(objectPanel.className, "object-ahead-card risk-medium");
    assert.equal(objectName.textContent, "WALL");
    assert.equal(objectDirection.textContent, "Straight ahead, in your path");
    assert.match(objectDistance.textContent, /Estimated 2\.1 m/);
    assert.match(objectDistance.textContent, /likely 1\.7 m–2\.5 m/);
    assert.equal(objectExplanation.textContent, explanation);

    view.updateDecision(new NavigationDecision({
        action: Action.CONTINUE,
        primaryObstacle: { ...obstacle, label: "barrier" }
    }));
    assert.equal(headline.textContent, "BARRIER AHEAD");
    assert.equal(objectName.textContent, "BARRIER");

    view.updateDecision(new NavigationDecision({
        action: Action.CONTINUE,
        primaryObstacle: {
            ...obstacle,
            distanceMeters: NavigationConfig.distance.objectAheadMaxM + 1,
            distanceRange: { min: 9.5, max: 11.0 }
        }
    }));
    assert.equal(objectPanel.hidden, true, "objects beyond the panel range are not shown");

    view.updateDecision(new NavigationDecision({
        action: Action.CONTINUE,
        primaryObstacle: null
    }));
    assert.equal(headline.textContent, "CLEAR");
    assert.equal(objectPanel.hidden, true);
});
