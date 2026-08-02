# PaperLoom

PaperLoom is a secure physical-to-cloud learning workspace. It connects a scanned page or simulated hardware scan to a cryptographic document fingerprint, stores the page in Supabase behind Row-Level Security, runs a grounded curriculum audit, and opens a student dashboard tailored for focused review.

The application is built for learning workflows where provenance matters: each dashboard is tied to a SHA-256 page identity and accessed with a short-lived fingerprint-bound JWT.

## Features

- Browser-based scan console with editable extracted text and local SHA-256 fingerprint generation.
- ESP32 Wokwi scanner simulation with OLED status UI, push-button scan trigger, and cloud upload.
- Server-side ingest pipeline with payload validation, Supabase persistence, Tavily grounding, Gemini curriculum auditing, and JWT issuance.
- Supabase PostgreSQL schema with strict fingerprint-based RLS for `books_and_notes` and `educational_gaps`.
- Secure student dashboard that fetches directly from Supabase using the custom JWT and RLS policies.
- Adaptive Cognitive Workspace modes:
  - Standard: full dashboard with overview, page scan, learning gaps, sources, and practice.
  - Bionic: widened scanned-text reading layout with guided visual emphasis.
  - Horizon: single-card focus mode for one critical learning node at a time.
- Optional Render automation for creating per-student static workspace services.

## Tech Stack

- Next.js App Router
- React 19
- TypeScript
- Tailwind CSS
- Supabase PostgreSQL and Row-Level Security
- Gemini API for structured curriculum analysis
- Tavily Search API for trusted educational grounding
- Render API for optional workspace deployment
- Wokwi ESP32 simulator with SSD1306 OLED

## Project Structure

```text
app/
  api/
    deploy/route.ts        Protected manual Render deployment endpoint
    ingest/route.ts        Scan ingest, audit, persistence, JWT minting
  dashboard/[hash]/page.tsx Secure student workspace dashboard
  globals.css              Global Tailwind and PaperLoom UI tokens
  layout.tsx               Root metadata and app shell
  page.tsx                 Browser scan console
lib/
  renderDeployer.ts        Render service creation utility
supabase/
  migrations/              Database schema, grants, functions, and RLS policies
wokwi/
  sketch.ino               ESP32 scanner simulation
  diagram.json             ESP32, OLED, and button wiring
  libraries.txt            Wokwi library dependencies
```

## Architecture

```text
Browser scan console or ESP32 simulator
        |
        | POST /api/ingest
        v
Next.js ingest route
        |
        | validate payload, upsert page, run Tavily + Gemini audit
        v
Supabase books_and_notes + educational_gaps
        |
        | issue short-lived JWT with fingerprint_hash claim
        v
Student dashboard /dashboard/[hash]
        |
        | client-side Supabase fetch with custom JWT
        v
RLS-authorized page content, gaps, sources, and practice UI
```

## Getting Started

### Prerequisites

- Node.js `20.11.0` or newer
- npm
- A Supabase project
- Gemini API key
- Tavily API key
- Render account and API key, only if using workspace deployment automation

### Install

```bash
npm install
```

### Configure Environment

Create `.env.local` in the project root.

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
GEMINI_API_KEY=
TAVILY_API_KEY=

# Optional
SUPABASE_URL=
GEMINI_MODEL=gemini-2.5-flash
NEXT_OUTPUT_MODE=

# Optional Render automation
RENDER_AUTODEPLOY_WORKSPACES=false
RENDER_API_KEY=
RENDER_OWNER_ID=
RENDER_DASHBOARD_REPO=
RENDER_DASHBOARD_BRANCH=main
RENDER_DASHBOARD_ROOT_DIR=
RENDER_ENVIRONMENT_ID=
RENDER_DASHBOARD_BUILD_COMMAND=npm install && npm run build
RENDER_DASHBOARD_PUBLISH_PATH=out
RENDER_API_BASE_URL=https://api.render.com/v1
```

Keep server-only secrets out of client code. Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are intended for browser exposure.

### Apply Database Migrations

Run the SQL files in order against your Supabase database:

```text
supabase/migrations/202608010001_paperloom_core.sql
supabase/migrations/202608010002_service_role_ingestion_grants.sql
```

These migrations create the core tables, helper functions, grants, triggers, indexes, and RLS policies.

### Run Locally

```bash
npm run dev
```

Open `http://localhost:3000`.

## Local Usage Flow

1. Open the PaperLoom scan console.
2. Review or edit the extracted text.
3. Click `Connect page`.
4. The browser generates a SHA-256 fingerprint and calls `/api/ingest`.
5. The ingest route stores the scan, runs the educational audit, and returns a short-lived JWT.
6. The client stores the token in `sessionStorage`.
7. Open the generated `/dashboard/[hash]` workspace.
8. Use Standard, Bionic, or Horizon mode depending on the student’s learning need.

## API Reference

### `POST /api/ingest`

Accepts a scan from the browser console or ESP32 simulator.

Request body:

```json
{
  "device_id": "paperloom-browser-console-001",
  "fingerprint_hash": "64-character-sha256-hex-digest",
  "raw_text": "Extracted page text"
}
```

Success response:

```json
{
  "success": true,
  "id": "note uuid",
  "token": "paperloom jwt",
  "dashboard_path": "/dashboard/[hash]",
  "educational_gap_id": "gap uuid",
  "missing_concepts_count": 4,
  "verified_resources_count": 6,
  "render_workspace": null
}
```

The route validates input with Zod, uses the Supabase service role key only on the server, runs Tavily-grounded Gemini analysis, stores the audit, and returns a JWT scoped to the page fingerprint.

### `POST /api/deploy`

Creates a Render workspace for an existing note. Requires a bearer token minted by PaperLoom.

Headers:

```text
Authorization: Bearer <paperloom-jwt>
Content-Type: application/json
```

Request body:

```json
{
  "fingerprint_hash": "64-character-sha256-hex-digest",
  "note_id": "note uuid"
}
```

The token `fingerprint_hash` claim must match the requested workspace.

## Data Model

### `books_and_notes`

Stores scanned page content.

- `id`
- `user_id`
- `fingerprint_hash`
- `raw_text`
- `created_at`

### `educational_gaps`

Stores the latest curriculum audit for a scanned page.

- `id`
- `note_id`
- `missing_concepts`
- `verified_resources`
- `updated_at`

## Security Model

PaperLoom uses fingerprint-bound access rather than broad client database permissions.

- `/api/ingest` uses `SUPABASE_SERVICE_ROLE_KEY` server-side only.
- The browser never receives the service role key.
- The ingest route signs a short-lived JWT using `SUPABASE_JWT_SECRET`.
- JWT claims include `fingerprint_hash`, `device_id`, `role`, and `scope`.
- The dashboard creates a Supabase client with the custom JWT.
- RLS allows access only when `auth.jwt() ->> 'fingerprint_hash'` matches the row fingerprint.
- `educational_gaps` authorization is inherited through the parent `books_and_notes` row.

Current JWT lifetime is `10m` in `app/api/ingest/route.ts`.

## Adaptive Cognitive Workspace

The student dashboard at `app/dashboard/[hash]/page.tsx` includes three workspace profiles:

- `standard`: the complete dashboard with document overview, scanned text, gaps, sources, and practice.
- `bionic`: a spatial reading view that expands line height and letter spacing while emphasizing word stems and key learning terms.
- `horizon`: a focus environment that removes surrounding dashboard content and presents exactly one learning node at a time.

This layer is designed to reduce cognitive overload, help students recover from attention drift, and let learners move between broad review and single-task study without leaving the workspace.

## Wokwi Hardware Demo

The `wokwi/` folder contains an ESP32 scanner simulation.

Hardware simulation:

- ESP32 DevKit C
- SSD1306 OLED over I2C
- Push button on GPIO 18
- Mock fiber sensor readings
- SHA-256 fingerprint generation with `mbedtls`

Before running the simulation, update `INGEST_ENDPOINT` in `wokwi/sketch.ino`:

```cpp
const char *INGEST_ENDPOINT = "https://your-app.vercel.app/api/ingest";
```

The simulator connects to `Wokwi-GUEST`, generates a fingerprint, posts the scan payload, and displays upload status on the OLED.

## Render Workspace Automation

Set this environment variable to enable automatic Render service creation after ingest:

```env
RENDER_AUTODEPLOY_WORKSPACES=true
```

PaperLoom creates a Render static-site service with these environment variables:

- `PAPERLOOM_FINGERPRINT_HASH`
- `PAPERLOOM_NOTE_ID`
- `PAPERLOOM_WORKSPACE_MODE`
- `NEXT_PUBLIC_PAPERLOOM_NOTE_ID`

Render deployment is optional. The core PaperLoom scan and dashboard flow works without it.

## Scripts

```bash
npm run dev        # Start local development server
npm run build      # Build the Next.js application
npm run start      # Start the production server
npm run lint       # Run ESLint
npm run typecheck  # Run TypeScript without emitting files
```

On Windows PowerShell, if script execution blocks `npm`, use `npm.cmd`:

```powershell
npm.cmd run lint
npm.cmd run typecheck
```

## Production Checklist

- Apply Supabase migrations before deploying the app.
- Store service-role, Gemini, Tavily, Render, and JWT secrets only in server-side environment variables.
- Use HTTPS for browser and ESP32 ingest calls.
- Keep PaperLoom JWT expiry short.
- Rotate `SUPABASE_JWT_SECRET` carefully because it must match Supabase JWT verification expectations.
- Verify RLS policies after every schema change.
- Disable Render auto-deploy unless per-student static workspace creation is needed.

## Development Notes

- The dashboard depends on a valid fingerprint route parameter.
- Client dashboard data access intentionally goes through Supabase RLS, not through a privileged API route.
- The browser scan console stores the PaperLoom token in `sessionStorage` under `paperloom.jwt` and `paperloom_token`.
- The dashboard can also read compatible token keys from cookies for deployment variants.
- `NEXT_OUTPUT_MODE=export` enables static export mode in `next.config.mjs`; API routes require a server runtime and should not be used from a purely static deployment.
