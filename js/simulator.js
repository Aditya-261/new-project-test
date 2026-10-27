/**
 * Interactive 3-Sector Pathway Simulator
 * Provides real-time interactive corridor demonstration on the landing page.
 */

(function initSimulator() {
    const laneLeft = document.getElementById("sim-lane-left");
    const laneCenter = document.getElementById("sim-lane-center");
    const laneRight = document.getElementById("sim-lane-right");
    const speechOutput = document.getElementById("sim-speech-text");

    if (!laneLeft || !laneCenter || !laneRight || !speechOutput) {
        return;
    }

    const state = {
        left: "clear",
        center: "clear",
        right: "clear"
    };

    const PRESETS = {
        clear: {
            left: "clear",
            center: "clear",
            right: "clear",
            advice: "Path clear ahead, proceed straight."
        },
        center_obstacle: {
            left: "caution",
            center: "blocked",
            right: "clear",
            advice: "Obstacle ahead at 1.4m. Clear path on right, steer right."
        },
        left_hazard: {
            left: "blocked",
            center: "blocked",
            right: "clear",
            advice: "Path blocked ahead. Steer right."
        },
        hazard_stop: {
            left: "blocked",
            center: "blocked",
            right: "blocked",
            advice: "Stop immediately! Hazard blocking corridor."
        }
    };

    function speakText(text) {
        if ("speechSynthesis" in window) {
            try {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.rate = 1.05;
                utterance.pitch = 1.0;
                window.speechSynthesis.speak(utterance);
            } catch {
                // Ignore synthesis failure
            }
        }
    }

    function renderSimulator(adviceText, speak = false) {
        // Update Lane Classes
        [
            { el: laneLeft, status: state.left, name: "Left" },
            { el: laneCenter, status: state.center, name: "Center" },
            { el: laneRight, status: state.right, name: "Right" }
        ].forEach(({ el, status, name }) => {
            el.className = `sim-lane ${status}`;
            const badge = el.querySelector(".sim-lane-status");
            const icon = el.querySelector(".sim-lane-icon");
            if (badge) badge.textContent = status.toUpperCase();
            if (icon) {
                if (status === "clear") icon.textContent = "🟢";
                else if (status === "caution") icon.textContent = "🟡";
                else icon.textContent = "🔴";
            }
        });

        speechOutput.textContent = adviceText;

        if (speak) {
            speakText(adviceText);
        }
    }

    function applyPreset(key, speak = true) {
        const preset = PRESETS[key];
        if (!preset) return;

        state.left = preset.left;
        state.center = preset.center;
        state.right = preset.right;

        document.querySelectorAll(".btn-sim-preset").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.preset === key);
        });

        renderSimulator(preset.advice, speak);
    }

    // Attach Preset Buttons
    document.querySelectorAll(".btn-sim-preset").forEach(btn => {
        btn.addEventListener("click", () => {
            applyPreset(btn.dataset.preset, true);
        });
    });

    // Make lanes clickable to toggle
    const transitions = {
        clear: "caution",
        caution: "blocked",
        blocked: "clear"
    };

    [
        { el: laneLeft, key: "left" },
        { el: laneCenter, key: "center" },
        { el: laneRight, key: "right" }
    ].forEach(({ el, key }) => {
        el.style.cursor = "pointer";
        el.addEventListener("click", () => {
            state[key] = transitions[state[key]];
            let advice = "Corridor clear.";
            if (state.center === "blocked") {
                if (state.right === "clear") advice = "Obstacle ahead. Steer right.";
                else if (state.left === "clear") advice = "Obstacle ahead. Steer left.";
                else advice = "Stop immediately! Path blocked.";
            } else if (state.left === "blocked") {
                advice = "Caution, obstacle on left.";
            } else if (state.right === "blocked") {
                advice = "Caution, obstacle on right.";
            }
            renderSimulator(advice, true);
        });
    });

    // Initialize in clear state
    applyPreset("clear", false);
})();
