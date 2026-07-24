import { esc } from "../../shared/dom.js";
import { serializePlan } from "../../core/plan-json.js?v=35";
import { applyImportedPlan } from "../planner/import-plan.js?v=1";
import { toast } from "../../shared/notify.js?v=3";
import { buildProposedPlan } from "./proposal.js?v=3";

export { buildProposedPlan };

const CONFIG_KEY = "trip-planner-llm-config";
const API_KEY = "trip-planner-llm-api-key";
const HISTORY_LIMIT = 8;

const PROVIDERS = {
    lmstudio: {
        label: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        modelPlaceholder: "Se detectará automáticamente",
    },
    openai: {
        label: "OpenAI compatible",
        baseUrl: "https://api.openai.com/v1",
        modelPlaceholder: "Ej. gpt-4.1-mini",
    },
    anthropic: {
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        modelPlaceholder: "Ej. claude-sonnet-4-20250514",
    },
};

let history = [];
let busy = false;
let initialized = false;
let activeRequestController = null;
let closeAnimationTimer = null;

function loadConfig() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    } catch {
        // A malformed integration preference must not prevent the planner loading.
    }
    const provider = PROVIDERS[saved.provider] ? saved.provider : "lmstudio";
    return {
        provider,
        baseUrl:
            typeof saved.baseUrl === "string" && saved.baseUrl.trim()
                ? saved.baseUrl.trim().replace(/\/+$/, "")
                : PROVIDERS[provider].baseUrl,
        model: typeof saved.model === "string" ? saved.model.trim() : "",
    };
}

function readFormConfig() {
    const provider = document.querySelector("#llmProvider").value;
    const fallback = PROVIDERS[provider] || PROVIDERS.lmstudio;
    return {
        provider,
        baseUrl:
            document.querySelector("#llmBaseUrl").value.trim().replace(/\/+$/, "") ||
            fallback.baseUrl,
        model: document.querySelector("#llmModel").value.trim(),
        apiKey: document.querySelector("#llmApiKey").value.trim(),
    };
}

function persistConfig(config) {
    localStorage.setItem(
        CONFIG_KEY,
        JSON.stringify({
            provider: config.provider,
            baseUrl: config.baseUrl,
            model: config.model,
        }),
    );
    if (config.apiKey) sessionStorage.setItem(API_KEY, config.apiKey);
    else sessionStorage.removeItem(API_KEY);
}

function replaceModelOptions(select, models, selectedModel, placeholderText) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = placeholderText;

    const availableModels = [...new Set(models)];
    if (selectedModel && !availableModels.includes(selectedModel)) {
        availableModels.unshift(selectedModel);
    }

    const options = availableModels.map((model) => {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        return option;
    });
    select.replaceChildren(placeholder, ...options);
    select.value = selectedModel;
}

function fillModelSelect(models = [], selectedModel = "") {
    replaceModelOptions(
        document.querySelector("#llmModel"),
        models,
        selectedModel,
        "Prueba la conexión para cargar los modelos",
    );
    replaceModelOptions(
        document.querySelector("#llmHeaderModel"),
        models,
        selectedModel,
        "Modelo automático",
    );
}

function fillConfigForm() {
    const config = loadConfig();
    document.querySelector("#llmProvider").value = config.provider;
    document.querySelector("#llmBaseUrl").value = config.baseUrl;
    fillModelSelect([], config.model);
    document.querySelector("#llmApiKey").value = sessionStorage.getItem(API_KEY) || "";
    updateConnectionLabel(config);
}

function updateConnectionLabel(config = loadConfig()) {
    const provider = PROVIDERS[config.provider]?.label || "LLM";
    document.querySelector("#llmChatConnection").textContent = config.model
        ? `${provider} · ${config.model}`
        : `${provider} · modelo automático`;
}

function providerHeaders(config, { json = true } = {}) {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    if (config.provider === "anthropic") {
        if (config.apiKey) headers["x-api-key"] = config.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        // Anthropic requires an explicit acknowledgement for direct browser use.
        headers["anthropic-dangerous-direct-browser-access"] = "true";
    } else if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return headers;
}

async function fetchResponse(url, options) {
    let response;
    try {
        response = await fetch(url, options);
    } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error(
            `No se pudo conectar con ${url}. Comprueba la URL, que el servidor esté activo y que permita CORS. ${error.message}`,
        );
    }
    if (!response.ok) {
        const details = (await response.text()).slice(0, 700);
        throw new Error(`El servidor respondió ${response.status}: ${details || response.statusText}`);
    }
    return response;
}

async function fetchJson(url, options) {
    const response = await fetchResponse(url, options);
    try {
        return await response.json();
    } catch {
        throw new Error("El servidor respondió, pero no devolvió JSON válido.");
    }
}

async function listModels(config, { signal } = {}) {
    const result = await fetchJson(`${config.baseUrl}/models`, {
        headers: providerHeaders(config, { json: false }),
        signal,
    });
    const models = Array.isArray(result.data)
        ? result.data.map((item) => item?.id).filter((value) => typeof value === "string")
        : [];
    if (!models.length) throw new Error("La conexión funciona, pero no hay modelos disponibles.");
    return models;
}

const SYSTEM_PROMPT = `Eres el asistente de un planificador de viajes en español.
Recibirás el planning actual con identificadores internos y la petición del usuario.
Puedes analizarlo, recomendar mejoras y proponer cambios. Nunca afirmes que un cambio ya se ha aplicado.
No inventes identificadores para elementos existentes: copia exactamente los IDs del planning.
Si añades un día o parada, usa un tempId corto y único; la aplicación generará el ID real.
Devuelve SIEMPRE un único objeto JSON válido, sin Markdown, con esta forma:
{"reply":"respuesta breve para el usuario","actions":[]}

Las acciones admitidas son:
- {"type":"set_trip","title?":string,"notes?":string,"routeProfile?":"walking"|"driving"|"cycling","routeVisualization?":"straight"|"streets"}
- {"type":"add_day","tempId":string,"date":"YYYY-MM-DD","title":string,"at?":number}
- {"type":"update_day","dayId":string,"date?":"YYYY-MM-DD","title?":string}
- {"type":"delete_day","dayId":string} (sus paradas pasan a ideas pendientes)
- {"type":"reorder_days","dayIds":string[]} (debe contener todos los días una vez)
- {"type":"add_spot","tempId":string,"dayId":string|"backlog","at?":number,"spot":{"name":string,"kind?":"activity"|"waypoint","address?":string,"note?":string,"tags?":string[],"category?":string,"lat?":number,"lng?":number,"cost?":number,"openingTime?":"HH:MM","closingTime?":"HH:MM","plannedStart?":"HH:MM","visitMinutes?":number,"mapEnabled?":boolean,"optional?":boolean,"fixedStart?":boolean,"scheduleNotApplicable?":boolean}}
- {"type":"update_spot","spotId":string,"patch":{los mismos campos editables de spot}}
- {"type":"move_spot","spotId":string,"dayId":string|"backlog","at?":number}
- {"type":"delete_spot","spotId":string}
- {"type":"set_travel_leg","fromId":string,"toId":string,"leg":{"mode":"walking"|"driving"|"cycling"|"bus"|"train"|"metro"|"ferry"|"flight"|"other","durationMinutes?":number,"departureTime?":"HH:MM","fixedDeparture?":boolean,"line?":string,"note?":string,"cost?":number,"embeddedEndpoints?":["from"|"to"]}}
- {"type":"delete_travel_leg","fromId":string,"toId":string}
- {"type":"set_tags","tags":string[]}

Para conversar o recomendar, devuelve actions vacío. Agrupa todos los cambios pedidos en una sola respuesta. No cambies datos que el usuario no haya pedido. Si faltan datos esenciales, pregunta en reply y no propongas acciones.`;

function conversationMessages(message, planning) {
    const recent = history.slice(-HISTORY_LIMIT).map((item) => ({
        role: item.role,
        content: item.content,
    }));
    return [
        ...recent,
        {
            role: "user",
            content: JSON.stringify({ request: message, planning }),
        },
    ];
}

async function resolveModel(config, signal) {
    if (config.model) return config.model;
    if (config.provider !== "lmstudio") {
        throw new Error("Indica un modelo en la configuración antes de enviar mensajes.");
    }
    const models = await listModels(config, { signal });
    return models[0];
}

async function readSse(response, onEvent) {
    if (!response.body) throw new Error("El servidor no permite leer la respuesta progresivamente.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (final = false) => {
        while (buffer) {
            const boundary = buffer.match(/\r?\n\r?\n/);
            if (!boundary) {
                if (!final) return;
                if (!buffer.trim()) return;
            }
            const end = boundary ? boundary.index : buffer.length;
            const block = buffer.slice(0, end);
            buffer = boundary ? buffer.slice(end + boundary[0].length) : "";
            let event = "message";
            const data = [];
            for (const line of block.split(/\r?\n/)) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            if (data.length) onEvent({ event, data: data.join("\n") });
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        consume();
    }
    buffer += decoder.decode();
    consume(true);
}

function openAiText(result) {
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
        throw new Error("El modelo no devolvió contenido de texto.");
    }
    return content;
}

function anthropicText(result) {
    const text = Array.isArray(result.content)
        ? result.content
              .filter((block) => block?.type === "text")
              .map((block) => block.text)
              .join("\n")
        : "";
    if (!text) throw new Error("El modelo no devolvió contenido de texto.");
    return text;
}

async function askModel(message, planning, onChunk, signal) {
    const stored = loadConfig();
    const config = { ...stored, apiKey: sessionStorage.getItem(API_KEY) || "" };
    const model = await resolveModel(config, signal);
    let response;

    if (config.provider === "anthropic") {
        response = await fetchResponse(`${config.baseUrl}/messages`, {
            method: "POST",
            headers: providerHeaders(config),
            signal,
            body: JSON.stringify({
                model,
                system: SYSTEM_PROMPT,
                messages: conversationMessages(message, planning),
                max_tokens: 120000,
                temperature: 0.2,
                stream: true,
            }),
        });
        if (response.headers.get("content-type")?.includes("application/json")) {
            return anthropicText(await response.json());
        }
        let content = "";
        await readSse(response, ({ data }) => {
            if (data === "[DONE]") return;
            let event;
            try {
                event = JSON.parse(data);
            } catch {
                return;
            }
            if (event.type === "error") {
                throw new Error(event.error?.message || "El stream de Anthropic devolvió un error.");
            }
            if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") return;
            const delta = event.delta.text || "";
            content += delta;
            if (delta) onChunk(content, delta);
        });
        if (!content.trim()) throw new Error("El modelo no devolvió contenido de texto.");
        return content;
    }

    response = await fetchResponse(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: providerHeaders(config),
        signal,
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                ...conversationMessages(message, planning),
            ],
            temperature: 0.2,
            stream: true,
        }),
    });
    if (response.headers.get("content-type")?.includes("application/json")) {
        return openAiText(await response.json());
    }
    let content = "";
    await readSse(response, ({ data }) => {
        if (data === "[DONE]") return;
        let event;
        try {
            event = JSON.parse(data);
        } catch {
            return;
        }
        if (event.error) throw new Error(event.error.message || "El stream del modelo devolvió un error.");
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta !== "string" || !delta) return;
        content += delta;
        onChunk(content, delta);
    });
    if (!content.trim()) throw new Error("El modelo no devolvió contenido de texto.");
    return content;
}

export function extractPartialReply(content) {
    const source = String(content || "");
    const match = /"reply"\s*:\s*"/.exec(source);
    if (!match) return null;
    let result = "";
    for (let index = match.index + match[0].length; index < source.length; index += 1) {
        const char = source[index];
        if (char === '"') return result;
        if (char !== "\\") {
            result += char;
            continue;
        }
        const escaped = source[index + 1];
        if (escaped === undefined) return result;
        if (escaped === "u") {
            const hex = source.slice(index + 2, index + 6);
            if (!/^[0-9a-f]{4}$/i.test(hex)) return result;
            result += String.fromCharCode(Number.parseInt(hex, 16));
            index += 5;
            continue;
        }
        const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        result += Object.hasOwn(escapes, escaped) ? escapes[escaped] : escaped;
        index += 1;
    }
    return result;
}

export function parseAssistantEnvelope(content) {
    const trimmed = String(content || "").trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const source = fenced ? fenced[1] : trimmed;
    try {
        const parsed = JSON.parse(source);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        return {
            reply:
                typeof parsed.reply === "string" && parsed.reply.trim()
                    ? parsed.reply.trim()
                    : "He preparado una propuesta.",
            actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        };
    } catch {
        return { reply: trimmed || "El modelo no devolvió una respuesta.", actions: [] };
    }
}

function inlineMarkdown(value) {
    const codeSpans = [];
    let html = esc(value).replace(/`([^`\n]+)`/g, (_, code) => {
        const index = codeSpans.push(`<code>${code}</code>`) - 1;
        return `\u0000${index}\u0000`;
    });
    html = html.replace(
        /\[([^\]]+)]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return html.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
}

export function markdownToHtml(source) {
    const lines = String(source).replace(/\r/g, "").split("\n");
    const output = [];
    let list = null;
    const closeList = () => {
        if (list) output.push(`</${list}>`);
        list = null;
    };

    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        const fence = line.match(/^\s*```([\w-]*)\s*$/);
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);

        if (fence) {
            closeList();
            const code = [];
            index += 1;
            while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
                code.push(lines[index]);
                index += 1;
            }
            if (index < lines.length) index += 1;
            const language = fence[1] ? ` class="language-${fence[1]}"` : "";
            output.push(`<pre><code${language}>${esc(code.join("\n"))}</code></pre>`);
            continue;
        }
        if (heading) {
            closeList();
            const level = heading[1].length;
            output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
            index += 1;
            continue;
        }
        if (bullet || ordered) {
            const type = bullet ? "ul" : "ol";
            if (list !== type) {
                closeList();
                output.push(`<${type}>`);
                list = type;
            }
            output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
            index += 1;
            continue;
        }

        closeList();
        if (!line.trim()) {
            index += 1;
            continue;
        }
        if (/^>\s?/.test(line)) {
            const quote = [];
            while (index < lines.length && /^>\s?/.test(lines[index])) {
                quote.push(lines[index].replace(/^>\s?/, ""));
                index += 1;
            }
            output.push(`<blockquote>${inlineMarkdown(quote.join(" "))}</blockquote>`);
            continue;
        }

        const paragraph = [line];
        index += 1;
        while (
            index < lines.length &&
            lines[index].trim() &&
            !/^\s*```/.test(lines[index]) &&
            !/^(#{1,4})\s+/.test(lines[index]) &&
            !/^\s*[-*+]\s+/.test(lines[index]) &&
            !/^\s*\d+[.)]\s+/.test(lines[index]) &&
            !/^>\s?/.test(lines[index])
        ) {
            paragraph.push(lines[index]);
            index += 1;
        }
        output.push(`<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
    closeList();
    return output.join("");
}

function renderMessageBody(body, role, text) {
    if (role === "assistant") body.innerHTML = markdownToHtml(text);
    else body.textContent = text;
}

function addMessage(role, text) {
    const messages = document.querySelector("#llmChatMessages");
    const item = document.createElement("article");
    item.className = "llm-message";
    item.dataset.role = role;
    const body = document.createElement("div");
    body.className = "llm-message-body";
    renderMessageBody(body, role, text);
    item.append(body);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    return item;
}

function updateMessage(messageEl, text) {
    renderMessageBody(
        messageEl.querySelector(".llm-message-body"),
        messageEl.dataset.role,
        text,
    );
    const messages = document.querySelector("#llmChatMessages");
    messages.scrollTop = messages.scrollHeight;
}

function resetConversation() {
    activeRequestController?.abort();
    history = [];
    const messages = document.querySelector("#llmChatMessages");
    messages.replaceChildren();
    addMessage(
        "assistant",
        "Conversación reiniciada. Ya tengo el planning actual como contexto. ¿Qué quieres revisar o cambiar?",
    );
    document.querySelector("#llmChatInput").value = "";
    document.querySelector("#llmChatInput").focus();
}

function addActionCard(messageEl, proposal, fingerprint) {
    const card = document.createElement("div");
    card.className = "llm-action-card";
    const title = document.createElement("strong");
    title.textContent = `${proposal.summaries.length} ${proposal.summaries.length === 1 ? "cambio propuesto" : "cambios propuestos"}`;
    const list = document.createElement("ul");
    list.className = "llm-action-list";
    proposal.summaries.forEach((summary) => {
        const item = document.createElement("li");
        item.textContent = summary;
        list.append(item);
    });
    const buttons = document.createElement("div");
    buttons.className = "llm-action-buttons";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "llm-apply";
    apply.textContent = "Aplicar cambios";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Descartar";
    buttons.append(apply, discard);
    card.append(title, list, buttons);
    messageEl.append(card);

    const finish = (label) => {
        apply.disabled = true;
        discard.disabled = true;
        title.textContent = label;
    };
    apply.addEventListener("click", () => {
        const currentFingerprint = JSON.stringify(serializePlan({ exportedAt: false }));
        if (currentFingerprint !== fingerprint) {
            finish("Propuesta caducada");
            addMessage("system", "El planning cambió después de esta propuesta. Vuelve a pedírmela para no sobrescribir cambios recientes.");
            return;
        }
        applyImportedPlan(proposal.plan);
        finish("Cambios aplicados");
        toast("Cambios del asistente aplicados.", "success");
    });
    discard.addEventListener("click", () => finish("Propuesta descartada"));
}

function setBusy(value) {
    busy = value;
    document.querySelector("#llmChatSend").disabled = value;
    document.querySelector("#llmChatInput").disabled = value;
    document.querySelector("#llmChatTyping").hidden = !value;
}

function openChat() {
    const root = document.querySelector("#llmChat");
    const panel = document.querySelector("#llmChatPanel");
    clearTimeout(closeAnimationTimer);
    panel.classList.remove("is-closing");
    root.dataset.open = "true";
    panel.hidden = false;
    document.querySelector("#llmChatLauncher").setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => document.querySelector("#llmChatInput").focus());
}

function closeChat() {
    const root = document.querySelector("#llmChat");
    const panel = document.querySelector("#llmChatPanel");
    const launcher = document.querySelector("#llmChatLauncher");
    let finished = false;
    const onAnimationEnd = (event) => {
        if (event.target === panel) finishClose();
    };
    const finishClose = () => {
        if (finished) return;
        finished = true;
        clearTimeout(closeAnimationTimer);
        closeAnimationTimer = null;
        panel.removeEventListener("animationend", onAnimationEnd);
        panel.classList.remove("is-closing");
        panel.hidden = true;
        root.dataset.open = "false";
        launcher.focus();
    };

    launcher.setAttribute("aria-expanded", "false");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        finishClose();
        return;
    }

    panel.classList.add("is-closing");
    panel.addEventListener("animationend", onAnimationEnd);
    closeAnimationTimer = setTimeout(finishClose, 470);
}

async function sendMessage(message) {
    if (busy) return;
    const planning = serializePlan({ exportedAt: false });
    const fingerprint = JSON.stringify(planning);
    addMessage("user", message);
    const responseEl = addMessage("assistant", "");
    responseEl.classList.add("is-streaming");
    const controller = new AbortController();
    activeRequestController = controller;
    setBusy(true);
    let hasVisibleChunk = false;
    try {
        const raw = await askModel(message, planning, (content) => {
            const partialReply = extractPartialReply(content);
            if (partialReply === null) return;
            updateMessage(responseEl, partialReply);
            if (!hasVisibleChunk) {
                hasVisibleChunk = true;
                document.querySelector("#llmChatTyping").hidden = true;
            }
        }, controller.signal);
        const envelope = parseAssistantEnvelope(raw);
        updateMessage(responseEl, envelope.reply);
        responseEl.classList.remove("is-streaming");
        history.push(
            { role: "user", content: message },
            { role: "assistant", content: JSON.stringify(envelope) },
        );
        history = history.slice(-HISTORY_LIMIT);
        if (envelope.actions.length) {
            try {
                const proposal = buildProposedPlan(planning, envelope.actions);
                addActionCard(responseEl, proposal, fingerprint);
            } catch (error) {
                addMessage("system", `No se puede aplicar la propuesta: ${error.message}`);
            }
        }
    } catch (error) {
        responseEl.classList.remove("is-streaming");
        if (!responseEl.querySelector(".llm-message-body").textContent) responseEl.remove();
        if (error.name === "AbortError") return;
        addMessage("system", error.message);
    } finally {
        if (activeRequestController === controller) activeRequestController = null;
        setBusy(false);
        document.querySelector("#llmChatInput").focus();
    }
}

function syncProviderDefaults({ force = false } = {}) {
    const provider = document.querySelector("#llmProvider").value;
    const input = document.querySelector("#llmBaseUrl");
    const knownDefault = Object.values(PROVIDERS).some((item) => item.baseUrl === input.value);
    if (force || !input.value || knownDefault) input.value = PROVIDERS[provider].baseUrl;
    fillModelSelect();
}

async function testConnection() {
    const status = document.querySelector("#llmTestStatus");
    const button = document.querySelector("#llmTestBtn");
    const config = readFormConfig();
    button.disabled = true;
    status.dataset.state = "";
    status.textContent = "Conectando…";
    try {
        const models = await listModels(config);
        const selectedModel = models.includes(config.model) ? config.model : models[0];
        fillModelSelect(models, selectedModel);
        status.dataset.state = "ok";
        status.textContent = `Conexión correcta · ${models.length} ${models.length === 1 ? "modelo" : "modelos"}`;
    } catch (error) {
        status.dataset.state = "error";
        status.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

export function initLlmChat() {
    if (initialized) return;
    initialized = true;
    fillConfigForm();
    addMessage(
        "assistant",
        "Puedo analizar tu itinerario y proponer cambios: mover paradas, editar días, actualizar notas o reorganizar el viaje. Configura tu servidor con ⚙ para empezar.",
    );

    document.querySelector("#llmChatLauncher").addEventListener("click", openChat);
    document.querySelector("#llmChatClose").addEventListener("click", closeChat);
    document.querySelector("#llmChatReset").addEventListener("click", resetConversation);
    document.querySelector("#llmChatSettingsBtn").addEventListener("click", () => {
        const settings = document.querySelector("#llmChatSettings");
        settings.hidden = !settings.hidden;
        if (!settings.hidden) document.querySelector("#llmProvider").focus();
    });
    document.querySelector("#llmProvider").addEventListener("change", () => syncProviderDefaults({ force: true }));
    document.querySelector("#llmModel").addEventListener("change", (event) => {
        document.querySelector("#llmHeaderModel").value = event.currentTarget.value;
    });
    document.querySelector("#llmHeaderModel").addEventListener("change", (event) => {
        const model = event.currentTarget.value;
        document.querySelector("#llmModel").value = model;
        const config = readFormConfig();
        persistConfig(config);
        updateConnectionLabel(config);
        toast(model ? `Modelo cambiado a ${model}.` : "Selección automática de modelo activada.", "success");
    });
    document.querySelector("#llmTestBtn").addEventListener("click", testConnection);
    document.querySelector("#llmSaveBtn").addEventListener("click", () => {
        const config = readFormConfig();
        persistConfig(config);
        updateConnectionLabel(config);
        document.querySelector("#llmChatSettings").hidden = true;
        toast("Configuración del asistente guardada.", "success");
    });
    const form = document.querySelector("#llmChatForm");
    const input = document.querySelector("#llmChatInput");
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message) return;
        input.value = "";
        input.style.height = "";
        sendMessage(message);
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            form.requestSubmit();
        }
    });
    input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
    });
}
