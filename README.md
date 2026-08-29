# Pollen Craft

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftomdacatto%2Fpollen-craft)

Pollen Craft is a frontend-only Infinite Craft-style game. Combine the four starting seeds (Fire, Water, Earth, and Wind) to ask the Pollinations text API for a strictly structured idea and the image API for its illustration.

## Run locally

There are no dependencies or build steps. Serve the repository over HTTP so ES modules work:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`. The browser accepts only a user-provided registered Pollinations `sk_` Secret Key. The key is kept in `sessionStorage` for this browser tab only; browser code can access it, so use a temporary or scoped key. The selected text model is kept separately as an allowlisted `localStorage` preference and defaults to NVIDIA Nemotron 3.5 Lightning (`nemotron-3.5-lightning`). Existing model preferences use a versioned preference key so this fresh default applies without changing the versioned discovery state. No key is committed, logged, placed in an image URL, or sent in a request body. This repository embeds no secret and does not provision OAuth.

## Controls and privacy

Drag any two ingredient chips together, or focus/tap two chips and press Enter/Space, to combine them. The dragged chip and its best overlapping target are highlighted before a combination is made. New discoveries appear as canvas chips and can be combined again. The inventory rail becomes a bottom tray on small screens; search filters the inventory. Settings contains the key, Help lists the controls, and Escape clears selection or closes the active result. Retry actions handle individual API failures. Reset clears local discoveries; Forget removes the tab key.

The browser calls `https://gen.pollinations.ai/v1/chat/completions` and `https://gen.pollinations.ai/image/{encoded-prompt}` with the entered `sk_` key in an `Authorization: Bearer` header. Settings includes an allowlisted text-model selector: NVIDIA Nemotron 3.5 Lightning (`nemotron-3.5-lightning`, default), GPT-5 Nano (`openai-fast`), GPT-5.4 Nano (`openai`), Claude Fast, Gemini Fast, DeepSeek, and Mistral Small 3.2. The selected model applies to new or failed discoveries; already-cached recipes remain pair-keyed and are reused. Every uncached pair still asks Pollinations for the result; the client only rejects responses that repeat both ingredient names or concatenate them with `+`. Model output is bounded, parsed as JSON, validated, and rendered as text—not HTML. Image responses are temporary object URLs and are revoked when replaced or the page closes.

## Deploy to Vercel

Import this repository into Vercel as a static site. Use no install command, no build command, and `.` as the output directory. Vercel can serve `index.html` directly from the repository root.
