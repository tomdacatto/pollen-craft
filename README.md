# Pollen Craft

Pollen Craft is a small, frontend-only Infinite Craft-style game for [quest #10973](https://github.com/pollinations/pollinations/issues/10973). Combine two of the four seeds (Fire, Water, Earth, and Wind) to ask the Pollinations text API for a strictly structured idea and the image API for its illustration.

## Run locally

This app has no build step or dependencies. Serve this directory over HTTP so ES modules work:

```bash
python3 -m http.server 4173 --directory apps/pollen-craft
```

Open `http://localhost:4173`. Settings connects a Pollinations wallet with OAuth authorization code + PKCE; no manual key or client secret is requested. The short-lived delegated `sk_` token is kept only in `sessionStorage` for this browser tab and is never written to `localStorage`, a URL, analytics, or logs. Reconnect after the delegated key expires. The selected text model is kept separately as an allowlisted `localStorage` preference and defaults to NVIDIA Nemotron 3.5 Lightning (`nemotron-3.5-lightning`). Existing model preferences use a new versioned preference key so this fresh default applies without changing the versioned discovery state. Discovery recipes are stored under `pollen-craft:game:v2`; older v1 recipes are intentionally ignored rather than migrated.

## Controls and privacy

The open off-white canvas starts with four compact ingredient chips. Drag any two distinct canvas chips together, or focus/tap two chips and press Enter/Space, to combine them. Every pair—including self-pairs—can produce any recognizable result, while the canonical recipe anchors remain exact. New discoveries appear as canvas chips and can be combined again. The right inventory rail becomes a compact bottom tray on small screens; click an inventory chip to place it on the canvas and reopen saved discoveries. Search filters the inventory. Settings contains the wallet connection; Help lists the short controls. Escape clears selection or closes the active result. **Retry idea** and **Retry image** handle individual API failures. Reset clears local discoveries. Disconnect clears this tab's delegated token and pending authorization; revoke an issued key separately in the Pollinations dashboard.

The layout is intentionally minimal: a slim top bar, a full-height crafting canvas, a thinly divided fixed inventory surface, and a small result popover near the latest chip. There are no bundled images or generated artifacts in the source. A screenshot has not been captured in this environment because local browser URLs are blocked by the browser policy.

The browser exchanges the OAuth code at `https://enter.pollinations.ai/api/oauth/token`, then calls `https://gen.pollinations.ai/v1/chat/completions` and `https://gen.pollinations.ai/image/{encoded-prompt}` with the delegated `sk_` token in an `Authorization: Bearer` header. The embedded App Key is `pk_N9TtZeTsMP9CoPss` and is used only as the OAuth `client_id`, never as a bearer credential. It must be an OAuth App Key with BYOP enabled. Register these exact callback URLs on that App Key: `https://pollen-craft.vercel.app/` and `http://localhost:4173/`. There is no refresh flow; reconnect after expiry. Text model choices are NVIDIA Nemotron 3.5 Lightning (`nemotron-3.5-lightning`, default), GPT-5 Nano (`openai-fast`), GPT-5.4 Nano (`openai`), Claude Fast, Gemini Fast, DeepSeek, and Mistral Small 3.2. The selected model applies to new or failed discoveries; already cached recipes remain pair-keyed and are reused. Every uncached pair still asks Pollinations for the result, including arbitrary self-pairs and results that repeat or join ingredient names. Grounded ingredient pairs require their established real-world result, with generated descriptions preserved. Model output is bounded, parsed as JSON, validated, and rendered as text—not HTML. Generated thumbnails use a session-only 24-image/48 MiB LRU and fall back to a neutral placeholder; object URLs and image blobs are never persisted. Images are revoked when evicted, reset, or the page closes.

## Deployment

`deploy.json` targets the current Pages app pipeline with subdomain `pollen-craft` and output `.`. This dependency-free app has no `npm install` or build command. A maintainer can validate discovery from the repository root:

```bash
node operations/deployment/discover.cjs --scope=apps --app=pollen-craft
node operations/deployment/discover.test.cjs
```

The app is ready to be copied into an itch.io HTML5 ZIP: zip the contents of this directory with `index.html` at the ZIP root, keep the `src/` paths relative, and enable HTTPS API access. A public Pages URL and itch.io URL have not been provisioned yet.
