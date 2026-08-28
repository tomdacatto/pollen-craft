import assert from "node:assert/strict";
import test from "node:test";
import {
    API_BASE,
    createApiClient,
    DEFAULT_TEXT_MODEL,
    isSecretKey,
    MAX_IMAGE_BYTES,
} from "./api.js";
import {
    canonicalPair,
    createInitialState,
    findDiscovery,
    gameReducer,
    inventoryItems,
    loadState,
    MAX_DESCRIPTION_LENGTH,
    MAX_DISCOVERIES,
    normalizeState,
    parseDiscoveryPayload,
    saveState,
} from "./game.js";

test("canonicalPair makes combinations order-independent", () => {
    assert.equal(canonicalPair(" Water ", "FIRE"), "fire+water");
    assert.equal(canonicalPair("fire", "fire"), "fire+fire");
    assert.throws(() => canonicalPair("fire+water", "earth"));
});

test("discovery parser requires bounded plain strings", () => {
    assert.deepEqual(
        parseDiscoveryPayload({
            name: "Steam",
            description: "A bright cloud.",
        }),
        { name: "Steam", description: "A bright cloud." },
    );
    assert.throws(() => parseDiscoveryPayload({ name: "", description: "no" }));
    assert.throws(() =>
        parseDiscoveryPayload({ name: "A", description: "ok", extra: "nope" }),
    );
    assert.throws(() =>
        parseDiscoveryPayload({
            name: "A",
            description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1),
        }),
    );
    assert.throws(() =>
        parseDiscoveryPayload({
            name: "<b>bad</b>",
            description: "still text",
        }),
    );
});

test("state load recovers corruption and bounds discoveries", () => {
    const storage = new Map([["pollen-craft:game:v1", "not json"]]);
    storage.getItem = storage.get.bind(storage);
    storage.removeItem = storage.delete.bind(storage);
    assert.deepEqual(loadState(storage), createInitialState());
    let state = createInitialState();
    for (let index = 0; index < MAX_DISCOVERIES + 4; index += 1) {
        state = gameReducer(state, {
            type: "discover",
            pair: `a${index}+b${index}`,
            discovery: { name: `N${index}`, description: "A discovery." },
        });
    }
    const saved = new Map();
    saved.setItem = (key, value) => saved.set(key, value);
    saved.getItem = saved.get.bind(saved);
    saved.removeItem = saved.delete.bind(saved);
    saveState(state, saved);
    assert.equal(
        normalizeState(JSON.parse(saved.get("pollen-craft:game:v1"))).order
            .length,
        MAX_DISCOVERIES,
    );
    const inherited = Object.create({
        toString: { name: "poison", description: "poison" },
    });
    inherited.version = 1;
    inherited.discoveries = Object.create({
        toString: { name: "poison", description: "poison" },
    });
    inherited.order = ["toString"];
    assert.equal(normalizeState(inherited).order.length, 0);
    assert.equal(findDiscovery(createInitialState(), "toString"), null);
});

test("discoveries become combinable inventory items", () => {
    const state = gameReducer(createInitialState(), {
        type: "discover",
        pair: "fire+water",
        discovery: { name: "Steam", description: "A bright cloud." },
    });
    const item = inventoryItems(state).find((entry) => entry.name === "Steam");
    assert.equal(item.id, "discovery-fire%2Bwater");
});

test("self discoveries use a canonical pair and remain bounded", () => {
    const state = gameReducer(createInitialState(), {
        type: "discover",
        pair: "fire+fire",
        discovery: { name: "Ember", description: "A doubled spark." },
    });
    assert.equal(findDiscovery(state, "fire+fire")?.name, "Ember");
    assert.equal(
        inventoryItems(state).find((item) => item.name === "Ember")?.id,
        "discovery-fire%2Bfire",
    );
});

test("discovery IDs encode the complete canonical pair", () => {
    let state = createInitialState();
    state = gameReducer(state, {
        type: "discover",
        pair: "a+b-c",
        discovery: { name: "First", description: "A first result." },
    });
    state = gameReducer(state, {
        type: "discover",
        pair: "a-b+c",
        discovery: { name: "Second", description: "A second result." },
    });
    const ids = inventoryItems(state)
        .filter((item) => item.discovered)
        .map((item) => item.id);
    assert.deepEqual(ids, ["discovery-a%2Bb-c", "discovery-a-b%2Bc"]);
});

test("only bounded sk_ keys are accepted", () => {
    assert.equal(isSecretKey("sk_test_12345678"), true);
    assert.equal(isSecretKey("pk_test_12345678"), false);
    assert.equal(isSecretKey("sk_short"), false);
    assert.equal(isSecretKey(`sk_${"a".repeat(178)}`), false);
});

test("text requests dedupe canonical pairs per credential without exposing keys", async () => {
    let calls = 0;
    const requestModels = [];
    const requestBodies = [];
    const fetchMock = async (url, options) => {
        calls += 1;
        assert.equal(url, `${API_BASE}/v1/chat/completions`);
        assert.match(options.headers.Authorization, /^Bearer sk_test_/u);
        assert.equal(url.includes("sk_test"), false);
        assert.equal(options.body.includes("sk_test"), false);
        const body = JSON.parse(options.body);
        requestModels.push(body.model);
        requestBodies.push(body);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(
            JSON.stringify({
                choices: [
                    {
                        finish_reason: "stop",
                        message: {
                            content: JSON.stringify({
                                name: "Steam",
                                description: "A bright cloud.",
                            }),
                        },
                    },
                ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    };
    const client = createApiClient(fetchMock, { timeoutMs: 1000 });
    const first = { id: "fire", name: "Fire", description: "spark" };
    const second = { id: "water", name: "Water", description: "current" };
    const reverse = { first: second, second: first };
    const forward = { first, second };
    await Promise.all([
        client.discoverText(forward, "sk_test_12345678"),
        client.discoverText(reverse, "sk_test_12345678"),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(requestModels, [DEFAULT_TEXT_MODEL]);
    await Promise.all([
        client.discoverText(forward, "sk_test_abcdefgh"),
        client.discoverText(reverse, "sk_test_abcdefgh"),
    ]);
    assert.equal(calls, 2);
    await Promise.all([
        client.discoverText(forward, "sk_test_12345678", "openai"),
        client.discoverText(reverse, "sk_test_12345678", "openai"),
        client.discoverText(forward, "sk_test_12345678", "claude-fast"),
        client.discoverText(reverse, "sk_test_12345678", "claude-fast"),
    ]);
    assert.equal(calls, 4);
    assert.deepEqual(requestModels, [
        DEFAULT_TEXT_MODEL,
        DEFAULT_TEXT_MODEL,
        "openai",
        "claude-fast",
    ]);
    const defaultBody = requestBodies[0];
    assert.equal(defaultBody.max_tokens, 2048);
    assert.equal(defaultBody.reasoning_effort, "minimal");
    assert.deepEqual(defaultBody.response_format, {
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
    });
    assert.equal(Object.hasOwn(requestBodies[2], "reasoning_effort"), false);
    assert.deepEqual(
        requestBodies[2].response_format,
        defaultBody.response_format,
    );
    assert.equal(Object.hasOwn(requestBodies[3], "reasoning_effort"), false);
    assert.deepEqual(requestBodies[3].response_format, { type: "json_object" });
});

test("truncated text responses are retryable instead of malformed JSON", async () => {
    const client = createApiClient(
        async () =>
            new Response(
                JSON.stringify({
                    choices: [
                        { finish_reason: "length", message: { content: "" } },
                    ],
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            ),
        { timeoutMs: 1000 },
    );
    const pair = {
        first: { id: "fire", name: "Fire", description: "spark" },
        second: { id: "water", name: "Water", description: "current" },
    };
    await assert.rejects(
        () => client.discoverText(pair, "sk_test_12345678"),
        /The idea response was cut off\. Retry the idea\./u,
    );
});

test("image requests validate content type and bounded size", async () => {
    const client = createApiClient(
        async () =>
            new Response(new Blob(["image"]), {
                status: 200,
                headers: { "content-type": "image/png" },
            }),
        { timeoutMs: 1000 },
    );
    const blob = await client.generateImage(
        { name: "Steam & Sun", description: "A bright cloud." },
        "sk_test_12345678",
    );
    assert.equal(blob.size, 5);
    const badType = createApiClient(
        async () =>
            new Response("not image", {
                status: 200,
                headers: { "content-type": "text/plain" },
            }),
        { timeoutMs: 1000 },
    );
    await assert.rejects(
        () =>
            badType.generateImage(
                { name: "Steam", description: "A cloud." },
                "sk_test_12345678",
            ),
        /invalid file/u,
    );
    const oversized = createApiClient(
        async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "image/png" }),
            arrayBuffer: async () => new Uint8Array(MAX_IMAGE_BYTES + 1).buffer,
        }),
        { timeoutMs: 1000 },
    );
    await assert.rejects(
        () =>
            oversized.generateImage(
                { name: "Steam", description: "A cloud." },
                "sk_test_12345678",
            ),
        /too large/u,
    );
});

test("image requests dedupe by discovery and credential", async () => {
    let calls = 0;
    const client = createApiClient(
        async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return new Response(new Blob(["image"]), {
                status: 200,
                headers: { "content-type": "image/png" },
            });
        },
        { timeoutMs: 1000 },
    );
    const discovery = { name: "Steam", description: "A bright cloud." };
    await Promise.all([
        client.generateImage(discovery, "sk_test_12345678"),
        client.generateImage({ ...discovery }, "sk_test_12345678"),
    ]);
    assert.equal(calls, 1);
});

test("body reads stay bounded and respect timeout", async () => {
    const never = createApiClient(
        async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            body: {
                getReader: () => ({
                    read: () => new Promise(() => {}),
                    cancel: async () => {},
                }),
            },
        }),
        { timeoutMs: 10 },
    );
    const pair = {
        first: { id: "fire", name: "Fire", description: "spark" },
        second: { id: "water", name: "Water", description: "current" },
    };
    await assert.rejects(
        () => never.discoverText(pair, "sk_test_12345678"),
        /too long/u,
    );
});
