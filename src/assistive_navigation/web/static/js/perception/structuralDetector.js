/**
 * Classical structural-obstacle detection: walls and barriers.
 *
 * COCO has no `wall` class, so a detector trained on COCO can look straight at a
 * wall and report nothing. That is the bug this module exists to fix: the app
 * used to say "Path clear" while the user was walking into a wall.
 *
 * The detector works on the same 64x48 luminance thumbnail the rest of the
 * analysis stages use. It does not try to recognise what a wall *is*. It looks
 * for the geometry every wall/floor junction shares:
 *
 *   - a broad, coherent horizontal edge (the wall meets the floor),
 *   - a region above that edge that is textured or has vertical structure,
 *   - a region below it that looks like floor,
 *   - and enough visible wall above the edge to be a surface, not a floor seam.
 *
 * Everything that makes a floor marking, a rug edge, a painted line or a
 * staircase look like a wall is explicitly rejected:
 *
 *   - thin lines are rejected because the floor immediately below the edge has
 *     the same brightness as the floor above it (the `below` sample starts one
 *     row *past* the edge, so a one-row dark line cannot create contrast),
 *   - the row touching the boundary is excluded from the "wall body"
 *     statistics. Without that, a one-row floor marking is itself the texture
 *     and contrast evidence that makes the marking look like a wall,
 *   - plain floors are rejected because there is no edge above the noise floor,
 *   - stair/tile patterns are rejected because their whole-row brightness
 *     alternation dominates the above-region variance, and because they produce
 *     several equally strong horizontal edges above the candidate,
 *   - uniform regions near the horizon are treated as sky/horizon rather than
 *     a distant wall. A featureless surface cannot be distinguished from sky in
 *     one frame, so it only counts once it is close enough to matter.
 *
 * The output is a synthetic detection with `structural: true`, in camera-space
 * normalised coordinates. The app maps it through `CoordinateMapper` exactly
 * like a COCO detection, then feeds it to the normal tracker, risk and decision
 * stages.
 *
 * Pure. No DOM. Unit-testable.
 */

import { NavigationConfig } from "../config/navigationConfig.js";

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

function iou(a, b) {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]);
    const y2 = Math.min(a[3], b[3]);
    const iw = Math.max(0, x2 - x1);
    const ih = Math.max(0, y2 - y1);
    const intersection = iw * ih;
    if (intersection <= 0) return 0;
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const union = areaA + areaB - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Longest near-contiguous run of columns whose horizontal edge exceeds
 * `threshold`. A small gap tolerance is deliberate: a chair leg, a door frame
 * or a shadow can interrupt the wall/floor line for a column or two without
 * making the wall disappear.
 */
function longestEdgeRun(edge, width, threshold, gapTolerance) {
    let bestStart = 0;
    let bestEnd = 0;
    let bestLength = 0;
    let runStart = -1;
    let lastEdge = -1;

    for (let x = 0; x <= width; x += 1) {
        const on = x < width && edge[x] >= threshold;
        if (on) {
            if (runStart < 0) runStart = x;
            lastEdge = x;
            continue;
        }
        if (runStart >= 0 && (x >= width || x - lastEdge > gapTolerance)) {
            const length = lastEdge - runStart + 1;
            if (length > bestLength) {
                bestLength = length;
                bestStart = runStart;
                bestEnd = lastEdge + 1;
            }
            runStart = -1;
            lastEdge = -1;
        }
    }

    return { start: bestStart, end: bestEnd, length: bestLength };
}

/**
 * Detect structural candidates in one luminance thumbnail.
 *
 * Exported separately from the stateful detector so the geometry can be tested
 * without any temporal state.
 *
 * @param {Uint8Array} luma
 * @param {number} width
 * @param {number} height
 * @param {object} [cfg]
 * @returns {Array<object>} candidates, strongest first
 */
export function detectStructuralCandidates(
    luma,
    width,
    height,
    cfg = NavigationConfig.structural
) {
    if (!cfg?.enabled || !luma || width < 8 || height < 8) return [];

    const minY = Math.max(1, Math.ceil(cfg.boundaryMinY * height));
    const maxY = Math.min(height - 3, Math.floor(cfg.boundaryMaxY * height));
    if (maxY < minY) return [];

    const rowMean = new Float32Array(height);
    const rowEdgeSupport = new Float32Array(height);
    const rowEdgeStrength = new Float32Array(height);
    const softThreshold = cfg.edgeThreshold * 0.7;

    // Pre-compute row-level statistics once. Candidate scoring reuses them to
    // spot repetitive horizontal patterns (stairs, tiles, slatted blinds).
    for (let y = 1; y < height; y += 1) {
        const base = y * width;
        const prev = base - width;
        let sum = 0;
        let edgeSum = 0;
        let edgeCount = 0;
        for (let x = 0; x < width; x += 1) {
            const v = luma[base + x];
            sum += v;
            const g = Math.abs(v - luma[prev + x]);
            edgeSum += g;
            if (g >= softThreshold) edgeCount += 1;
        }
        rowMean[y] = sum / width;
        rowEdgeSupport[y] = edgeCount / width;
        rowEdgeStrength[y] = edgeSum / width;
    }

    const edge = new Float32Array(width);
    const candidates = [];
    const gapTolerance = Math.max(1, Math.round(width * 0.02));
    const minWallRows = cfg.minWallHeight * height;
    const minSimilarSupport = Math.max(0.30, cfg.minRunWidth * 0.8);

    for (let y = minY; y <= maxY; y += 1) {
        const base = y * width;
        const prev = base - width;
        const next = y + 1 < height ? base + width : base;
        const hasNext = y + 1 < height;

        // Horizontal edge response. Taking the max of the two adjacent row
        // differences tolerates a boundary that is spread over two rows by
        // camera noise or anti-aliasing.
        for (let x = 0; x < width; x += 1) {
            const gPrev = Math.abs(luma[base + x] - luma[prev + x]);
            const gNext = hasNext ? Math.abs(luma[next + x] - luma[base + x]) : 0;
            edge[x] = gPrev > gNext ? gPrev : gNext;
        }

        const run = longestEdgeRun(edge, width, cfg.edgeThreshold, gapTolerance);
        const coverage = run.length / width;
        if (coverage < cfg.minRunWidth) continue;

        const xStart = run.start;
        const xEnd = run.end;
        const xCount = xEnd - xStart;
        if (xCount < 3) continue;

        // Wall region above the boundary. Near the bottom of the frame only a
        // short strip of wall is visible; far away it can occupy most of the
        // image. Either way, require at least `minWallHeight` of it.
        const wallRows = Math.round(Math.max(minWallRows, y * 0.7));
        const top = Math.max(0, y - wallRows);
        if (y - top < minWallRows) continue;

        // Floor sample starts two rows past the boundary. The boundary itself
        // may be spread over two rows by anti-aliasing, and a one-row dark
        // floor marking must not become the "floor" sample: the floor above and
        // the floor below are the same, so a seam has no above/below contrast.
        // A real wall does.
        const belowStart = y + 2;
        if (belowStart >= height - 1) continue;
        const belowRows = Math.min(
            height - belowStart,
            Math.max(2, Math.round((y - top) * 0.35))
        );
        if (belowRows < 2) continue;

        /* ------------------------------------------------- above statistics */

        // "Body" statistics exclude the row touching the boundary. That row can
        // be a floor marking, a shadow or an anti-aliased seam; letting it into
        // the wall statistics is what made a one-pixel line look textured.
        let bodySum = 0;
        let bodySq = 0;
        let bodyCount = 0;
        let bodyRowMeanSum = 0;
        let bodyRowMeanSq = 0;
        let bodyRows = 0;

        for (let ry = top; ry < y; ry += 1) {
            if (ry >= y - 1) continue;
            const rowBase = ry * width;
            let rowSum = 0;
            for (let x = xStart; x < xEnd; x += 1) {
                const v = luma[rowBase + x];
                bodySum += v;
                bodySq += v * v;
                rowSum += v;
                bodyCount += 1;
            }
            const rowMeanValue = rowSum / xCount;
            bodyRowMeanSum += rowMeanValue;
            bodyRowMeanSq += rowMeanValue * rowMeanValue;
            bodyRows += 1;
        }

        const bodyMean = bodyCount > 0 ? bodySum / bodyCount : 0;
        const bodyVar = Math.max(0, bodySq / Math.max(1, bodyCount) - bodyMean * bodyMean);
        const bodyStd = Math.sqrt(bodyVar);
        const bodyRowMean = bodyRows > 0 ? bodyRowMeanSum / bodyRows : bodyMean;
        const bodyRowVar = Math.max(
            0,
            bodyRowMeanSq / Math.max(1, bodyRows) - bodyRowMean * bodyRowMean
        );
        const bodyRowStd = Math.sqrt(bodyRowVar);

        /* ------------------------------------------------- below statistics */

        let belowSum = 0;
        let belowSq = 0;
        let belowCount = 0;
        for (let ry = belowStart; ry < belowStart + belowRows; ry += 1) {
            const rowBase = ry * width;
            for (let x = xStart; x < xEnd; x += 1) {
                const v = luma[rowBase + x];
                belowSum += v;
                belowSq += v * v;
                belowCount += 1;
            }
        }
        const belowMean = belowCount > 0 ? belowSum / belowCount : 0;
        const belowVar = Math.max(0, belowSq / Math.max(1, belowCount) - belowMean * belowMean);
        const belowStd = Math.sqrt(belowVar);

        /* ----------------------------------------------------- edge evidence */

        let boundaryStrength = 0;
        for (let x = xStart; x < xEnd; x += 1) boundaryStrength += edge[x];
        boundaryStrength /= xCount;

        let verticalEdges = 0;
        let verticalPairs = 0;
        for (let ry = top; ry < y; ry += 1) {
            const rowBase = ry * width;
            for (let x = xStart; x < xEnd - 1; x += 1) {
                if (Math.abs(luma[rowBase + x] - luma[rowBase + x + 1]) >= cfg.edgeThreshold) {
                    verticalEdges += 1;
                }
                verticalPairs += 1;
            }
        }
        const verticalDensity = verticalPairs > 0 ? verticalEdges / verticalPairs : 0;

        const contrast = Math.abs(bodyMean - belowMean);
        const textureDelta = Math.abs(bodyStd - belowStd);
        const yNorm = y / height;
        const closeWall = yNorm >= 1 - cfg.closeFloorMaxFraction;
        const bandingRatio = bodyStd > 1e-6 ? bodyRowStd / bodyStd : 0;

        /* ------------------------------------------------ wall-likeness gates */

        // At least one of: a textured surface above, vertical structure above,
        // or a flat surface with a strong brightness step. A plain floor has
        // none of these. A flat, featureless surface near the horizon is
        // indistinguishable from sky, so it only counts once it is close enough
        // to be a hazard.
        const texturedWall = bodyStd >= cfg.minAboveTexture && textureDelta >= 1.2;
        const verticalWall = verticalDensity >= cfg.minVerticalEdgeDensity && textureDelta >= 0.8;
        const flatWall = bodyRowStd < 3.5
            && contrast >= cfg.minAboveContrast * 1.5
            && yNorm >= cfg.uniformWallMinY;
        if (!texturedWall && !verticalWall && !flatWall) continue;

        // Whole-row brightness alternation is the signature of stairs, tiles or
        // slats, not a wall. A genuine textured surface varies within rows as
        // well, so its row-mean spread is small relative to its pixel spread.
        const horizontalBanding = bodyRowStd >= cfg.minBandRowStd
            && bandingRatio >= cfg.maxBandRowRatio
            && verticalDensity < cfg.minVerticalEdgeDensity;
        if (horizontalBanding) continue;

        if (contrast < cfg.minAboveContrast && boundaryStrength < cfg.edgeThreshold * 1.5) {
            continue;
        }

        // A very low boundary is the most dangerous false positive: a floor
        // seam there would read as a wall at arm's length. Demand structural
        // evidence that a seam does not have.
        if (yNorm > cfg.contrastOnlyMaxY) {
            const closeEvidence = closeWall
                && coverage >= 0.5
                && contrast >= cfg.minAboveContrast * 1.2
                && (
                    textureDelta >= 1.8
                    || verticalDensity >= cfg.minVerticalEdgeDensity * 1.5
                    || (flatWall && bodyStd < 2.5 && belowStd < 2.5 && contrast >= cfg.minAboveContrast * 1.8)
                );
            if (!closeEvidence) continue;
        }

        // Repetitive horizontal edges above the candidate mean stairs, tiles or
        // slats, not a wall. A baseboard or picture rail (one or two) is fine.
        let similarRows = 0;
        const similarStrengthFloor = Math.max(cfg.edgeThreshold * 0.7, boundaryStrength * 0.55);
        for (let ry = Math.max(1, top); ry <= y - 3; ry += 1) {
            if (
                rowEdgeSupport[ry] >= minSimilarSupport
                && rowEdgeStrength[ry] >= similarStrengthFloor
            ) {
                similarRows += 1;
            }
        }
        if (similarRows > cfg.maxSimilarRows) continue;

        /* --------------------------------------------------------- confidence */

        const coverageScore = clamp(
            (coverage - cfg.minRunWidth) / Math.max(1e-6, 0.85 - cfg.minRunWidth),
            0,
            1
        );
        const contrastScore = clamp(contrast / 30, 0, 1);
        const textureScore = clamp((bodyStd + textureDelta * 1.5) / 18, 0, 1);
        const edgeScore = clamp(verticalDensity / 0.07, 0, 1);
        const strengthScore = clamp(boundaryStrength / 40, 0, 1);
        const heightScore = clamp(
            (yNorm - cfg.boundaryMinY) / Math.max(0.1, 0.92 - cfg.boundaryMinY),
            0,
            1
        );

        let confidence = 0.24 * coverageScore
            + 0.20 * contrastScore
            + 0.18 * textureScore
            + 0.12 * edgeScore
            + 0.14 * strengthScore
            + 0.12 * heightScore;
        confidence = clamp(confidence, cfg.confidenceFloor, cfg.confidenceCeil);

        candidates.push({
            label: coverage >= cfg.wallWidthFraction ? "wall" : "barrier",
            confidence: Number(confidence.toFixed(3)),
            box: [xStart / width, top / height, xEnd / width, y / height],
            boundaryY: Number(yNorm.toFixed(4)),
            coverage: Number(coverage.toFixed(3)),
            contrast: Number(contrast.toFixed(1)),
            aboveTexture: Number(bodyStd.toFixed(1)),
            belowTexture: Number(belowStd.toFixed(1)),
            rowBanding: Number(bandingRatio.toFixed(2)),
            verticalEdgeDensity: Number(verticalDensity.toFixed(3)),
            similarRows,
            evidence: {
                coverage: Number(coverage.toFixed(3)),
                contrast: Number(contrast.toFixed(1)),
                textureDelta: Number(textureDelta.toFixed(1)),
                rowBanding: Number(bandingRatio.toFixed(2)),
                verticalEdgeDensity: Number(verticalDensity.toFixed(3)),
                boundaryStrength: Number(boundaryStrength.toFixed(1)),
                similarRows
            }
        });
    }

    // Strongest first. When two candidates are equally strong, the lower one
    // wins: it is nearer, and a near wall matters more than a far one.
    candidates.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return b.boundaryY - a.boundaryY;
    });

    // Collapse candidates that describe the same boundary. Returning a couple
    // is useful for diagnostics, but the tracker should not receive a cluster
    // of boxes for one wall.
    const out = [];
    const ranked = candidates.slice(0, Math.max(1, cfg.maxCandidateRows));
    for (const candidate of ranked) {
        if (out.some((accepted) => Math.abs(accepted.boundaryY - candidate.boundaryY) <= cfg.rowTolerance)) {
            continue;
        }
        out.push(candidate);
        if (out.length >= 2) break;
    }
    return out;
}

/**
 * Stateful wrapper: temporal confirmation, box smoothing and a stable label.
 *
 * One frame of a horizontal edge is not evidence of a wall. Two consecutive
 * frames at roughly the same place is. A very strong first frame is allowed
 * through immediately so a wall appearing at arm's length is not delayed by a
 * confirmation frame.
 */
export class StructuralDetector {
    constructor(cfg = NavigationConfig.structural) {
        this.cfg = cfg;
        this._candidate = null;
        this._misses = 0;
        this.lastCandidates = [];
        this.lastDetection = null;
        this.totalDetections = 0;
        this.confirmations = 0;
    }

    /**
     * @param {{luma:Uint8Array, width:number, height:number}|null} sample
     * @param {{nowMs?:number, reset?:boolean}} [ctx]
     * @returns {{detections:Array, candidates:Array, metrics:object}}
     */
    update(sample, { nowMs = 0, reset = false } = {}) {
        if (reset) this.reset();

        if (!this.cfg?.enabled || !sample?.luma || !sample.width || !sample.height) {
            this._candidate = null;
            this.lastCandidates = [];
            this.lastDetection = null;
            return { detections: [], candidates: [], metrics: this.metrics() };
        }

        const candidates = detectStructuralCandidates(
            sample.luma,
            sample.width,
            sample.height,
            this.cfg
        );
        this.lastCandidates = candidates;
        const best = candidates[0] || null;

        if (!best) {
            this._misses += 1;
            if (this._misses >= 2) this._candidate = null;
            this.lastDetection = null;
            return { detections: [], candidates, metrics: this.metrics() };
        }
        this._misses = 0;

        const previous = this._candidate;
        const matches = previous
            && (
                iou(previous.box, best.box) >= this.cfg.matchIou
                || Math.abs(previous.boundaryY - best.boundaryY) <= this.cfg.matchBoundaryY
            );

        let candidate;
        if (matches) {
            const alpha = this.cfg.smoothAlpha;
            for (let i = 0; i < 4; i += 1) {
                previous.box[i] = alpha * best.box[i] + (1 - alpha) * previous.box[i];
            }
            previous.boundaryY = alpha * best.boundaryY + (1 - alpha) * previous.boundaryY;
            previous.confidence = Math.max(
                best.confidence,
                0.5 * previous.confidence + 0.5 * best.confidence
            );
            previous.label = best.label;
            previous.coverage = best.coverage;
            previous.evidence = best.evidence;
            previous.hits += 1;
            previous.lastMs = nowMs;
            candidate = previous;
        } else {
            candidate = {
                ...best,
                box: best.box.slice(),
                hits: 1,
                lastMs: nowMs
            };
            this._candidate = candidate;
        }

        const confirmed = candidate.hits >= this.cfg.confirmFrames
            || candidate.confidence >= this.cfg.strongConfidence;
        if (!confirmed) {
            this.lastDetection = null;
            return { detections: [], candidates, metrics: this.metrics() };
        }

        if (candidate.hits === this.cfg.confirmFrames) this.confirmations += 1;
        this.totalDetections += 1;

        const detection = {
            label: candidate.label,
            classId: -1,
            confidence: Number(candidate.confidence.toFixed(3)),
            box: candidate.box.slice(),
            visibility: 1,
            structural: true,
            boundaryY: Number(candidate.boundaryY.toFixed(4)),
            structuralEvidence: {
                ...candidate.evidence,
                hits: candidate.hits
            }
        };
        this.lastDetection = detection;
        return { detections: [detection], candidates, metrics: this.metrics() };
    }

    metrics() {
        return {
            enabled: Boolean(this.cfg?.enabled),
            candidates: this.lastCandidates.length,
            hits: this._candidate?.hits || 0,
            confirmed: Boolean(this.lastDetection),
            label: this.lastDetection?.label || null,
            boundaryY: this.lastDetection?.boundaryY ?? null,
            confidence: this.lastDetection?.confidence || 0,
            detections: this.totalDetections,
            confirmations: this.confirmations
        };
    }

    reset() {
        this._candidate = null;
        this._misses = 0;
        this.lastCandidates = [];
        this.lastDetection = null;
    }
}

export default StructuralDetector;
