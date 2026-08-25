import { presenceTargetKey, REMOTE_HIGHLIGHT_MS } from "../../core/presence.js";
import { store } from "../../core/store.js";
import {
    currentPresenceTarget,
    presenceSessionId,
    refreshPresenceTargetAttributes,
} from "./presence-coordinator.js";
import { isVisuallyRemoteChange } from "./live-sync-contracts.js";

const liveRegion = document.querySelector("#collaborationLive");
const floatingPresence = document.querySelector("#collaborationPresence");
const highlightTimers = new Map();

function colorForUser(userId) {
    let hash = 0;
    for (const character of String(userId)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    return `hsl(${Math.abs(hash) % 360} 58% 42%)`;
}

function initials(name) {
    return String(name || "V").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("es");
}

function targetElement(targetKey) {
    refreshPresenceTargetAttributes();
    const exact = document.querySelector(`[data-presence-target="${CSS.escape(targetKey)}"]`);
    if (exact) return exact;
    const parts = targetKey.split(":");
    if (parts.length > 2) {
        return document.querySelector(`[data-presence-target="${CSS.escape(parts.slice(0, 2).join(":"))}"]`);
    }
    return null;
}

function badgeHost(element) {
    const host = element.matches("input, textarea, select") ? element.closest("label") || element.parentElement : element;
    host?.classList.add("presence-badge-host");
    return host;
}

function clearDecorations() {
    document.querySelectorAll("[data-presence-decoration]").forEach((item) => item.remove());
    document.querySelectorAll(".has-collaborator-presence").forEach((item) => {
        item.classList.remove("has-collaborator-presence", "has-same-target-presence");
        item.style.removeProperty("--presence-color");
    });
    document.querySelectorAll(".presence-badge-host").forEach((item) => item.classList.remove("presence-badge-host"));
}

function presenceLabel(presence) {
    const action = presence.state === "editing" ? "está editando" : "está viendo";
    return `${presence.displayName} ${action} el viaje`;
}

function renderFloatingPresence(sessions) {
    if (!floatingPresence) return;
    floatingPresence.replaceChildren();
    floatingPresence.hidden = sessions.length === 0;
    if (!sessions.length) return;

    const shown = sessions.slice(0, 4);
    shown.forEach((presence) => {
        const chip = document.createElement("span");
        chip.className = "collaboration-presence-avatar";
        chip.style.setProperty("--presence-color", colorForUser(presence.userId));
        chip.textContent = initials(presence.displayName);
        chip.title = presenceLabel(presence);
        chip.setAttribute("aria-label", chip.title);
        floatingPresence.append(chip);
    });
    if (sessions.length > shown.length) {
        const count = document.createElement("span");
        count.className = "collaboration-presence-avatar collaboration-presence-count";
        count.textContent = `+${sessions.length - shown.length}`;
        count.setAttribute("aria-label", `${sessions.length - shown.length} sesiones conectadas más`);
        floatingPresence.append(count);
    }
}

export function renderPresenceDecorations() {
    clearDecorations();
    const remoteSessions = [...store.presenceSessions.values()].filter(
        (presence) => presence.presenceSessionId !== presenceSessionId,
    );
    renderFloatingPresence(remoteSessions);
    const groups = new Map();
    for (const presence of remoteSessions) {
        const key = presenceTargetKey(presence.target);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(presence);
    }
    let sameTargetName = null;
    for (const [key, sessions] of groups) {
        // General trip presence belongs in the floating summary. Decorating this
        // target used to outline the header and place an avatar in its corner.
        if (key === "plan:plan") continue;
        const element = targetElement(key);
        if (!element) continue;
        const host = badgeHost(element);
        const color = colorForUser(sessions[0].userId);
        element.classList.add("has-collaborator-presence");
        element.style.setProperty("--presence-color", color);
        const indicator = document.createElement("span");
        indicator.className = "presence-indicators";
        indicator.dataset.presenceDecoration = "";
        indicator.setAttribute("role", "status");
        const shown = sessions.slice(0, 3);
        shown.forEach((presence) => {
            const chip = document.createElement("span");
            chip.className = "presence-chip";
            chip.style.setProperty("--presence-color", colorForUser(presence.userId));
            chip.textContent = initials(presence.displayName);
            chip.title = `${presence.displayName} está ${presence.state === "editing" ? "editando" : "viendo"} este elemento`;
            chip.setAttribute("aria-label", chip.title);
            indicator.append(chip);
        });
        if (sessions.length > shown.length) {
            const count = document.createElement("span");
            count.className = "presence-chip presence-count";
            count.textContent = `+${sessions.length - shown.length}`;
            count.setAttribute("aria-label", `${sessions.length - shown.length} sesiones más`);
            indicator.append(count);
        }
        host.append(indicator);
        if (key === currentPresenceTarget() && sessions.some((presence) => presence.state === "editing")) {
            element.classList.add("has-same-target-presence");
            sameTargetName = sessions.find((presence) => presence.state === "editing")?.displayName;
        }
    }
    if (sameTargetName) liveRegion.textContent = `${sameTargetName} también está editando este elemento. Podéis continuar; no está bloqueado.`;
}

function highlightRemoteTarget(key, actor) {
    const element = targetElement(key);
    if (!element) return false;
    element.classList.add("remote-change-highlight");
    element.style.setProperty("--remote-change-color", colorForUser(actor?.userId || actor?.displayName || "remote"));
    element.dataset.remoteChangeBy = actor?.displayName || "Otro colaborador";
    clearTimeout(highlightTimers.get(key));
    highlightTimers.set(key, setTimeout(() => {
        element.classList.remove("remote-change-highlight");
        element.style.removeProperty("--remote-change-color");
        delete element.dataset.remoteChangeBy;
        highlightTimers.delete(key);
    }, REMOTE_HIGHLIGHT_MS));
    return true;
}

document.addEventListener("trip-presence-changed", () => requestAnimationFrame(renderPresenceDecorations));
document.addEventListener("trip-presence-local-target", () => requestAnimationFrame(renderPresenceDecorations));
document.addEventListener("planner-rendered", () => requestAnimationFrame(renderPresenceDecorations));
document.addEventListener("trip-remote-operations", (event) => {
    const applied = (event.detail?.applied || []).filter((entry) =>
        isVisuallyRemoteChange(entry, store.accountSession?.user?.id));
    if (!applied.length) return;
    const names = new Set();
    let highlighted = 0;
    applied.forEach((entry) => {
        if (entry.actor?.displayName) names.add(entry.actor.displayName);
        (entry.targetKeys || []).forEach((key) => { if (highlightRemoteTarget(key, entry.actor)) highlighted += 1; });
    });
    const who = [...names].join(", ") || "Otro colaborador";
    liveRegion.textContent = `${who} aplicó ${applied.length} cambio${applied.length === 1 ? "" : "s"}${highlighted ? "; se han resaltado en el plan" : " fuera de la vista actual"}.`;
});
