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

- **Runtime**: Node.js (Express 5)
- **Auth**: Clerk (`@clerk/express`)
- **ORM**: Drizzle + PostgreSQL (Neon)
- **Payments**: Mollie
- **Scraping**: Playwright + puppeteer-extra-plugin-stealth (`src/scraping/`)
- **Validation**: Zod

## Route / Service Pattern (Express 5)

Routers only wire middleware + service handlers. Services own `req`/`res` (parse input, call DB, `res.json` / status). Do **not** wrap handlers in `try/catch` + `next(err)` — Express 5 forwards rejected promises to `errorHandler`.

```ts
// routes/leads.ts
leadsRouter.get("/", validate(listLeadsSchema, "query"), leadService.listLeads);
leadsRouter.get("/:id", leadService.getLead);

// services/lead.service.ts
export async function listLeads(req: Request, res: Response) {
  const { page, limit } = req.query as unknown as ListLeadsInput;
  const userId = req.dbUser!.id;
  // ... db work ...
  res.json({ data, meta });
}
```

Notes:
- Throw `Object.assign(new Error("..."), { statusCode: 404 })` for HTTP errors.
- `validate()` replaces `req.body` / `req.params`; for `query` it redefines the property (Express 5 `req.query` is read-only).
- Special cases (e.g. Mollie webhook plain-text 500 for retries) may catch locally inside the service handler.

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
├── routes/          # Thin routers: middleware + service handlers only
├── services/        # Route handlers (req/res) + domain logic (mailer, lifecycle)
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