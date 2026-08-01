# PaperLoom

PaperLoom is a hackathon-ready cryptographic physical-to-cloud knowledge node. It simulates a scanner that fingerprints a physical document, stores the scan in Supabase behind fingerprint-bound Row-Level Security, audits the text with Tavily-grounded AI, and opens a secure student dashboard.

## Stack

- Next.js App Router, TypeScript, Tailwind CSS
- Supabase PostgreSQL with strict RLS
- Wokwi ESP32 simulator with I2C SSD1306 OLED
- Tavily Search API for grounding
- OpenAI SDK for structured curriculum auditing
- Render API utility for per-student dashboard instances

## Project Layout

- `app/page.tsx` - browser scan console that hashes scan text, calls ingest, stores the JWT, and opens the dashboard.
- `app/api/ingest/route.ts` - ESP32/browser ingest, Supabase insertion, Tavily grounding, OpenAI audit, JWT generation, optional Render deploy.
- `app/api/deploy/route.ts` - protected manual Render deployment endpoint.
- `app/dashboard/[hash]/page.tsx` - client-side secure workspace dashboard using Supabase RLS.
- `lib/renderDeployer.ts` - Render service creation utility with retry and error handling.
- `supabase/migrations/202608010001_paperloom_core.sql` - database schema, functions, grants, and RLS policies.
- `wokwi/` - ESP32 firmware simulator, wiring diagram, and libraries.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment variables:

```bash
cp .env.example .env.local
```

3. Fill in Supabase, Tavily, OpenAI, and optional Render credentials in `.env.local`.

4. Apply the Supabase migration in `supabase/migrations/202608010001_paperloom_core.sql`.

5. Start the app:

```bash
npm run dev
```

6. Open `http://localhost:3000`, mint a workspace, then open the generated dashboard.

## Supabase Security Model

The ingest endpoint uses `SUPABASE_SERVICE_ROLE_KEY` only on the server to insert or update initial records. The browser dashboard never receives the service role key. It uses the returned short-lived JWT signed with `SUPABASE_JWT_SECRET`.

RLS policies permit `SELECT`, `INSERT`, and `UPDATE` only when `auth.jwt() ->> 'fingerprint_hash'` matches the row-level `books_and_notes.fingerprint_hash`. The `educational_gaps` table authorizes through its parent note.

## Wokwi Demo

Open the `wokwi/` folder in Wokwi. The sketch connects to `Wokwi-GUEST`, simulates a scan, generates a SHA-256 fingerprint from mocked fiber sensor data, updates the OLED, and posts to:

```text
https://your-app.vercel.app/api/ingest
```

Replace `INGEST_ENDPOINT` in `wokwi/sketch.ino` with your deployed app URL.

## Render Automation

Set `RENDER_AUTODEPLOY_WORKSPACES=true` to let `/api/ingest` create a Render static-site service after a successful audit. The service receives immutable environment variables:

- `PAPERLOOM_FINGERPRINT_HASH`
- `PAPERLOOM_NOTE_ID`
- `PAPERLOOM_WORKSPACE_MODE`
- `NEXT_PUBLIC_PAPERLOOM_NOTE_ID`

Render deployment can also be triggered with `POST /api/deploy` using the PaperLoom JWT as a bearer token.

## Production Notes

- Keep `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, and `RENDER_API_KEY` server-only.
- Keep PaperLoom JWTs short-lived. The current route issues 10-minute tokens.
- Store client tokens in `sessionStorage` or a short-lived readable cookie only for the dashboard flow.
- Use HTTPS everywhere when connecting the ESP32 simulator to a deployed endpoint.
