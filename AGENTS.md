# Agent Guidance

## Core Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start dev server with hot reload |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run production build |
| `pnpm db:push` | Push schema changes to DB (REQUIRED after schema changes) |
| `pnpm db:studio` | Open Drizzle Studio GUI |
| `pnpm db:generate` | Generate migration files |

## Stack

- **Runtime**: Node.js (Express)
- **Auth**: Clerk (`@clerk/express`)
- **ORM**: Drizzle + PostgreSQL (Neon)
- **Payments**: Mollie
- **Scraping**: Playwright + puppeteer-extra-plugin-stealth (`src/scraping/`)
- **Validation**: Zod

## Required Env Variables

```
DATABASE_URL=postgresql://...
CLERK_SECRET_KEY=sk_test_...
MOLLIE_API_KEY=m_test_...
ALLOWED_ORIGIN=http://localhost:3000
PORT=3001
```

## Project Structure

```
src/
├── index.ts         # Entry point, Express app setup
├── scraping/        # Continuous scrape loop (Maps + website email crawl)
├── routes/          # API endpoints (leads, emails, billing, copilot, scrape-*)
├── services/        # Business logic (mailer, copilot, lifecycle, profiles)
├── db/              # Drizzle schema + drizzle.ts connection
├── middleware/      # Auth (Clerk), error handler
├── validators/      # Zod schemas
└── types/           # TypeScript augmentations
```

## Important Notes

### Scraping (`src/scraping/`)

- Booted from `index.ts` via `BrowserManager` + `runScraping`
- Picks active/running copilots via `copilot-lifecycle.service`
- Writes to `leads2` + `copilot_leads` (not the legacy `leads` table)
- Email sending is handled separately by `periodicSendScheduler` in mailer

Flow: `runScraping` → `resolveNextCopilot` → `listGoogleMapsListings` → insert `leads2` / `copilot_leads`

### Copilot System

- Copilot orchestrates scrape + email sending via the continuous loops above
- Activate a copilot (`status: active`) or `POST /copilots/:id/run` to enqueue it
- `sendLimit` from copilot controls daily scrape/email budget

### Lead Status Values (`leads2` / `copilot_leads`)

| Status | Description |
|--------|-------------|
| `new` | Lead ready to email (`copilot_leads`) |
| `sent` | Email sent successfully |
| `success` / `fail` | Scrape outcome on `leads2` |

## DB Schema Changes

After modifying `src/db/schema.ts`, you MUST run:
```bash
pnpm db:push
```

Recent changes requiring push:
- Email column made nullable (remove `.notNull()`)
- Website unique constraint removed (remove `.unique()`)
- Added "pending_email" to lead status enum

## Docker

- Dockerfile uses Playwright image (`mcr.microsoft.com/playwright:v1.59.1-noble`)
- **Sync with package.json**: Update both when upgrading Playwright version
- docker-compose expects `.env` at project root

## Known Issues

- `zod: ^4.4.3` in package.json — v4 is not stable; should likely be `^3.x`
- No test framework configured
- No ESLint/Prettier setup