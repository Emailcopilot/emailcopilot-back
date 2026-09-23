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

  // An explicit null clears a relation; undefined falls back to a legacy alias.
  return {
    ...rest,
    emailAccountId:
      rest.emailAccountId === undefined ? emailProfileId : rest.emailAccountId,
    emailAccount:
      rest.emailAccount === undefined ? emailProfile : rest.emailAccount,
    targetAudienceId:
      rest.targetAudienceId === undefined
        ? scrapeProfileId
        : rest.targetAudienceId,
    targetAudience:
      rest.targetAudience === undefined ? scrapeProfile : rest.targetAudience,
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
