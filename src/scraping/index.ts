import { Browser } from "playwright";
import { db } from "../db/drizzle";
import {
  copilotsTable,
  leadsTable,
  targetAudienceTable,
  copilotLeadsTable,
  scrapeJobsTable,
} from "../db/schema";
import type { Copilot } from "../db/schema";
import { listGoogleMapsListings } from "./scraping";
import BrowserManager from "./browserManager";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getActiveSubscription,
  getCopilotProgress,
  pauseCopilot,
  setCopilotActive,
  resolveNextCopilot,
  completeCopilot,
} from "../services/copilot-lifecycle.service";
import type { CopilotProgress } from "../services/copilot-lifecycle.service";
import { OUTSIDE_SEND_WINDOW_MSG } from "../lib/send-window";

const MAX_SCRAPE_FAILURES = 3;
const scrapeFailureCounts = new Map<number, number>();

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
    .update(scrapeJobsTable)
    .set({ status, errorMessage, finishedAt: new Date() })
    .where(eq(scrapeJobsTable.id, scrapeJobId));
};

async function launchScrapeJob(copilot: Copilot): Promise<number | undefined> {
  if (!copilot.targetAudienceId) {
    await pauseCopilot(copilot.id, "No target audience configured");
    return;
  }

  const [targetAudience] = await db
    .select()
    .from(targetAudienceTable)
    .where(eq(targetAudienceTable.id, copilot.targetAudienceId))
    .limit(1);

  if (!targetAudience) {
    await pauseCopilot(copilot.id, "Scrape profile not found");
    return;
  }

  const [scrapeJob] = await db
    .insert(scrapeJobsTable)
    .values({
      userId: copilot.userId,
      targetAudienceId: copilot.targetAudienceId,
      query: targetAudience.searchQuery,
      status: "running",
    })
    .returning();

  await db
    .update(copilotsTable)
    .set({ lastJobId: scrapeJob.id, updatedAt: new Date() })
    .where(eq(copilotsTable.id, copilot.id));

  console.log(
    `🔍 Launched scrape job ${scrapeJob.id} for copilot ${copilot.id}`,
  );

  return scrapeJob.id;
}

async function getRunningScrapeJob(copilot: Copilot) {
  if (copilot.lastJobId) {
    const [jobById] = await db
      .select()
      .from(scrapeJobsTable)
      .where(
        and(
          eq(scrapeJobsTable.id, copilot.lastJobId),
          eq(scrapeJobsTable.status, "running"),
        ),
      )
      .limit(1);

    if (jobById) {
      return jobById;
    }
  }

  if (!copilot.targetAudienceId) {
    return null;
  }

  const [scrapeJob] = await db
    .select()
    .from(scrapeJobsTable)
    .where(
      and(
        eq(scrapeJobsTable.status, "running"),
        eq(scrapeJobsTable.targetAudienceId, copilot.targetAudienceId),
        eq(scrapeJobsTable.userId, copilot.userId),
      ),
    )
    .orderBy(desc(scrapeJobsTable.createdAt))
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
  if (!progress.withinSendWindow) {
    await setCopilotActive(copilot.id, OUTSIDE_SEND_WINDOW_MSG);
    return true;
  }

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

  if (!copilot.targetAudienceId) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage: "No target audience configured",
    });
    await pauseCopilot(copilot.id, "No target audience configured");
    return;
  }

  const [targetAudience] = await db
    .select()
    .from(targetAudienceTable)
    .where(eq(targetAudienceTable.id, copilot.targetAudienceId))
    .limit(1);

  if (!targetAudience) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage: "Target audience not found",
    });
    await pauseCopilot(copilot.id, "Target audience not found");
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
      errorMessage: !progress.withinSendWindow
        ? OUTSIDE_SEND_WINDOW_MSG
        : "Daily send limit reached",
    });
    return;
  }

  const maxListings = Math.min(
    subscription.remainingEmails,
    progress.remainingToday,
    progress.scrapeNeeded,
  );

  console.log(
    `🔍 Copilot ${copilot.id}: daily limit=${progress.dailySendLimit ?? "none"}, remaining today=${progress.remainingToday}, scrape needed=${progress.scrapeNeeded}, batch=${maxListings}`,
  );

  if (maxListings <= 0) {
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "done",
      errorMessage: "No listings needed",
    });

    if (!progress.withinSendWindow) {
      await setCopilotActive(copilot.id, OUTSIDE_SEND_WINDOW_MSG);
    } else if (progress.dailyLimitReached) {
      await setCopilotActive(
        copilot.id,
        "Daily send limit reached — will resume when quota resets",
      );
    }
    return;
  }

  const searchQuery = targetAudience.searchQuery;
  const copilotId = copilot.id;

  const existingLeads = await db
    .select({ placeId: leadsTable.placeId })
    .from(leadsTable)
    .innerJoin(copilotLeadsTable, eq(copilotLeadsTable.leadId, leadsTable.id))
    .where(eq(copilotLeadsTable.copilotId, copilotId));

  const recordFailedLead = async (listing: {
    name?: string | null;
    phone?: string | null;
    addressSnippet?: string | null;
    placeId?: string | null;
    website?: string | null;
    email?: string | null;
  }) => {
    if (!listing.placeId) {
      return;
    }

    // place_id is globally unique — ignore if another scrape already stored it
    await db
      .insert(leadsTable)
      .values({
        companyName: listing.name || "",
        email: listing.email || null,
        website: listing.website || null,
        phone: listing.phone || "",
        address: listing.addressSnippet || "",
        sourceQuery: searchQuery,
        placeId: listing.placeId,
        status: "fail",
      })
      .onConflictDoNothing({ target: leadsTable.placeId });
  };

  let listings;
  try {
    listings = await listGoogleMapsListings({
      browser,
      keyword: searchQuery,
      city: targetAudience.city ?? "",
      country: targetAudience.country ?? "",
      max: maxListings,
      feedsListingFilter: async (card) => {
        if (!card.placeId) {
          return false;
        }
        if (existingLeads.find((l) => l.placeId == card.placeId)) {
          return false;
        }
        const failedLeads = await db.$count(
          leadsTable,
          and(
            eq(leadsTable.status, "fail"),
            eq(leadsTable.placeId, card.placeId),
          ),
        );
        return failedLeads === 0;
      },
      cardFeedFilter: async (listing) => {
        const continueFilter = !!listing.website;
        if (!continueFilter) {
          await recordFailedLead(listing);
        }
        return continueFilter;
      },
      websiteFilter: async (listing) => {
        const continueFilter = !!listing.email;
        if (!continueFilter) {
          await recordFailedLead(listing);
        }
        return continueFilter;
      },
      onListing: async (listing) => {
        if (!listing.placeId) {
          return;
        }

        await db.transaction(async (tx) => {
          const [lead] = await tx
            .insert(leadsTable)
            .values({
              companyName: listing.name || "",
              email: listing.email || "",
              website: listing.website || "",
              phone: listing.phone || "",
              address: listing.addressSnippet || "",
              sourceQuery: searchQuery,
              placeId: listing.placeId,
              status: "success",
            })
            .onConflictDoUpdate({
              target: leadsTable.placeId,
              set: {
                companyName: listing.name || "",
                email: listing.email || "",
                website: listing.website || "",
                phone: listing.phone || "",
                address: listing.addressSnippet || "",
                sourceQuery: searchQuery,
                status: "success",
                updatedAt: new Date(),
              },
            })
            .returning();

          const alreadyLinked = await tx.$count(
            copilotLeadsTable,
            and(
              eq(copilotLeadsTable.copilotId, copilotId),
              eq(copilotLeadsTable.leadId, lead.id),
            ),
          );
          if (alreadyLinked > 0) {
            return;
          }

          await tx.insert(copilotLeadsTable).values({
            copilotId,
            leadId: lead.id,
            status: "new",
          });

          await tx
            .update(scrapeJobsTable)
            .set({
              leadsFound: sql<number>`${scrapeJobsTable.leadsFound} + 1`,
            })
            .where(eq(scrapeJobsTable.id, runningJob.id));
        });
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [jobState] = await db
      .select({ leadsFound: scrapeJobsTable.leadsFound })
      .from(scrapeJobsTable)
      .where(eq(scrapeJobsTable.id, runningJob.id))
      .limit(1);

    if (jobState && jobState.leadsFound > 0) {
      console.log(
        `⚠️ Scrape job ${runningJob.id} ended with error after finding ${jobState.leadsFound} lead(s)`,
      );
      scrapeFailureCounts.delete(runningJob.id);
      await stopScrapeJob({
        scrapeJobId: runningJob.id,
        status: "done",
        errorMessage: message,
      });
      return;
    }

    const failures = (scrapeFailureCounts.get(runningJob.id) ?? 0) + 1;
    scrapeFailureCounts.set(runningJob.id, failures);

    if (failures < MAX_SCRAPE_FAILURES) {
      console.warn(
        `⚠️ Scrape job ${runningJob.id} failed (${failures}/${MAX_SCRAPE_FAILURES}): ${message}`,
      );
      throw error;
    }

    scrapeFailureCounts.delete(runningJob.id);
    const reason = `Maps scrape failed after ${failures} attempts: ${message}`;
    console.error(`❌ ${reason}`);
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "failed",
      errorMessage: reason,
    });
    await pauseCopilot(copilotId, reason);
    return;
  }

  scrapeFailureCounts.delete(runningJob.id);

  if (listings.length === 0) {
    console.log(`❌ No listings found for ${searchQuery}`);
    await stopScrapeJob({
      scrapeJobId: runningJob.id,
      status: "done",
      errorMessage: "No listings found",
    });
    await completeCopilot(copilotId);
    return;
  }

  await stopScrapeJob({
    scrapeJobId: runningJob.id,
    status: "done",
  });
}

async function runScraping(browserManager: BrowserManager) {
  console.log(`🔍 Running scraping loop ${new Date().toISOString()}`);

  while (true) {
    try {
      const browser = await browserManager.getBrowser();
      const copilot = await resolveNextCopilot();

      if (copilot) {
        await processCopilot(browser, copilot);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(
        `❌ Error running scrape job ${new Date().toISOString()}:`,
        error,
      );
      await browserManager.restartBrowser();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export default runScraping;
