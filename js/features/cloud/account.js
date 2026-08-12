import { store } from "../../core/store.js";
import { openModal } from "../../shared/modal.js";
import { confirmAction, toast } from "../../shared/notify.js";
import {
    changeCloudPassword,
    deleteCloudAccount,
    loginCloud,
    logoutCloud,
    refreshCloudSession,
    registerCloudAccount,
    updateCloudProfile,
} from "./coordinator.js";
import { CLOUD_AVAILABILITY_COPY } from "./sync-state.js";
import { getTripRepository } from "../library/workspace.js";
import { optimizeAvatarImage } from "./avatar-image.js";

const button = document.querySelector("#accountBtn");
const menu = document.querySelector("#accountMenu");
const dialog = document.querySelector("#accountDialog");
const authTabs = [...document.querySelectorAll("[data-account-view]")];
const settingsTabs = [...document.querySelectorAll("[data-settings-view]")];
let pendingAvatar;
let avatarSelectionToken = 0;
let pendingAvatarProcessing = null;

function selectAuthView(view, { focus = false } = {}) {
    authTabs.forEach((tab) => {
        const selected = tab.dataset.accountView === view;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
    });
    document.querySelector("#accountLoginForm").hidden = view !== "login";
    document.querySelector("#accountRegisterForm").hidden = view !== "register";
}

function selectSettingsView(view, { focus = false } = {}) {
    settingsTabs.forEach((tab) => {
        const selected = tab.dataset.settingsView === view;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
    });
    document.querySelector("#accountProfilePanel").hidden = view !== "profile";
    document.querySelector("#accountDeletePanel").hidden = view !== "delete";
}

function wireTabs(tabs, select, axisKeys) {
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => select(tab.dataset.accountView || tab.dataset.settingsView));
        tab.addEventListener("keydown", (event) => {
            if (!axisKeys.includes(event.key)) return;
            event.preventDefault();
            const forward = ["ArrowRight", "ArrowDown"].includes(event.key);
            const next = tabs[(index + (forward ? 1 : -1) + tabs.length) % tabs.length];
            select(next.dataset.accountView || next.dataset.settingsView, { focus: true });
        });
    });
}

function initials(user) {
    const source = user?.displayName || user?.email || "Cuenta";
    return source.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function paintAvatar(element, user, avatar = user?.avatarDataUrl) {
    element.textContent = avatar ? "" : initials(user);
    element.style.backgroundImage = avatar ? `url("${avatar}")` : "";
    element.classList.toggle("has-photo", Boolean(avatar));
}

function closeMenu({ focus = false } = {}) {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focus) button.focus();
}

function openMenu() {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector('[role="menuitem"]')?.focus();
}

function prepareSettings() {
    const user = store.accountSession?.user;
    avatarSelectionToken += 1;
    pendingAvatarProcessing = null;
    pendingAvatar = user?.avatarDataUrl || null;
    document.querySelector("#accountDisplayName").value = user?.displayName || "";
    paintAvatar(document.querySelector("#accountPhotoPreview"), user, pendingAvatar);
    document.querySelector("#accountProfileStatus").textContent = "";
    document.querySelector("#accountPasswordStatus").textContent = "";
    selectSettingsView("profile");
}

function renderAccount() {
    const session = store.accountSession;
    const user = session?.user;
    const hasAvatar = Boolean(session && user?.avatarDataUrl);
    const accountName = user?.displayName || "Cuenta";
    const navAvatar = document.querySelector("#accountNavAvatar");
    document.querySelector("#accountSignedOut").hidden = Boolean(session);
    document.querySelector("#accountSignedIn").hidden = !session;
    button.dataset.session = session ? "active" : "local";
    button.dataset.avatar = hasAvatar ? "visible" : "hidden";
    button.querySelector(".account-label").textContent = session ? accountName : "Iniciar sesión";
    button.querySelector(".account-label").hidden = hasAvatar;
    navAvatar.hidden = !hasAvatar;
    paintAvatar(navAvatar, user);
    button.setAttribute("aria-haspopup", session ? "menu" : "dialog");
    button.setAttribute("aria-controls", session ? "accountMenu" : "accountDialog");
    button.setAttribute("aria-label", session ? `Cuenta de ${accountName}` : "Iniciar sesión");
    button.title = session ? `Cuenta · ${user?.email || "sesión iniciada"}` : "Iniciar sesión o crear una cuenta";
    document.querySelector("#accountMenuName").textContent = user?.displayName || "Mi cuenta";
    document.querySelector("#accountMenuEmail").textContent = user?.email || "";
    document.querySelector("#accountSettingsName").textContent = user?.displayName || "Mi cuenta";
    document.querySelector("#accountEmailValue").textContent = user?.email || "";
    ["#accountMenuAvatar", "#accountSettingsAvatar"].forEach((selector) => paintAvatar(document.querySelector(selector), user));
    const availability = document.querySelector("#cloudAvailabilityStatus");
    availability.hidden = store.cloudAvailability === "available";
    availability.textContent = CLOUD_AVAILABILITY_COPY[store.cloudAvailability] || "";
    if (!session) closeMenu();
}

function openAccountDialog() {
    renderAccount();
    if (store.accountSession) prepareSettings();
    openModal(dialog);
    if (store.cloudAvailability === "unavailable") refreshCloudSession();
}

function authError(error, fallback) {
    return error?.message || fallback;
}

wireTabs(authTabs, selectAuthView, ["ArrowLeft", "ArrowRight"]);
wireTabs(settingsTabs, selectSettingsView, ["ArrowUp", "ArrowDown"]);

button.addEventListener("click", () => {
    if (!store.accountSession) {
        openAccountDialog();
        return;
    }
    menu.hidden ? openMenu() : closeMenu();
});

document.querySelector("#accountSettingsBtn").addEventListener("click", () => {
    closeMenu();
    openAccountDialog();
});

document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !document.querySelector("#accountControl").contains(event.target)) closeMenu();
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) closeMenu({ focus: true });
});

document.querySelector("#accountRegisterForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.querySelector("#accountAuthStatus");
    status.textContent = "Creando cuenta…";
    try {
        await registerCloudAccount(document.querySelector("#accountRegisterEmail").value, document.querySelector("#accountRegisterPassword").value);
        form.reset();
        dialog.close();
        toast("Cuenta creada. Ya has iniciado sesión.", "success");
    } catch (error) {
        status.textContent = authError(error, "No se pudo crear la cuenta. El modo local sigue disponible.");
    }
});

document.querySelector("#accountLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.querySelector("#accountAuthStatus");
    status.textContent = "Iniciando sesión…";
    try {
        await loginCloud(document.querySelector("#accountLoginEmail").value, document.querySelector("#accountLoginPassword").value);
        form.reset();
        dialog.close();
        toast("Sesión iniciada.", "success");
    } catch (error) {
        status.textContent = authError(error, "No se pudo iniciar sesión. El modo local sigue disponible.");
    }
});

document.querySelector("#accountPhotoInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const status = document.querySelector("#accountProfileStatus");
    const token = ++avatarSelectionToken;
    status.textContent = file.size > 500_000 ? "Optimizando foto…" : "Procesando foto…";
    const processing = optimizeAvatarImage(file)
        .then((avatar) => {
            if (token !== avatarSelectionToken) return;
            pendingAvatar = avatar;
            paintAvatar(document.querySelector("#accountPhotoPreview"), store.accountSession?.user, pendingAvatar);
            status.textContent = file.size > 500_000 ? "Foto optimizada. Lista para guardar." : "";
        })
        .catch((error) => {
            if (token !== avatarSelectionToken) return;
            status.textContent = error?.message || "No se pudo procesar la imagen.";
            event.target.value = "";
        })
        .finally(() => {
            if (pendingAvatarProcessing === processing) pendingAvatarProcessing = null;
        });
    pendingAvatarProcessing = processing;
});

document.querySelector("#accountPhotoRemove").addEventListener("click", () => {
    avatarSelectionToken += 1;
    pendingAvatarProcessing = null;
    pendingAvatar = null;
    document.querySelector("#accountPhotoInput").value = "";
    paintAvatar(document.querySelector("#accountPhotoPreview"), store.accountSession?.user, null);
});

document.querySelector("#accountProfileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.querySelector("#accountProfileStatus");
    try {
        if (pendingAvatarProcessing) {
            status.textContent = "Terminando de optimizar la foto…";
            await pendingAvatarProcessing;
        }
        status.textContent = "Guardando perfil…";
        await updateCloudProfile({ displayName: document.querySelector("#accountDisplayName").value, avatarDataUrl: pendingAvatar });
        status.textContent = "Perfil actualizado.";
        renderAccount();
    } catch (error) {
        status.textContent = authError(error, "No se pudo actualizar el perfil.");
    }
});

document.querySelector("#accountPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.querySelector("#accountPasswordStatus");
    const nextPassword = document.querySelector("#accountNewPassword").value;
    if (nextPassword !== document.querySelector("#accountNewPasswordRepeat").value) {
        status.textContent = "Las nuevas contraseñas no coinciden.";
        return;
    }
    status.textContent = "Actualizando contraseña…";
    try {
        await changeCloudPassword(document.querySelector("#accountCurrentPassword").value, nextPassword);
        form.reset();
        status.textContent = "Contraseña actualizada.";
    } catch (error) {
        status.textContent = authError(error, "No se pudo actualizar la contraseña.");
    }
});

document.querySelector("#accountLogoutBtn").addEventListener("click", async () => {
    closeMenu();
    const pending = await getTripRepository().listOutbox();
    let preservePending = false;
    if (pending.length) {
        const ok = await confirmAction({
            title: "Cambios pendientes",
            message: "Hay cambios que todavía no llegaron a la nube. Si cierras sesión, crearemos copias locales para conservarlos.",
            confirmLabel: "Conservar copias y salir",
        });
        if (!ok) return;
        preservePending = true;
    }
    try {
        await logoutCloud({ preservePending });
        toast("Sesión cerrada. Tus copias locales siguen disponibles.", "info");
    } catch {
        toast("No se pudo cerrar la sesión remota. Inténtalo de nuevo con conexión.", "error");
    }
});

document.querySelector("#accountDeleteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = document.querySelector("#accountDeletePassword").value;
    const ok = await confirmAction({
        title: "Eliminar cuenta",
        message: "Se borrarán definitivamente tu cuenta y todos sus viajes remotos. Las copias de este dispositivo se conservarán como viajes locales.",
        confirmLabel: "Eliminar definitivamente",
        danger: true,
    });
    if (!ok) return;
    const status = document.querySelector("#accountDeleteStatus");
    status.textContent = "Eliminando cuenta…";
    try {
        await deleteCloudAccount(password);
        form.reset();
        dialog.close();
        toast("Cuenta eliminada. Tus viajes de este dispositivo siguen guardados localmente.", "info");
    } catch (error) {
        status.textContent = authError(error, "No se pudo eliminar la cuenta.");
    }
});

document.addEventListener("cloud-session-changed", renderAccount);
selectAuthView("login");
selectSettingsView("profile");
renderAccount();
