/**
 * Seed leads + copilot_leads with realistic demo data.
 *
 * Usage:
 *   pnpm db:seed                    # seed 60 leads (aborts if seed data exists)
 *   pnpm db:seed -- --count=120     # custom amount
 *   pnpm db:seed -- --append        # add more on top of existing seed data
 *   pnpm db:seed -- --reset         # delete previously seeded rows, then re-seed
 *   pnpm db:seed -- --seed=7        # deterministic data (same numbers every run)
 *
 * Only leads whose place_id starts with "seed_place_" are ever touched by
 * --reset, so scraped production leads are never deleted.
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "./drizzle";
import {
  copilotLeadsTable,
  copilotsTable,
  leadsTable,
  usersTable,
} from "./schema";

const SEED_PLACE_PREFIX = "seed_place_";

type LeadStatus = "success" | "fail";
type CopilotLeadStatus =
  | "new"
  | "sent"
  | "failed"
  | "bounced"
  | "replied";

// ─── tiny deterministic PRNG (mulberry32) ────────────────────────────────────

const makeRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Rng = () => number;

const pick = <T>(rng: Rng, values: readonly T[]): T =>
  values[Math.floor(rng() * values.length)]!;

const int = (rng: Rng, min: number, max: number) =>
  min + Math.floor(rng() * (max - min + 1));

// ─── demo data ───────────────────────────────────────────────────────────────

const CITIES = [
  "Amsterdam",
  "Rotterdam",
  "Utrecht",
  "Eindhoven",
  "Groningen",
  "Haarlem",
  "Nijmegen",
  "Tilburg",
  "Breda",
  "Den Haag",
  "Leiden",
  "Maastricht",
] as const;

const COMPANY_NAMES = [
  "De Koffiehoek",
  "Grand Cafe De Markt",
  "Bakkerij Bergman",
  "Hotel Zuiderpark",
  "Boekhandel Vos",
  "Restaurant De Haven",
  "Tandartspraktijk Meijer",
  "Kapsalon Style",
  "Sportschool Fit24",
  "Fietsenwerkplaats De Fiets",
  "Dierenkliniek Het Padvinder",
  "Cafe Central",
  "Eetcafe De Zwaan",
  "Slagerij Van Dijk",
  "Bloemenhuis Orchidee",
  "Galerie Noord",
  "Studio Bakkerij",
  "Wasserij Express",
  "Reparatiewerktuig De Pint",
  "Optiek Bril & Co",
  "Juridisch Kantoor Leyden",
  "Makelaardij Riviervier",
  "Notariskantoor De Klok",
  "Fysiotherapie Centrum Zuid",
  "Reisbureau Wereldwijd",
  "Printshop Copy & Go",
  "Wijnbar De Kelder",
  "Brouwerij Het Anker",
  "Tuincentrum Groenrijk",
  "Elektro Techniek Volt",
  "Schoonmaakbedrijf Stralend",
  "Verhuisbedrijf Spijker",
  "Autoservice De Motor",
  "Bouwbedrijf Metselwerk",
  "Instrumentmakerij Toon",
  "Muziekschool Ritme",
] as const;

const STREET_NAMES = [
  "Keizersgracht",
  "Havenstraat",
  "Dorpsplein",
  "Molenweg",
  "Stationsstraat",
  "Parklaan",
  "Kerkstraat",
  "Industrieweg",
  "Bakkerspad",
  "Schoolstraat",
] as const;

const EMAIL_LOCALS = [
  "info",
  "contact",
  "hallo",
  "hello",
  "office",
  "receptie",
] as const;

const SOURCE_QUERIES = [
  "coffee shop in Netherlands",
  "cafe in Amsterdam",
  "bakery in Rotterdam",
  "restaurant in Utrecht",
  "hotel in Haarlem",
] as const;

const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);

const DOMAIN_TLDS = [".nl", ".com", ".eu"] as const;

const buildEmail = (rng: Rng, domain: string): string | null => {
  const roll = rng();
  const local = pick(rng, EMAIL_LOCALS);

  // ~8% of scraped leads come through with no usable email
  if (roll < 0.05) return null;
  if (roll < 0.08) return "";

  const raw = `${local}@${domain}`;
  if (roll < 0.14) return `  ${raw.toUpperCase()} `; // messy casing/whitespace
  if (roll < 0.18) return raw.toUpperCase();
  return raw;
};

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? Number(match.split("=")[1]) : fallback;
};

const count = option("count", 60);
const linkRate = 0.75;
const rng = makeRng(option("seed", 42));

if (!Number.isFinite(count) || count <= 0) {
  console.error("--count must be a positive number");
  process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const seedLeadFilter = sql`${leadsTable.placeId} like ${SEED_PLACE_PREFIX + "%"}`;

const clearSeedData = async () => {
  const seeded = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(seedLeadFilter);

  if (seeded.length === 0) {
    console.log("Nothing to reset (no seeded leads found).");
    return;
  }

  const ids = seeded.map((row) => row.id);
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    await db.delete(copilotLeadsTable).where(inArray(copilotLeadsTable.leadId, batch));
    await db.delete(leadsTable).where(inArray(leadsTable.id, batch));
  }

  console.log(`Reset removed ${ids.length} seeded leads (and their links).`);
};

const resolveCopilotIds = async (): Promise<number[]> => {
  const copilots = await db
    .select({ id: copilotsTable.id })
    .from(copilotsTable)
    .orderBy(copilotsTable.id);

  if (copilots.length > 0) return copilots.map((row) => row.id);

  // No copilot yet: create a clearly-labelled demo user + copilot so the seed
  // can run on a fresh database.
  console.log("No copilot found — creating demo user + copilot.");
  const [user] = await db
    .insert(usersTable)
    .values({
      clerkId: "seed_demo_user",
      firstName: "Seed",
      lastName: "Demo",
      email: "seed-demo@example.com",
    })
    .onConflictDoNothing({ target: usersTable.clerkId })
    .returning({ id: usersTable.id });

  const userId =
    user?.id ??
    (await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(sql`${usersTable.clerkId} = 'seed_demo_user'`)
      .then((rows) => rows[0]!.id));

  const [copilot] = await db
    .insert(copilotsTable)
    .values({
      userId,
      name: "Seed Copilot",
      description: "Demo copilot created by src/db/seed.ts",
      status: "draft",
    })
    .returning({ id: copilotsTable.id });

  return [copilot!.id];
};

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (flag("reset")) {
    await clearSeedData();
  }

  const existing = await db.$count(leadsTable, seedLeadFilter);
  if (existing > 0 && !flag("append")) {
    console.log(
      `Seeded leads already present (${existing}). ` +
        "Use --append to add more or --reset to replace them.",
    );
    return;
  }

  const copilotIds = await resolveCopilotIds();
  const now = Date.now();

  const leads = Array.from({ length: count }, (_, index) => {
    const city = pick(rng, CITIES);
    const name = pick(rng, COMPANY_NAMES);
    const domain = `${slugify(name)}${pick(rng, DOMAIN_TLDS)}`;
    const isFail = rng() < 0.15; // scrape failed: no website/email captured
    const status: LeadStatus = isFail ? "fail" : "success";
    const linked = !isFail && rng() < linkRate;
    const createdAt = new Date(
      now - int(rng, 0, 14 * 24 * 60) * 60 * 1000, // spread over 2 weeks
    );

    return {
      placeId: `${SEED_PLACE_PREFIX}${String(index + 1).padStart(4, "0")}`,
      companyName: name,
      email: isFail ? null : buildEmail(rng, domain),
      website: isFail ? null : `https://www.${domain}`,
      phone: isFail ? "" : `+31 ${int(rng, 10, 99)} ${int(rng, 100, 999)} ${int(rng, 1000, 9999)}`,
      address: `${pick(rng, STREET_NAMES)} ${int(rng, 1, 180)}, ${int(rng, 1000, 9999)} ${city}, Netherlands`,
      sourceQuery: pick(rng, SOURCE_QUERIES),
      status,
      createdAt,
      updatedAt: createdAt,
      linked,
    };
  });

  const inserted = await db
    .insert(leadsTable)
    .values(
      leads.map(({ linked: _linked, ...lead }) => lead),
    )
    .returning({ id: leadsTable.id, placeId: leadsTable.placeId });

  const idByPlaceId = new Map(inserted.map((row) => [row.placeId, row.id]));

  const links: (typeof copilotLeadsTable.$inferInsert)[] = [];
  for (const lead of leads) {
    if (!lead.linked) continue;
    const leadId = idByPlaceId.get(lead.placeId);
    if (leadId === undefined) continue;

    // Weight links toward the first (oldest) copilot, like a real run would.
    const copilotId = copilotIds[
      rng() < 0.7 || copilotIds.length === 1 ? 0 : int(rng, 1, copilotIds.length - 1)
    ]!;

    const roll = rng();
    const createdAt = lead.createdAt;
    const link: typeof copilotLeadsTable.$inferInsert = {
      copilotId,
      leadId,
      createdAt,
      updatedAt: createdAt,
      currentStep: 0,
      status: "new",
    };

    if (roll < 0.55) {
      link.status = "new";
    } else if (roll < 0.8) {
      const sentAt = new Date(createdAt.getTime() + int(rng, 1, 48) * 60 * 60 * 1000);
      link.status = "sent";
      link.sentAt = sentAt;
      link.currentStep = int(rng, 1, 3);
      link.updatedAt = sentAt;
    } else if (roll < 0.88) {
      const failedAt = new Date(createdAt.getTime() + int(rng, 1, 24) * 60 * 60 * 1000);
      link.status = "failed";
      link.failedAt = failedAt;
      link.errorMessage = "SMTP 421: too many connections";
      link.updatedAt = failedAt;
    } else if (roll < 0.94) {
      const bouncedAt = new Date(createdAt.getTime() + int(rng, 1, 24) * 60 * 60 * 1000);
      link.status = "bounced";
      link.bouncedAt = bouncedAt;
      link.errorMessage = "550 5.1.1 recipient address rejected";
      link.updatedAt = bouncedAt;
    } else {
      const repliedAt = new Date(createdAt.getTime() + int(rng, 2, 72) * 60 * 60 * 1000);
      link.status = "replied";
      link.sentAt = new Date(repliedAt.getTime() - 60 * 60 * 1000);
      link.repliedAt = repliedAt;
      link.currentStep = 3;
      link.updatedAt = repliedAt;
    }

    links.push(link);
  }

  if (links.length > 0) {
    for (let offset = 0; offset < links.length; offset += 500) {
      await db.insert(copilotLeadsTable).values(links.slice(offset, offset + 500));
    }
  }

  const byStatus = links.reduce<Record<string, number>>((acc, link) => {
    const status = String(link.status ?? "new");
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

  console.log("Seed completed:", {
    leads: leads.length,
    linked: links.length,
    unlinked: leads.length - links.length,
    copilotIds,
    copilotLeadStatuses: byStatus,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .then(() => db.$client.end());
