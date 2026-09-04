import { OAUTH_CLIENT_ID, parseOAuthTokenResponse } from "./oauth.js";

export const DEVICE_CODE_ENDPOINT =
    "https://enter.pollinations.ai/api/device/code";
export const DEVICE_TOKEN_ENDPOINT =
    "https://enter.pollinations.ai/api/device/token";
export const DEVICE_VERIFICATION_URI = "https://enter.pollinations.ai/device";
export const DEVICE_SCOPE = "generate usage";

const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 60_000;
const MAX_EXPIRES_SECONDS = 3_600;
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const ERROR_MESSAGES = Object.freeze({
    DEVICE_START_FAILED: "A wallet code could not be created. Try again.",
    DEVICE_RESPONSE_INVALID:
        "Pollinations returned an unreadable wallet response. Try again.",
    DEVICE_POLL_FAILED: "Wallet approval could not be checked. Try again.",
    DEVICE_ACCESS_DENIED: "Wallet connection was denied.",
    DEVICE_EXPIRED: "The wallet code expired. Connect again.",
    DEVICE_CANCELLED: "Wallet connection was cancelled.",
});

export class DeviceAuthError extends Error {
    constructor(code) {
        const safeCode = Object.hasOwn(ERROR_MESSAGES, code)
            ? code
            : "DEVICE_RESPONSE_INVALID";
        super(ERROR_MESSAGES[safeCode]);
        this.name = "DeviceAuthError";
        this.code = safeCode;
    }
}

function deviceError(code) {
    return new DeviceAuthError(code);
}

function boundedString(value, max) {
    return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseVerificationUri(value, userCode) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw deviceError("DEVICE_RESPONSE_INVALID");
    }
    if (
        url.origin !== "https://enter.pollinations.ai" ||
        url.pathname !== "/device" ||
        url.hash ||
        url.searchParams.get("user_code")?.toUpperCase() !== userCode ||
        [...url.searchParams.keys()].some((key) => key !== "user_code")
    ) {
        throw deviceError("DEVICE_RESPONSE_INVALID");
    }
    return url.toString();
}

function parseDeviceCode(payload, now) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw deviceError("DEVICE_RESPONSE_INVALID");
    const deviceCode = payload.device_code;
    const userCode = payload.user_code?.toUpperCase?.();
    if (
        !boundedString(deviceCode, 128) ||
        !/^[A-Za-z0-9_-]+$/u.test(deviceCode) ||
        !boundedString(userCode, 20) ||
        !/^[A-Z0-9-]+$/u.test(userCode) ||
        !Number.isSafeInteger(payload.expires_in) ||
        payload.expires_in <= 0 ||
        payload.expires_in > MAX_EXPIRES_SECONDS ||
        !Number.isSafeInteger(payload.interval) ||
        payload.interval <= 0 ||
        payload.interval > MAX_POLL_MS / 1_000
    ) {
        throw deviceError("DEVICE_RESPONSE_INVALID");
    }
    const verificationUri = parseVerificationUri(
        payload.verification_uri_complete,
        userCode,
    );
    return {
        deviceCode,
        userCode,
        verificationUri,
        expiresAt: now + payload.expires_in * 1_000,
        pollMs: Math.max(MIN_POLL_MS, payload.interval * 1_000),
    };
}

async function readResponse(response) {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
        throw deviceError("DEVICE_RESPONSE_INVALID");
    const reader = response.body?.getReader?.();
    let bytes;
    if (reader) {
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk =
                    value instanceof Uint8Array ? value : new Uint8Array(value);
                total += chunk.byteLength;
                if (total > MAX_RESPONSE_BYTES) {
                    await reader.cancel();
                    throw deviceError("DEVICE_RESPONSE_INVALID");
                }
                chunks.push(chunk);
            }
        } catch (error) {
            if (error instanceof DeviceAuthError) throw error;
            throw deviceError("DEVICE_RESPONSE_INVALID");
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
    } else {
        let text;
        try {
            text = await response.text();
        } catch {
            throw deviceError("DEVICE_RESPONSE_INVALID");
        }
        bytes = new TextEncoder().encode(text);
        if (bytes.byteLength > MAX_RESPONSE_BYTES)
            throw deviceError("DEVICE_RESPONSE_INVALID");
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw deviceError("DEVICE_RESPONSE_INVALID");
    }
}

async function requestJson(fetchImpl, url, body, signal, failureCode) {
    if (typeof fetchImpl !== "function") throw deviceError(failureCode);
    if (signal?.aborted) throw deviceError("DEVICE_CANCELLED");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(body),
            credentials: "omit",
            signal: controller.signal,
        });
        return { response, payload: await readResponse(response) };
    } catch (error) {
        if (error instanceof DeviceAuthError) throw error;
        throw deviceError(signal?.aborted ? "DEVICE_CANCELLED" : failureCode);
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", cancel);
    }
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(deviceError("DEVICE_CANCELLED"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(deviceError("DEVICE_CANCELLED"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function requestDeviceAuthorization({
    fetchImpl = globalThis.fetch,
    signal,
    now = Date.now,
} = {}) {
    const { response, payload } = await requestJson(
        fetchImpl,
        DEVICE_CODE_ENDPOINT,
        { client_id: OAUTH_CLIENT_ID, scope: DEVICE_SCOPE },
        signal,
        "DEVICE_START_FAILED",
    );
    if (!response?.ok) throw deviceError("DEVICE_START_FAILED");
    return parseDeviceCode(payload, now());
}

export async function pollDeviceAuthorization(
    authorization,
    { fetchImpl = globalThis.fetch, signal, now = Date.now, sleep = wait } = {},
) {
    let pollMs = authorization?.pollMs;
    if (
        !boundedString(authorization?.deviceCode, 128) ||
        !/^[A-Za-z0-9_-]+$/u.test(authorization.deviceCode) ||
        !Number.isFinite(authorization?.expiresAt) ||
        !Number.isFinite(pollMs) ||
        pollMs < MIN_POLL_MS ||
        pollMs > MAX_POLL_MS
    ) {
        throw deviceError("DEVICE_RESPONSE_INVALID");
    }
    while (Number.isFinite(pollMs) && now() < authorization.expiresAt) {
        await sleep(pollMs, signal);
        const { response, payload } = await requestJson(
            fetchImpl,
            DEVICE_TOKEN_ENDPOINT,
            {
                device_code: authorization.deviceCode,
                client_id: OAUTH_CLIENT_ID,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            },
            signal,
            "DEVICE_POLL_FAILED",
        );
        if (response?.ok) {
            try {
                return parseOAuthTokenResponse(payload, now);
            } catch {
                throw deviceError("DEVICE_RESPONSE_INVALID");
            }
        }
        if (payload?.error === "authorization_pending") continue;
        if (payload?.error === "slow_down") {
            pollMs = Math.min(MAX_POLL_MS, pollMs + 5_000);
            continue;
        }
        if (payload?.error === "access_denied")
            throw deviceError("DEVICE_ACCESS_DENIED");
        if (payload?.error === "expired_token")
            throw deviceError("DEVICE_EXPIRED");
        throw deviceError("DEVICE_POLL_FAILED");
    }
    throw deviceError("DEVICE_EXPIRED");
}
