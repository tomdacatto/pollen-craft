# Pollen Craft

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftomdacatto%2Fpollen-craft)

Pollen Craft is a frontend-only Infinite Craft-style game. Combine the four starting seeds (Fire, Water, Earth, and Wind) to ask the Pollinations text API for a strictly structured idea and the image API for its illustration.

## Run locally

There are no dependencies or build steps. Serve the repository over HTTP so ES modules work:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`. The browser accepts only a user-provided registered Pollinations `pk_` App Key. The key is kept in `sessionStorage` for this browser tab only; discoveries and validated text are kept in bounded, versioned `localStorage`. No key is committed, logged, placed in an image URL, or sent in a request body. This repository embeds no secret and does not provision OAuth.

## Controls and privacy

Drag any two ingredient chips together, or focus/tap two chips and press Enter/Space, to combine them. New discoveries can be combined again. The inventory rail becomes a bottom tray on small screens; search filters the inventory. Settings contains the key, Help lists the controls, and Escape clears selection or closes the active result. Retry actions handle individual API failures. Reset clears local discoveries; Forget removes the tab key.

The browser calls `https://gen.pollinations.ai/v1/chat/completions` and `https://gen.pollinations.ai/image/{encoded-prompt}` with the entered `pk_` key in an `Authorization: Bearer` header. Model output is bounded, parsed as JSON, validated, and rendered as text—not HTML. Image responses are temporary object URLs and are revoked when replaced or the page closes.

## Deploy to Vercel

Import this repository into Vercel as a static site. Use no install command, no build command, and `.` as the output directory. Vercel can serve `index.html` directly from the repository root.
