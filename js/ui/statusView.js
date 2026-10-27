/**
 * Audio-first status view.
 *
 * Audio is the primary output; this is the visual companion. Its job is to make
 * the system's state unambiguous at a glance, because "is this thing actually
 * running?" is a question the user should never have to ask (requirement 58).
 *
 * Accessibility notes:
 *  - Two live regions. Guidance is `assertive` so it interrupts a screen reader
 *    mid-sentence, exactly like the emergency speech path. Status is `polite` so
 *    lifecycle chatter never talks over guidance.
 *  - The action card is presented as a status, not a heading, so a screen reader
 *    announces changes rather than requiring navigation.
 *  - Nothing conveys meaning by colour alone; every state has text.
 */

import { Action } from "../navigation/decisionEngine.js";
import { isStructuralClass } from "../config/classCatalog.js";
import { NavigationConfig } from "../config/navigationConfig.js";
import { formatMeters } from "../perception/distanceEstimator.js";

/** The complete set of user-visible states. */
export const UiState = Object.freeze({
    IDLE: "IDLE",
    INITIALIZING: "INITIALIZING",
    VISION_READY: "VISION_READY",
    ASSISTANCE_ACTIVE: "ASSISTANCE_ACTIVE",
    PAUSED: "PAUSED",
    LOW_VISIBILITY: "LOW_VISIBILITY",
    RECOVERING: "RECOVERING",
    VISION_ERROR: "VISION_ERROR",
    STOPPED: "STOPPED",
    BENCHMARKING: "BENCHMARKING"
});

const STATE_PRESENTATION = Object.freeze({
    [UiState.IDLE]: { text: "Idle", tone: "neutral" },
    [UiState.INITIALIZING]: { text: "Initialising", tone: "warning" },
    [UiState.VISION_READY]: { text: "Vision ready", tone: "ready" },
    [UiState.ASSISTANCE_ACTIVE]: { text: "Assistance active", tone: "active" },
    [UiState.PAUSED]: { text: "Paused", tone: "warning" },
    [UiState.LOW_VISIBILITY]: { text: "Low visibility", tone: "warning" },
    [UiState.RECOVERING]: { text: "Recovering", tone: "warning" },
    [UiState.VISION_ERROR]: { text: "Vision error", tone: "danger" },
    [UiState.STOPPED]: { text: "Stopped", tone: "neutral" },
    [UiState.BENCHMARKING]: { text: "Benchmarking", tone: "active" }
});

/** Human-facing text for each action. Mirrors the spoken phrasing. */
const ACTION_PRESENTATION = Object.freeze({
    [Action.STOP]: { headline: "STOP", tone: "stop" },
    [Action.MOVE_LEFT]: { headline: "MOVE LEFT", tone: "move" },
    [Action.MOVE_SLIGHTLY_LEFT]: { headline: "SLIGHTLY LEFT", tone: "move" },
    [Action.MOVE_RIGHT]: { headline: "MOVE RIGHT", tone: "move" },
    [Action.MOVE_SLIGHTLY_RIGHT]: { headline: "SLIGHTLY RIGHT", tone: "move" },
    [Action.CAUTION]: { headline: "CAUTION", tone: "caution" },
    [Action.CONTINUE]: { headline: "CLEAR", tone: "clear" }
});

function riskBand(risk) {
    const cfg = NavigationConfig.risk;
    if (risk >= cfg.criticalThreshold) return "critical";
    if (risk >= cfg.avoidThreshold) return "high";
    if (risk >= cfg.noticeThreshold) return "medium";
    return "low";
}

function directionText(obstacle) {
    const sector = obstacle?.corridorEval?.sector;
    if (sector === "LEFT") return "To your left";
    if (sector === "RIGHT") return "To your right";
    if ((obstacle?.pathOverlap ?? 0) >= NavigationConfig.corridor.minOverlapRatio) {
        return "Straight ahead, in your path";
    }
    return "Nearby, outside your path";
}

function distanceText(obstacle) {
    if (!Number.isFinite(obstacle?.distanceMeters)) return "Distance unknown";
    let text = `Estimated ${formatMeters(obstacle.distanceMeters)}`;
    const range = obstacle.distanceRange;
    if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
        text += ` · likely ${formatMeters(range.min)}–${formatMeters(range.max)}`;
    }
    return text;
}

export class StatusView {
    constructor({
        statusPill = document.getElementById("main-status-pill"),
        headline = document.getElementById("main-action-headline"),
        subline = document.getElementById("main-reason-subline"),
        card = document.getElementById("main-action-card"),
        objectPanel = document.getElementById("object-ahead-panel"),
        objectRisk = document.getElementById("object-ahead-risk"),
        objectName = document.getElementById("object-ahead-name"),
        objectDirection = document.getElementById("object-ahead-direction"),
        objectDistance = document.getElementById("object-ahead-distance"),
        objectExplanation = document.getElementById("object-ahead-explanation"),
        guidanceRegion = document.getElementById("aria-guidance-announcer"),
        statusRegion = document.getElementById("aria-status-announcer"),
        progressBar = document.getElementById("startup-progress"),
        progressLabel = document.getElementById("startup-progress-label")
    } = {}) {
        this.statusPill = statusPill;
        this.headline = headline;
        this.subline = subline;
        this.card = card;
        this.objectPanel = objectPanel;
        this.objectRisk = objectRisk;
        this.objectName = objectName;
        this.objectDirection = objectDirection;
        this.objectDistance = objectDistance;
        this.objectExplanation = objectExplanation;
        this.guidanceRegion = guidanceRegion;
        this.statusRegion = statusRegion;
        this.progressBar = progressBar;
        this.progressLabel = progressLabel;

        this.state = UiState.IDLE;
        this._lastHeadline = "";
        this._lastSubline = "";
        this._lastGuidance = "";
    }

    setState(state, detail = null) {
        this.state = state;
        const presentation = STATE_PRESENTATION[state] || STATE_PRESENTATION[UiState.IDLE];
        const text = detail ? `${presentation.text} · ${detail}` : presentation.text;

        if (this.statusPill) {
            this.statusPill.textContent = text;
            this.statusPill.className = `status-pill ${presentation.tone}`;
        }
        this.announceStatus(text);
        return state;
    }

    /**
     * Reflect a navigation decision.
     *
     * The subline carries the honest detail: what was detected, how close, how
     * confident. It deliberately shows confidence rather than hiding it
     * (requirement 50) - this is a prototype and the UI says so.
     */
    updateDecision(decision, context = {}) {
        if (!this.headline) return;

        const obstacle = decision.primaryObstacle;
        let presentation = ACTION_PRESENTATION[decision.action] || ACTION_PRESENTATION[Action.CAUTION];

        /**
         * Never show "CLEAR" while a wall or other obstacle is retained in the
         * path. CONTINUE is still the right action - walk on - but the visual
         * headline must describe the situation, not just the command. A wall is
         * named explicitly because that is the failure this panel exists to fix.
         */
        if (decision.action === Action.CONTINUE && obstacle) {
            const structural = isStructuralClass(obstacle.label);
            presentation = {
                headline: structural
                    ? `${String(obstacle.label).toUpperCase()} AHEAD`
                    : "OBJECT AHEAD",
                tone: "caution"
            };
        }

        if (presentation.headline !== this._lastHeadline) {
            this.headline.textContent = presentation.headline;
            this._lastHeadline = presentation.headline;
        }

        const sub = this._buildSubline(decision, context);
        if (sub !== this._lastSubline && this.subline) {
            this.subline.textContent = sub;
            this._lastSubline = sub;
        }

        if (this.card) {
            this.card.className = `action-card action-${presentation.tone}`;
        }

        this._renderObjectAhead(obstacle);
    }

    /**
     * Show the single most relevant object with label, direction, estimated
     * distance and the plain-language reason for that estimate.
     */
    _renderObjectAhead(obstacle) {
        if (!this.objectPanel) return;

        if (!obstacle) {
            this.objectPanel.hidden = true;
            return;
        }

        // Beyond this range the object is not an immediate walking decision.
        // Keeping it off the panel also keeps attention on what is close.
        const meters = obstacle.distanceMeters;
        if (Number.isFinite(meters) && meters > NavigationConfig.distance.objectAheadMaxM) {
            this.objectPanel.hidden = true;
            return;
        }

        const band = riskBand(obstacle.risk ?? 0);
        this.objectPanel.hidden = false;
        this.objectPanel.className = `object-ahead-card risk-${band}`;

        if (this.objectRisk) {
            this.objectRisk.textContent = `Risk ${Math.round(obstacle.risk ?? 0)} · ${band}`;
            this.objectRisk.className = `object-ahead-risk risk-${band}`;
        }
        if (this.objectName) {
            this.objectName.textContent = String(obstacle.label || "Obstacle").toUpperCase();
        }
        if (this.objectDirection) {
            this.objectDirection.textContent = directionText(obstacle);
        }
        if (this.objectDistance) {
            this.objectDistance.textContent = distanceText(obstacle);
        }
        if (this.objectExplanation) {
            this.objectExplanation.textContent = obstacle.distanceExplanation
                || "The distance is a monocular estimate. Use the range as a guide, not a measurement.";
        }
    }

    _buildSubline(decision, context) {
        const parts = [];
        const obstacle = decision.primaryObstacle;

        if (obstacle) {
            const distance = String(obstacle.distanceCategory || "unknown").toLowerCase().replace("_", " ");
            const meters = Number.isFinite(obstacle.distanceMeters)
                ? ` · ${formatMeters(obstacle.distanceMeters)}`
                : "";
            parts.push(`${obstacle.label} · ${distance}${meters} · risk ${obstacle.risk}`);
        } else if (decision.action === Action.CONTINUE) {
            parts.push("No obstacle in path");
        }

        if (decision.action !== Action.CONTINUE) {
            parts.push(`confidence ${Math.round(decision.confidence * 100)}%`);
        }

        if (context.pathScores) {
            const p = context.pathScores;
            parts.push(`L${p.left.score} C${p.center.score} R${p.right.score}`);
        }

        if (decision.held) parts.push("holding");
        if (context.degradationLabel && context.degradationLevel > 1) {
            parts.push(context.degradationLabel);
        }

        return parts.join("  •  ") || "Ready";
    }

    /**
     * Mirror spoken guidance to the assertive live region.
     *
     * Screen-reader users get the same information as speech-synthesis users
     * without both talking at once, because the app's own synthesis can be muted
     * independently.
     */
    announceGuidance(text) {
        if (!this.guidanceRegion || !text) return;
        if (text === this._lastGuidance) {
            // Re-announcing identical text requires clearing first; otherwise
            // assistive technology treats it as unchanged and stays silent.
            this.guidanceRegion.textContent = "";
        }
        this._lastGuidance = text;
        this.guidanceRegion.textContent = text;
    }

    announceStatus(text) {
        if (!this.statusRegion || !text) return;
        this.statusRegion.textContent = text;
    }

    /** Startup progress: model download, warm-up, health check. */
    setProgress({ ratio = null, label = null, visible = true } = {}) {
        if (this.progressBar) {
            this.progressBar.style.display = visible ? "block" : "none";
            if (ratio === null) {
                this.progressBar.removeAttribute("value");
                this.progressBar.setAttribute("aria-valuetext", label || "working");
            } else {
                this.progressBar.value = Math.round(ratio * 100);
                this.progressBar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
            }
        }
        if (this.progressLabel && label !== null) {
            this.progressLabel.textContent = label;
        }
    }

    hideProgress() {
        this.setProgress({ visible: false, label: "" });
    }
}

export default StatusView;
