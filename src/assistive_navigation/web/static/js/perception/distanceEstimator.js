/**
 * Monocular distance estimation.
 *
 * The system has no depth sensor, so every distance is an *estimate* built from
 * two weak cues:
 *
 *   1. **Ground contact.** Where an object meets the floor in the image is a
 *      strong relative cue: a lower contact line means a closer object. The
 *      anchor table in `NavigationConfig.distance` converts that row to metres.
 *   2. **Apparent height.** For classes with a plausible real-world height
 *      (person, chair, car), the pinhole relation
 *
 *          distance = (real height * focal length) / image height
 *
 *      gives an independent estimate. It is noisy, because the real height of a
 *      particular chair is unknown, so it is only a cross-check.
 *
 * A wall is treated differently. Its visible height is usually clipped by the
 * top of the frame and its real height is unknown, so only the floor-contact
 * cue is used. That is also the cue the structural detector is built around.
 *
 * Every estimate carries an uncertainty range and a plain-language explanation.
 * The UI is required to show the range; a single number would overstate what a
 * monocular camera can know.
 *
 * Pure. No DOM. Unit-testable.
 */

import { NavigationConfig } from "../config/navigationConfig.js";
import { classHeightM, isStructuralClass } from "../config/classCatalog.js";

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

function round1(v) {
    return Number.isFinite(v) ? Number(v.toFixed(1)) : null;
}

function round2(v) {
    return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

/**
 * Convert a ground-contact row (`bottomY`, 0 = top, 1 = bottom) to metres.
 *
 * Linear interpolation between anchors, with linear extrapolation outside the
 * table and a hard clamp to the configured range. Returns `null` for a
 * non-finite input rather than guessing.
 *
 * @param {number} bottomY
 * @param {Array<{bottomY:number, meters:number}>} [anchors]
 * @param {number} [minMeters]
 * @param {number} [maxMeters]
 * @returns {number|null}
 */
export function metersFromGroundContact(
    bottomY,
    anchors = NavigationConfig.distance.anchors,
    minMeters = NavigationConfig.distance.minMeters,
    maxMeters = NavigationConfig.distance.maxMeters
) {
    const y = Number(bottomY);
    if (!Number.isFinite(y) || !Array.isArray(anchors) || anchors.length === 0) return null;

    const sorted = anchors;
    let meters;

    if (y <= sorted[0].bottomY) {
        const a = sorted[0];
        const b = sorted[1] || a;
        const span = b.bottomY - a.bottomY;
        meters = span > 1e-6
            ? a.meters + ((y - a.bottomY) / span) * (b.meters - a.meters)
            : a.meters;
    } else if (y >= sorted[sorted.length - 1].bottomY) {
        const b = sorted[sorted.length - 1];
        const a = sorted[sorted.length - 2] || b;
        const span = b.bottomY - a.bottomY;
        meters = span > 1e-6
            ? b.meters + ((y - b.bottomY) / span) * (b.meters - a.meters)
            : b.meters;
    } else {
        meters = sorted[sorted.length - 1].meters;
        for (let i = 1; i < sorted.length; i += 1) {
            const a = sorted[i - 1];
            const b = sorted[i];
            if (y <= b.bottomY) {
                const span = b.bottomY - a.bottomY;
                const t = span > 1e-6 ? (y - a.bottomY) / span : 0;
                meters = a.meters + t * (b.meters - a.meters);
                break;
            }
        }
    }

    return clamp(meters, minMeters, maxMeters);
}

/**
 * Pinhole height estimate.
 *
 * @param {number} boxHeight normalised box height (0..1)
 * @param {string} label
 * @param {number} [focalLengthFraction] focal length as a fraction of frame height
 * @param {number} [minBoxHeight]
 * @returns {number|null}
 */
export function metersFromApparentHeight(
    boxHeight,
    label,
    focalLengthFraction = NavigationConfig.distance.focalLengthFraction,
    minBoxHeight = NavigationConfig.distance.minBoxHeight
) {
    const h = Number(boxHeight);
    if (!Number.isFinite(h) || h < minBoxHeight) return null;
    const realHeight = classHeightM(label);
    if (!(realHeight > 0)) return null;
    return clamp(
        (realHeight * focalLengthFraction) / h,
        NavigationConfig.distance.minMeters,
        NavigationConfig.distance.maxMeters
    );
}

/** Category used by the risk/decision layers, derived from metres. */
export function metersToCategory(meters, cfg = NavigationConfig.distance) {
    if (!Number.isFinite(meters)) return "UNKNOWN";
    if (meters <= cfg.veryNearM) return "VERY_NEAR";
    if (meters <= cfg.nearM) return "NEAR";
    if (meters <= cfg.mediumM) return "MEDIUM";
    return "FAR";
}

/** Human-readable metres. Kept to one decimal: the estimate is not precise. */
export function formatMeters(meters) {
    if (!Number.isFinite(meters)) return "unknown";
    return `${meters.toFixed(1)} m`;
}

function capitalise(text) {
    if (!text) return "Object";
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Plain-language explanation of an estimate.
 *
 * Deliberately states the cue, the range and the limitation. The user asked for
 * the distance to be explained, not merely displayed.
 */
export function explainDistance({
    label = "object",
    meters = null,
    range = null,
    method = "none",
    structural = false
} = {}) {
    const name = String(label || "object").toLowerCase();

    if (!Number.isFinite(meters)) {
        return `The distance to the ${name} is unknown because its floor contact is not visible. `
            + "Slow down and keep using your cane until it is clearer.";
    }

    const rangeText = range && Number.isFinite(range.min) && Number.isFinite(range.max)
        ? ` (likely ${formatMeters(range.min)}–${formatMeters(range.max)})`
        : "";

    let cue;
    if (structural) {
        cue = `This comes from the line where the ${name} meets the floor; a lower line means it is closer. `
            + "It is a monocular estimate, so use the range as a guide, not a measurement.";
    } else if (method === "combined") {
        cue = "This combines where it touches the floor with its apparent height. "
            + "It is approximate, so use the range as a guide.";
    } else if (method === "height") {
        cue = "This comes from its apparent height and a typical size for that kind of object. "
            + "No floor contact is visible, so the range is wider.";
    } else if (method === "ground") {
        cue = "This comes from where it touches the floor; a lower contact line means it is closer. "
            + "It is a monocular estimate, so use the range as a guide.";
    } else {
        cue = "This is a rough estimate. Use the range as a guide, not a measurement.";
    }

    return `${capitalise(name)} estimated at ${formatMeters(meters)}${rangeText}. ${cue}`;
}

/**
 * Distance estimator with per-track temporal smoothing.
 *
 * Smoothing matters because ground contact jitters by a row or two every frame,
 * which would otherwise make the displayed distance flicker between, say, 1.4 m
 * and 1.7 m while the user is standing still.
 */
export class DistanceEstimator {
    constructor(cfg = NavigationConfig.distance) {
        this.cfg = cfg;
        this._states = new Map();
        this.lastEstimates = [];
    }

    /**
     * Estimate one track without touching the smoothing state.
     * @returns {object}
     */
    estimate(track) {
        const cfg = this.cfg;
        const structural = Boolean(track?.structural) || isStructuralClass(track?.label);
        const box = Array.isArray(track?.box) ? track.box : [0, 0, 0, 0];
        const bottomY = Number.isFinite(track?.bottomY) ? track.bottomY : box[3];
        const boxHeight = Math.max(0, box[3] - box[1]);

        const groundMeters = metersFromGroundContact(
            bottomY,
            cfg.anchors,
            cfg.minMeters,
            cfg.maxMeters
        );
        const heightMeters = structural
            ? null
            : metersFromApparentHeight(
                boxHeight,
                track?.label,
                cfg.focalLengthFraction,
                cfg.minBoxHeight
            );

        let meters = null;
        let method = "none";
        let groundUsed = false;
        let heightUsed = false;

        if (structural) {
            if (groundMeters !== null) {
                meters = groundMeters;
                method = "structural";
                groundUsed = true;
            }
        } else if (groundMeters !== null && heightMeters !== null) {
            const ratio = heightMeters / Math.max(1e-6, groundMeters);
            if (ratio >= 0.5 && ratio <= 2.0) {
                meters = groundMeters * cfg.groundWeight + heightMeters * cfg.heightWeight;
                method = "combined";
                groundUsed = true;
                heightUsed = true;
            } else {
                // The cues disagree substantially. Ground contact is the more
                // reliable of the two for a floor-standing object, so trust it
                // and let the uncertainty range communicate the disagreement.
                meters = groundMeters;
                method = "ground";
                groundUsed = true;
            }
        } else if (groundMeters !== null) {
            meters = groundMeters;
            method = "ground";
            groundUsed = true;
        } else if (heightMeters !== null) {
            meters = heightMeters;
            method = "height";
            heightUsed = true;
        }

        if (meters === null) {
            return {
                meters: null,
                range: null,
                confidence: 0,
                method: "none",
                structural,
                groundMeters: null,
                heightMeters: null,
                explanation: explainDistance({ label: track?.label, structural })
            };
        }

        const baseRatio = structural
            ? cfg.structuralUncertaintyRatio
            : cfg.baseUncertaintyRatio;
        let spread = Math.max(cfg.minUncertaintyM, meters * baseRatio);

        if (groundUsed && heightUsed) {
            // Disagreement is information: it means the range should be wider.
            spread = Math.max(spread, Math.abs(heightMeters - groundMeters) * 0.35);
        }
        if (method === "height") spread = Math.max(spread, meters * 0.25);
        spread = Math.min(spread, meters * cfg.maxUncertaintyRatio);

        const min = Math.max(cfg.minMeters, meters - spread);
        const max = Math.min(cfg.maxMeters, meters + spread);

        const evidence = clamp(track?.confidence ?? 0.5, 0, 1);
        const agreement = method === "combined" ? 1 : (method === "ground" ? 0.8 : 0.55);
        let confidence = 0.35 + 0.35 * evidence + 0.20 * agreement;
        if (structural) confidence *= 0.95;
        confidence = clamp(confidence, 0.20, 0.95);

        return {
            meters: round1(meters),
            range: { min: round1(min), max: round1(max) },
            confidence: round2(confidence),
            method,
            structural,
            groundMeters: groundMeters !== null ? round1(groundMeters) : null,
            heightMeters: heightMeters !== null ? round1(heightMeters) : null,
            explanation: explainDistance({
                label: track?.label,
                meters,
                range: { min, max },
                method,
                structural
            })
        };
    }

    /**
     * Estimate every track and write the fields the rest of the pipeline reads.
     *
     * @param {Array} tracks
     * @param {number} nowMs
     */
    update(tracks = [], nowMs = 0) {
        const cfg = this.cfg;
        const seen = new Set();
        const estimates = [];

        for (const track of tracks) {
            if (!track || track.id === undefined || track.id === null) continue;
            seen.add(track.id);

            const raw = this.estimate(track);
            if (raw.meters === null) {
                track.distanceMeters = null;
                track.distanceRange = null;
                track.distanceConfidence = 0;
                track.distanceMethod = "none";
                track.distanceStructural = raw.structural;
                track.distanceGroundMeters = null;
                track.distanceHeightMeters = null;
                track.distanceCategory = "UNKNOWN";
                track.distanceExplanation = raw.explanation;
                continue;
            }

            let state = this._states.get(track.id);
            if (!state) {
                state = { meters: raw.meters, lastMs: nowMs };
                this._states.set(track.id, state);
            } else {
                // A sudden doubling/halving is a real approach or departure, not
                // jitter; snap to it rather than lagging behind the hazard.
                const delta = Math.abs(raw.meters - state.meters);
                const alpha = delta > state.meters * 0.75 ? 1 : cfg.smoothingAlpha;
                state.meters += alpha * (raw.meters - state.meters);
                state.lastMs = nowMs;
            }

            const spread = Math.max(
                raw.range.max - raw.meters,
                raw.meters - raw.range.min
            );
            const min = Math.max(cfg.minMeters, state.meters - spread);
            const max = Math.min(cfg.maxMeters, state.meters + spread);

            track.distanceMeters = round1(state.meters);
            track.distanceRange = { min: round1(min), max: round1(max) };
            track.distanceConfidence = raw.confidence;
            track.distanceMethod = raw.method;
            track.distanceStructural = raw.structural;
            track.distanceGroundMeters = raw.groundMeters;
            track.distanceHeightMeters = raw.heightMeters;
            track.distanceExplanation = explainDistance({
                label: track.label,
                meters: state.meters,
                range: { min, max },
                method: raw.method,
                structural: raw.structural
            });
            track.distanceCategory = metersToCategory(state.meters, cfg);

            estimates.push({ id: track.id, label: track.label, ...raw, meters: round1(state.meters) });
        }

        for (const [id, state] of this._states) {
            if (!seen.has(id) && nowMs - state.lastMs > cfg.staleMs) {
                this._states.delete(id);
            }
        }

        this.lastEstimates = estimates;
        return estimates;
    }

    metrics() {
        return {
            tracked: this._states.size,
            estimates: this.lastEstimates.length,
            nearest: this.lastEstimates.length
                ? Math.min(...this.lastEstimates.map((e) => e.meters))
                : null
        };
    }

    reset() {
        this._states.clear();
        this.lastEstimates = [];
    }
}

export default DistanceEstimator;
