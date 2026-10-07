import { EMAIL_TLDS } from "./email-tlds";

const SINGLE_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/**
 * Cut a word that was concatenated onto a real TLD.
 * `contact@site.netMaandag` and `contact@site.netmaandag` both become
 * `contact@site.net`.
 */
export function normalizeScrapedEmail(raw: string): string | null {
  const email = cutCamelCaseTld(raw).toLowerCase();
  const trimmed = trimToKnownTld(email);
  if (!trimmed || !SINGLE_EMAIL.test(trimmed)) return null;
  return trimmed;
}

function cutCamelCaseTld(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;

  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (dot < 0) return email;

  const tld = domain.slice(dot + 1);
  const camel = /^([a-z]{2,})[A-Z]/.exec(tld);
  if (!camel) return email;

  return email.slice(0, at + 1 + dot + 1) + camel[1];
}

function trimToKnownTld(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;

  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (dot <= 0) return null;

  const tld = domain.slice(dot + 1);
  if (!/^[a-z]+$/.test(tld)) return null;
  if (EMAIL_TLDS.has(tld)) return email;

  const max = Math.min(tld.length - 1, 63);
  for (let len = max; len >= 2; len--) {
    if (EMAIL_TLDS.has(tld.slice(0, len))) {
      return email.slice(0, at + 1 + dot + 1 + len);
    }
  }

  return tld.length <= 24 ? email : null;
}
