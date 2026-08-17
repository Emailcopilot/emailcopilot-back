/** Transition aliases: old JSON keys stay valid while clients migrate. */

type CopilotAliasFields = {
  emailAccountId?: number | null;
  emailProfileId?: number | null;
  emailAccount?: unknown;
  emailProfile?: unknown;
  targetAudienceId?: number | null;
  scrapeProfileId?: number | null;
  targetAudience?: unknown;
  scrapeProfile?: unknown;
};

export function normalizeCopilotInput<T extends CopilotAliasFields>(body: T) {
  const {
    emailProfileId,
    emailProfile,
    scrapeProfileId,
    scrapeProfile,
    ...rest
  } = body;

  return {
    ...rest,
    emailAccountId: rest.emailAccountId ?? emailProfileId,
    emailAccount: rest.emailAccount ?? emailProfile,
    targetAudienceId: rest.targetAudienceId ?? scrapeProfileId,
    targetAudience: rest.targetAudience ?? scrapeProfile,
  };
}

export function withLegacyCopilotKeys<
  T extends {
    emailAccountId?: unknown;
    emailAccount?: unknown;
    targetAudienceId?: unknown;
    targetAudience?: unknown;
  },
>(row: T) {
  return {
    ...row,
    emailProfileId: row.emailAccountId,
    emailProfile: row.emailAccount,
    scrapeProfileId: row.targetAudienceId,
    scrapeProfile: row.targetAudience,
  };
}
