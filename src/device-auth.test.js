import assert from "node:assert/strict";
import test from "node:test";
import {
    DEVICE_CODE_ENDPOINT,
    DEVICE_SCOPE,
    DEVICE_TOKEN_ENDPOINT,
    DeviceAuthError,
    pollDeviceAuthorization,
    requestDeviceAuthorization,
} from "./device-auth.js";
import { OAUTH_CLIENT_ID } from "./oauth.js";

const codePayload = {
    device_code: "DeviceCode123",
    user_code: "ABCD2345",
    verification_uri_complete:
        "https://enter.pollinations.ai/device?user_code=ABCD2345",
    expires_in: 1_800,
    interval: 5,
};

test("device authorization requests one attributed, least-scope code", async () => {
    const requests = [];
    const authorization = await requestDeviceAuthorization({
        now: () => 1_000,
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(codePayload), { status: 200 });
        },
    });
    assert.equal(requests[0].url, DEVICE_CODE_ENDPOINT);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        client_id: OAUTH_CLIENT_ID,
        scope: DEVICE_SCOPE,
    });
    assert.equal(requests[0].options.credentials, "omit");
    assert.deepEqual(authorization, {
        deviceCode: "DeviceCode123",
        userCode: "ABCD2345",
        verificationUri:
            "https://enter.pollinations.ai/device?user_code=ABCD2345",
        expiresAt: 1_801_000,
        pollMs: 5_000,
    });
});

test("device polling waits, backs off, and returns a bounded secret token", async () => {
    const sleeps = [];
    const requests = [];
    const responses = [
        new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 400,
        }),
        new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }),
        new Response(
            JSON.stringify({
                access_token: "sk_device_12345678",
                token_type: "bearer",
                expires_in: 60,
            }),
            { status: 200 },
        ),
    ];
    const token = await pollDeviceAuthorization(
        {
            deviceCode: "DeviceCode123",
            expiresAt: 100_000,
            pollMs: 5_000,
        },
        {
            now: () => 1_000,
            sleep: async (ms) => sleeps.push(ms),
            fetchImpl: async (url, options) => {
                requests.push({ url, options });
                return responses.shift();
            },
        },
    );
    assert.deepEqual(sleeps, [5_000, 5_000, 10_000]);
    assert.equal(
        requests.every(({ url }) => url === DEVICE_TOKEN_ENDPOINT),
        true,
    );
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        device_code: "DeviceCode123",
        client_id: OAUTH_CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    assert.deepEqual(token, {
        token: "sk_device_12345678",
        expiresAt: 61_000,
    });
});

test("device flow rejects unsafe URLs, denial, expiry, and cancellation", async () => {
    await assert.rejects(
        requestDeviceAuthorization({
            fetchImpl: async () =>
                new Response(
                    JSON.stringify({
                        ...codePayload,
                        verification_uri_complete:
                            "https://example.com/device?user_code=ABCD2345",
                    }),
                    { status: 200 },
                ),
        }),
        { code: "DEVICE_RESPONSE_INVALID" },
    );
    for (const [error, code] of [
        ["access_denied", "DEVICE_ACCESS_DENIED"],
        ["expired_token", "DEVICE_EXPIRED"],
    ]) {
        await assert.rejects(
            pollDeviceAuthorization(
                {
                    deviceCode: "DeviceCode123",
                    expiresAt: 10_000,
                    pollMs: 5_000,
                },
                {
                    now: () => 1_000,
                    sleep: async () => {},
                    fetchImpl: async () =>
                        new Response(JSON.stringify({ error }), {
                            status: 400,
                        }),
                },
            ),
            { code },
        );
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        requestDeviceAuthorization({
            signal: controller.signal,
            fetchImpl: async () => assert.fail("must not fetch"),
        }),
        (error) =>
            error instanceof DeviceAuthError &&
            error.code === "DEVICE_CANCELLED",
    );
});
