# Kilo Coach v2: handover

Kilo Coach is a phone-first fitness app for Nathan and his partner: food logging, training, weigh-ins and an AI coach in one place. v1 lived as a Claude artifact. v2 (this repo) runs on Netlify with real accounts.

This project is separate from Blunderbust (the chess app, Netlify project `stately-bavarois-00566d`, repo `Chess-App`). Never deploy this repo to that project.

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| App | `web/index.html` | The whole single-page app (UI, calculations, coach tools). Ported from v1 almost unchanged. |
| Runtime | `src/runtime.js` → built to `web/runtime.js` | Sign-in screen, local cache, sync, AI tool loop. Gives the app the same `claude.use("db" / "sample" / "assets" / "downloads")` API it had as an artifact. |
| Data API | `netlify/functions/data.mts` (`/api/data`) | Reads and writes the signed-in user's documents in Netlify Database. |
| AI | `netlify/functions/ai.mts` (`/api/ai`) | Calls Claude through the Netlify AI Gateway and streams the reply. Tools run in the browser. |
| Photos | `netlify/functions/photo.mts` (`/api/photo`) | Progress photos in Netlify Blobs, private per user. |
| Sharing | `netlify/functions/share.mts` (`/api/share`) | Share links for saved workouts or a whole plan. Exercises, sets and reps only, no weights or stats. |
| Schema | `netlify/database/migrations/` | `docs` (one row per user document) and `shares`. |

### Data model
Each user's data is a set of documents keyed by path (`settings/main`, `days/2026-10-29`, `templates/<id>`, `plan/<date>` and so on), stored as JSONB in `docs (user_id, path, data)`. Every query filters by the Identity user id taken from the login cookie, so the two accounts can't see each other.

The browser keeps a copy of the user's documents in localStorage, so the app opens instantly and keeps working with bad gym signal. Writes go into an outbox that retries until the server has them. The app pulls fresh data every 45 seconds and whenever it comes back to the foreground.

### AI
- `new Anthropic()` inside the function, with no key. The AI Gateway injects credentials.
- Model: `KC_MODEL` / `KC_MODEL_QUICK` env vars if set. Otherwise the newest Sonnet (coach, plans) or Haiku (quick estimates) the gateway lists, with fallbacks.
- Usage is billed as Netlify credits. Rate limited to 40 requests a minute per visitor.

### Food database
Barcode lookups go straight from the phone to Open Food Facts (free, no key). If a product isn't there, the user can photograph the nutrition panel and Claude reads it. Either way, the product is saved to their foods, so the next scan adds in one tap.

## Setup (one time)
1. Netlify → **Add new project → Import an existing project → GitHub →** `nathanbullpitt-tech/Gym-app`. The build settings come from `netlify.toml` (build `npm run build`, publish `web`).
2. Deploy once. This creates the database, runs the migration and switches on the AI Gateway.
3. Project → **Identity → Enable Identity**.
4. Both people sign up in the app and click the confirmation email.
5. Then lock it down: either set Identity **Registration** to **Invite only**, or add the env var `KC_ALLOWED_EMAILS=you@x.com,her@y.com` (Functions scope) and redeploy.

## Env vars (all optional)
- `KC_ALLOWED_EMAILS`: comma-separated list of emails allowed to use the API.
- `KC_MODEL`, `KC_MODEL_QUICK`: force specific Claude model ids.

## Local testing
Identity doesn't run under `netlify dev`, so test sign-in on a deploy preview. Local UI testing was done against a mock backend with Playwright.

## Changes from v1
- Sign-in screen, plus sign out in Settings.
- Live camera barcode scanning (BarcodeDetector, falling back to ZXing on iPhone) and Open Food Facts lookup.
- Share buttons on saved workouts and "Share plan" in Train → Library. The other person opens the link, signs in and taps Add.
- Installable to the home screen (manifest and icons). The icon follows the colour theme: blue by default, pink when the pink theme is on at the time of adding it.
- Offline outbox and an offline banner.

## Ideas not done yet
- Text search of Open Food Facts from the Saved tab.
- Push reminders (weigh in, log food).
- A `userValidate` Identity function to block unknown sign-ups at the source.
