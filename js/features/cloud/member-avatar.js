export const MEMBER_ROLE_LABEL = {
    owner: "Propietario",
    editor: "Puede editar",
    viewer: "Solo lectura",
};

export function memberInitials(displayName) {
    const words = String(displayName || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return [...words[0]].slice(0, 2).join("").toUpperCase();
    return `${[...words[0]][0]}${[...words.at(-1)][0]}`.toUpperCase();
}

// A stable hue per account, derived on the client: the same person keeps the
// same colour on every card without the server sending a palette, and without
// downloading avatars into a list that can hold hundreds of trips.
export function memberHue(userId) {
    let hash = 0;
    for (const character of String(userId || "")) hash = (hash * 31 + character.codePointAt(0)) % 360;
    return hash;
}

export function memberAvatar(member, { photo = null } = {}) {
    const element = document.createElement("span");
    element.className = "member-avatar";
    element.dataset.role = member.role;
    element.title = `${member.displayName} · ${MEMBER_ROLE_LABEL[member.role] || member.role}`;
    if (photo) {
        const image = document.createElement("img");
        image.src = photo;
        image.alt = "";
        element.append(image);
    } else {
        element.style.setProperty("--member-hue", String(memberHue(member.userId)));
        element.textContent = memberInitials(member.displayName);
    }
    return element;
}
