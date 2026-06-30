import { db } from "../db/drizzle";
import {
  copilots,
  emailProfiles,
  emailTemplates,
  leads2Table,
  scrapeProfiles,
  copilotLeadsTable,
} from "../db/schema";
import BrowserManager from "./browserManager";
import { listGoogleMapsListings } from "./scraping";
import { and, eq, exists, or } from "drizzle-orm";

async function main() {
  const copilotsData = await db
    .select()
    .from(copilots)
    .leftJoin(scrapeProfiles, eq(copilots.scrapeProfileId, scrapeProfiles.id));
  // .leftJoin(emailProfiles, eq(copilots.emailProfileId, emailProfiles.id))
  // .leftJoin(emailTemplates, eq(copilots.templateId, emailTemplates.id));
  //   console.log(copilotsData);

  const browserManager = new BrowserManager();
  const browser = await browserManager.getBrowser();
  for (const copilot of copilotsData) {
    const existingLeads = await db
      .select({ placeId: leads2Table.placeId })
      .from(leads2Table)
      .where(
        or(
          exists(
            db
              .select()
              .from(copilotLeadsTable)
              .where(eq(copilotLeadsTable.copilotId, copilot.copilots.id)),
          ),
        ),
      );

    // console.log(existingLeads);
    const listings = await listGoogleMapsListings({
      browser,
      keyword: copilot.scrape_profiles?.searchQuery || "",
      city: copilot.scrape_profiles?.city || "",
      country: copilot.scrape_profiles?.country || "",
      max: 20,
      feedsListingFilter: async (card) => {
        if (!card.placeId) {
          return false;
        }
        const failedLeads = await db.$count(
          leads2Table,
          and(
            eq(leads2Table.status, "fail"),
            eq(leads2Table.placeId, card.placeId),
          ),
        );
        if (failedLeads > 0) {
          return false;
        }
        return !existingLeads.find((l) => l.placeId == card.placeId);
      },
      cardFeedFilter: async (listing) => {
        const continueFilter = !!listing.website;
        if (!continueFilter) {
          await db.insert(leads2Table).values({
            companyName: listing.name || "",
            email: "",
            website: "",
            phone: listing.phone || "",
            address: listing.addressSnippet || "",
            sourceQuery: copilot.scrape_profiles?.searchQuery || "",
            placeId: listing.placeId || "",
            status: "fail",
          });
        }
        return continueFilter;
      },
      websiteFilter: async (listing) => {
        const continueFilter = !!listing.email;
        if (!continueFilter) {
          await db.insert(leads2Table).values({
            companyName: listing.name || "",
            email: "",
            website: "",
            phone: listing.phone || "",
            address: listing.addressSnippet || "",
            sourceQuery: copilot.scrape_profiles?.searchQuery || "",
            placeId: listing.placeId || "",
            status: "fail",
          });
        }
        return continueFilter;
      },
      onListing: async (listing) => {
        await db.transaction(async (tx) => {
          const [lead] = await tx
            .insert(leads2Table)
            .values({
              companyName: listing.name || "",
              email: listing.email || "",
              website: listing.website || "",
              phone: listing.phone || "",
              address: listing.addressSnippet || "",
              sourceQuery: copilot.scrape_profiles?.searchQuery || "",
              placeId: listing.placeId || "",
              status: "success",
              emailScrapedAt: new Date(),
            })
            .returning();

          await tx.insert(copilotLeadsTable).values({
            copilotId: copilot.copilots.id,
            leadId: lead.id,
            status: "new",
          });
        });
      },
    });
    if (listings.length === 0) {
      console.log(
        `❌ No listings found for ${copilot.scrape_profiles?.searchQuery}`,
      );
      continue;
    }
  }
  await browserManager.closeBrowser();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
