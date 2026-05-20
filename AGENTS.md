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
- **Scraping**: Playwright + puppeteer-extra-plugin-stealth
- **Scheduling**: node-cron
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
├── routes/          # API endpoints (leads, emails, scraper, billing, copilot)
├── services/        # Business logic (mailer, scraper, scheduler, copilot)
├── db/              # Drizzle schema + drizzle.ts connection
├── middleware/     # Auth (Clerk), error handler
├── validators/      # Zod schemas
└── types/           # TypeScript augmentations
```

## Important Notes

### Scraper (scraper.service.ts)

Key constants:
- `RESULTS_PER_BATCH = 20` - Max leads per batch before periodic restart
- `PERIODIC_RESTART_THRESHOLD = 15` - Force browser restart every N leads
- `SCRAPE_TIMEOUT = 45000` - Browser navigation timeout
- `DEFAULT_RESULTS_LIMIT = 10` - Default lead limit

Flow: `runScrapeJob` → `scrapeGoogleMaps` (batches) → `processBatch` → `initPage`

The scraper uses batch-based browser restarts to prevent browser crashes. Each batch:
1. Closes previous page, creates new stealth page
2. Navigates to fresh Google Maps search
3. Scrolls and extracts leads with status "pending_email"
4. Restarts after 15 leads (or when limit reached)

### Copilot System

- Copilot orchestrates scrape + email sending
- Schedule configured via `settings.schedule.runAt` (format: "HH:MM", 24-hour)
- `sendLimit` from copilot controls both scrape and email limits

### Lead Status Values

| Status | Description |
|--------|-------------|
| `new` | Valid lead with email extracted |
| `queued` | Queued for email sending |
| `sent` | Email sent successfully |
| `failed` | Email failed or no email found |
| `pending_email` | Scraped but email extraction not yet done |
| `replied` | Lead replied |
| `disqualified` | Marked as disqualified |
| `unsubscribed` | Unsubscribed |

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