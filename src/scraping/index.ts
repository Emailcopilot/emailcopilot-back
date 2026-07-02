import { Browser } from "playwright";
import { db } from "../db/drizzle";
import {
  copilots,
  leads2Table,
  scrapeProfiles,
  copilotLeadsTable,
  scrapeJobs,
} from "../db/schema";
import type { Copilot } from "../db/schema";
import { listGoogleMapsListings } from "./scraping";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getActiveSubscription,
  getCopilotProgress,
  pauseCopilot,
  periodicCopilotNeedCheck,
  setCopilotActive,
  resolveNextCopilot,
} from "../services/copilot-lifecycle.service";
import type { CopilotProgress } from "../services/copilot-lifecycle.service";

const stopScrapeJob = async ({
  scrapeJobId,
  status,
  errorMessage,
}: {
  scrapeJobId: number;
  status: "failed" | "done";
  errorMessage?: string;
}) => {
  await db
    .update(scrapeJobs)
    .set({ status, errorMessage, finishedAt: new Date() })
    .where(eq(scrapeJobs.id, scrapeJobId));
};

async function launchScrapeJob(copilot: Copilot): Promise<number | undefined> {
  if (!copilot.scrapeProfileId) {
    await pauseCopilot(copilot.id, "No scrape profile configured");
    return;
  }

  const [scrapeProfile] = await db
    .select()
    .from(scrapeProfiles)
    .where(eq(scrapeProfiles.id, copilot.scrapeProfileId))
    .limit(1);

  if (!scrapeProfile) {
    await pauseCopilot(copilot.id, "Scrape profile not found");
    return;
  }

  const [scrapeJob] = await db
    .insert(scrapeJobs)
    .values({
      userId: copilot.userId,
      scrapeProfileId: copilot.scrapeProfileId,
      query: scrapeProfile.searchQuery,
      status: "running",
    })
    .returning();

  await db
    .update(copilots)
    .set({ lastJobId: scrapeJob.id, updatedAt: new Date() })
    .where(eq(copilots.id, copilot.id));

  console.log(
    `🔍 Launched scrape job ${scrapeJob.id} for copilot ${copilot.id}`,
  );

  return scrapeJob.id;
}

async function getRunningScrapeJob(copilot: Copilot) {
  if (copilot.lastJobId) {
    const [jobById] = await db
      .select()
      .from(scrapeJobs)
      .where(
        and(
          eq(scrapeJobs.id, copilot.lastJobId),
          eq(scrapeJobs.status, "running"),
        ),
      )
      .limit(1);

    if (jobById) {
      return jobById;
    }
  }

  if (!copilot.scrapeProfileId) {
    return null;
  }

  const [scrapeJob] = await db
    .select()
    .from(scrapeJobs)
    .where(
      and(
        eq(scrapeJobs.status, "running"),
        eq(scrapeJobs.scrapeProfileId, copilot.scrapeProfileId),
        eq(scrapeJobs.userId, copilot.userId),
      ),
    )
    .orderBy(desc(scrapeJobs.createdAt))
    .limit(1);

  return scrapeJob ?? null;
}

async function stopRunningScrapeJobsForCopilot(
  copilot: Copilot,
  errorMessage: string,
) {
  const runningJob = await getRunningScrapeJob(copilot);
  if (runningJob) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage,
    });
  }
}

async function handleCopilotWorkStatus(
  copilot: Copilot,
  progress: CopilotProgress,
): Promise<boolean> {
  if (progress.dailyLimitReached) {
    await setCopilotActive(
      copilot.id,
      "Daily send limit reached — will resume when quota resets",
    );
    return true;
  }

  return false;
}

async function processCopilot(browser: Browser, copilot: Copilot) {
  const subscription = await getActiveSubscription(copilot.userId);

  if (!subscription) {
    await stopRunningScrapeJobsForCopilot(copilot, "No active subscription");
    await pauseCopilot(copilot.id, "No active subscription");
    return;
  }

  if (subscription.remainingEmails <= 0) {
    await stopRunningScrapeJobsForCopilot(
      copilot,
      "Monthly email limit reached",
    );
    await pauseCopilot(copilot.id, "Monthly email limit reached");
    return;
  }

  const runningJob = await getRunningScrapeJob(copilot);

  if (runningJob) {
    await runScrapeJob(browser, copilot);
    return;
  }

  const progress = await getCopilotProgress(copilot, subscription);

  if (await handleCopilotWorkStatus(copilot, progress)) {
    return;
  }

  if (progress.scrapeNeeded > 0) {
    await launchScrapeJob(copilot);
    await runScrapeJob(browser, copilot);
  }
}

async function runScrapeJob(
  browser: Browser,
  copilot: Copilot,
): Promise<void> {
  const runningJob = await getRunningScrapeJob(copilot);

  if (!runningJob) {
    return;
  }

  if (!copilot.scrapeProfileId) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage: "No scrape profile configured",
    });
    await pauseCopilot(copilot.id, "No scrape profile configured");
    return;
  }

  const [scrapeProfile] = await db
    .select()
    .from(scrapeProfiles)
    .where(eq(scrapeProfiles.id, copilot.scrapeProfileId))
    .limit(1);

  if (!scrapeProfile) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage: "Scrape profile not found",
    });
    await pauseCopilot(copilot.id, "Scrape profile not found");
    return;
  }

  const subscription = await getActiveSubscription(copilot.userId);

  if (!subscription) {
    console.log(`❌ No active subscription for user ${copilot.userId}`);
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage: "No active subscription",
    });
    await pauseCopilot(copilot.id, "No active subscription");
    return;
  }

  if (subscription.remainingEmails <= 0) {
    console.log(`❌ Monthly email limit reached for user ${copilot.userId}`);
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage: "Monthly email limit reached",
    });
    await pauseCopilot(copilot.id, "Monthly email limit reached");
    return;
  }

  const progress = await getCopilotProgress(copilot, subscription);

  if (await handleCopilotWorkStatus(copilot, progress)) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "done",
      errorMessage: "Daily send limit reached",
    });
    return;
  }

  const maxListings = Math.min(
    subscription.remainingEmails,
    progress.remainingToday,
    progress.scrapeNeeded,
  );

  console.log(
    `🔍 Copilot ${copilot.id}: daily limit=${progress.dailySendLimit}, remaining today=${progress.remainingToday}, scrape needed=${progress.scrapeNeeded}, batch=${maxListings}`,
  );

  if (maxListings <= 0) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "done",
      errorMessage: "No listings needed",
    });

    if (progress.dailyLimitReached) {
      await setCopilotActive(
        copilot.id,
        "Daily send limit reached — will resume when quota resets",
      );
    }
    return;
  }

  const searchQuery = scrapeProfile.searchQuery;
  const copilotId = copilot.id;

  const existingLeads = await db
    .select({ placeId: leads2Table.placeId })
    .from(leads2Table)
    .innerJoin(copilotLeadsTable, eq(copilotLeadsTable.leadId, leads2Table.id))
    .where(eq(copilotLeadsTable.copilotId, copilotId));

  const listings = await listGoogleMapsListings({
    browser,
    keyword: searchQuery,
    city: (scrapeProfile as { city?: string }).city || "",
    country: (scrapeProfile as { country?: string }).country || "",
    max: maxListings,
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
          sourceQuery: searchQuery,
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
          sourceQuery: searchQuery,
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
            sourceQuery: searchQuery,
            placeId: listing.placeId || "",
            status: "success",
          })
          .returning();

        await tx.insert(copilotLeadsTable).values({
          copilotId,
          leadId: lead.id,
          status: "new",
        });

        await tx
          .update(scrapeJobs)
          .set({
            leadsFound: sql<number>`${scrapeJobs.leadsFound} + 1`,
          })
          .where(eq(scrapeJobs.id, runningJob.id));
      });
    },
  });

  if (listings.length === 0) {
    console.log(`❌ No listings found for ${searchQuery}`);
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "done",
      errorMessage: "No listings found",
    });
    return;
  }

  await stopScrapeJob({
    scrapeJobId: runningJob.id,
    status: "done",
  });
}

async function runScraping(browser: Browser) {
  console.log(`🔍 Running scraping loop ${new Date().toISOString()}`);

  const COPILOT_NEED_CHECK_MS = 30_000;
  let lastCopilotNeedCheck = 0;

  while (true) {
    try {
      let copilot = await resolveNextCopilot();

      if (copilot) {
        await processCopilot(browser, copilot);
      }

      if (Date.now() - lastCopilotNeedCheck >= COPILOT_NEED_CHECK_MS) {
        if (!copilot) {
          copilot = await periodicCopilotNeedCheck();
          if (copilot) {
            await processCopilot(browser, copilot);
          }
        }
        lastCopilotNeedCheck = Date.now();
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(
        `❌ Error running scrape job ${new Date().toISOString()}:`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export default runScraping;
