import {
    canonicalPair,
    deriveImagePrompt,
    parseDiscoveryPayload,
} from "./game.js";

export const API_BASE = "https://gen.pollinations.ai";
export const REQUEST_TIMEOUT_MS = 45_000;
export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const SECRET_KEY_PATTERN = /^sk_[^\s]{8,177}$/u;
export const TEXT_MODELS = Object.freeze([
    { id: "openai-fast", label: "GPT-5 Nano" },
    { id: "openai", label: "GPT-5.4 Nano" },
    { id: "claude-fast", label: "Claude Fast" },
    { id: "gemini-fast", label: "Gemini Fast" },
    { id: "deepseek", label: "DeepSeek" },
    { id: "mistral-small-3.2", label: "Mistral Small 3.2" },
]);
export const DEFAULT_TEXT_MODEL = TEXT_MODELS[0].id;
const TEXT_MODEL_IDS = new Set(TEXT_MODELS.map(({ id }) => id));
const MAX_PROMPT_LENGTH = 1_400;
const DISCOVERY_RESPONSE_FORMAT = {
    type: "json_schema",
    json_schema: {
        name: "pollen_craft_discovery",
        strict: true,
        schema: {
            type: "object",
            properties: {
                name: { type: "string" },
                description: { type: "string" },
            },
            required: ["name", "description"],
            additionalProperties: false,
        },
    },
};

export class ApiError extends Error {
    constructor(message, kind = "network", status = 0) {
        super(message);
        this.name = "ApiError";
        this.kind = kind;
        this.status = status;
    }
}

export function isSecretKey(key) {
    return typeof key === "string" && SECRET_KEY_PATTERN.test(key.trim());
}

export function isTextModel(model) {
    return typeof model === "string" && TEXT_MODEL_IDS.has(model);
}

function requireKey(key) {
    const token = typeof key === "string" ? key.trim() : "";
    if (!isSecretKey(token))
        throw new ApiError(
            "Use a Pollinations sk_ Secret Key to power the lab.",
            "auth",
        );
    return token;
}

function requireTextModel(model) {
    if (!isTextModel(model))
        throw new ApiError("Choose a supported text model.", "model");
    return model;
}

async function fetchWithTimeout(fetchImpl, url, options, consume, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(
                new ApiError("The lab took too long. Try again.", "timeout"),
            );
        }, timeoutMs);
    });
    const request = (async () => {
        const response = await fetchImpl(url, {
            ...options,
            signal: controller.signal,
        });
        return consume(response);
    })();
    try {
        return await Promise.race([request, timeout]);
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (timedOut || error?.name === "AbortError")
            throw new ApiError("The lab took too long. Try again.", "timeout");
        throw new ApiError(
            "The lab could not connect. Check your connection and try again.",
            "network",
        );
    } finally {
        clearTimeout(timer);
    }
}

async function ensureOk(response, stage) {
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403)
        throw new ApiError(
            "That key was not accepted. Check it and try again.",
            "auth",
            response.status,
        );
    if (response.status === 429)
        throw new ApiError(
            "The lab is busy. Wait a moment and try again.",
            "rate",
            response.status,
        );
    throw new ApiError(
        `${stage === "image" ? "The illustration" : "The idea"} could not be generated (${response.status}).`,
        "http",
        response.status,
    );
}

async function readBoundedBytes(response, limit) {
    const reader = response.body?.getReader?.();
    if (!reader) {
        const length = Number(response.headers?.get?.("content-length"));
        if (Number.isFinite(length) && length > limit)
            throw new ApiError(
                "The response was too large. Try again.",
                "parse",
            );
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit)
            throw new ApiError(
                "The response was too large. Try again.",
                "parse",
            );
        return bytes;
    }
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw new ApiError(
                "The response was too large. Try again.",
                "parse",
            );
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function combinationPrompt(pair) {
    const first = pair.first.description
        ? `${pair.first.name}: ${pair.first.description}`
        : pair.first.name;
    const second = pair.second.description
        ? `${pair.second.name}: ${pair.second.description}`
        : pair.second.name;
    return `Combine these two ingredients into one surprising, family-friendly craft discovery. Return only strict JSON with exactly two string fields: name (1-4 words) and description (one vivid sentence, 12-28 words). Do not use markdown or HTML. Ingredients: ${first}; ${second}.`.slice(
        0,
        MAX_PROMPT_LENGTH,
    );
}

export function createApiClient(fetchImpl = globalThis.fetch, options = {}) {
    const inFlight = new Map();
    const inFlightImages = new Map();
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    async function discoverText(pair, key, model = DEFAULT_TEXT_MODEL) {
        const token = requireKey(key);
        const modelId = requireTextModel(model);
        const pairKey = canonicalPair(pair.first.id, pair.second.id);
        let credentials = inFlight.get(pairKey);
        if (!credentials) {
            credentials = new Map();
            inFlight.set(pairKey, credentials);
        }
        const requestKey = `${token}\u0000${modelId}`;
        if (credentials.has(requestKey)) return credentials.get(requestKey);
        const request = fetchWithTimeout(
            fetchImpl,
            `${API_BASE}/v1/chat/completions`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: [
                        { role: "user", content: combinationPrompt(pair) },
                    ],
                    max_tokens: 2048,
                    ...(modelId === "openai-fast"
                        ? { reasoning_effort: "minimal" }
                        : {}),
                    response_format:
                        modelId === "openai-fast" || modelId === "openai"
                            ? DISCOVERY_RESPONSE_FORMAT
                            : { type: "json_object" },
                }),
            },
            async (response) => {
                await ensureOk(response, "text");
                let payload;
                try {
                    payload = JSON.parse(
                        new TextDecoder().decode(
                            await readBoundedBytes(response, MAX_JSON_BYTES),
                        ),
                    );
                } catch (error) {
                    if (error instanceof ApiError) throw error;
                    throw new ApiError(
                        "The lab returned unreadable text.",
                        "parse",
                    );
                }
                const choice = payload?.choices?.[0];
                if (choice?.finish_reason === "length")
                    throw new ApiError(
                        "The idea response was cut off. Retry the idea.",
                        "parse",
                    );
                const content = choice?.message?.content;
                if (typeof content !== "string")
                    throw new ApiError("The lab returned no idea.", "parse");
                try {
                    return parseDiscoveryPayload(JSON.parse(content));
                } catch (error) {
                    if (
                        error.message.includes("invalid") ||
                        error.message.includes("incomplete") ||
                        error.message.includes("unusable")
                    )
                        throw error;
                    throw new ApiError(
                        "The lab returned malformed JSON. Retry the idea.",
                        "parse",
                    );
                }
            },
            timeoutMs,
        );
        credentials.set(requestKey, request);
        try {
            return await request;
        } finally {
            credentials.delete(requestKey);
            if (credentials.size === 0) inFlight.delete(pairKey);
        }
    }
    async function generateImage(discovery, key) {
        const token = requireKey(key);
        const imageKey = `${discovery.name}\u0000${discovery.description}\u0000${token}`;
        if (inFlightImages.has(imageKey)) return inFlightImages.get(imageKey);
        const prompt = encodeURIComponent(deriveImagePrompt(discovery));
        const request = fetchWithTimeout(
            fetchImpl,
            `${API_BASE}/image/${prompt}?model=flux`,
            { headers: { Authorization: `Bearer ${token}` } },
            async (response) => {
                await ensureOk(response, "image");
                const contentType = response.headers.get("content-type") ?? "";
                if (!contentType.toLowerCase().startsWith("image/"))
                    throw new ApiError(
                        "The illustration returned an invalid file. Retry the image.",
                        "parse",
                    );
                const length = Number(response.headers.get("content-length"));
                if (Number.isFinite(length) && length > MAX_IMAGE_BYTES)
                    throw new ApiError(
                        "The illustration was too large. Retry the image.",
                        "parse",
                    );
                const bytes = await readBoundedBytes(response, MAX_IMAGE_BYTES);
                if (!bytes.byteLength)
                    throw new ApiError(
                        "The illustration was empty. Retry the image.",
                        "parse",
                    );
                return new Blob([bytes], { type: contentType });
            },
            timeoutMs,
        );
        inFlightImages.set(imageKey, request);
        try {
            return await request;
        } finally {
            inFlightImages.delete(imageKey);
        }
    }
    return { discoverText, generateImage, inFlight, inFlightImages };
}
