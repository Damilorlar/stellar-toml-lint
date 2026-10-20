/**
 * What the toolbar badge says about the tab you are looking at.
 *
 * The badge is the whole point of the extension: it has to answer "is this
 * anchor's info file valid?" in the two characters a toolbar icon can show.
 * That means the mapping from a lint result to text, colour, and tooltip is a
 * decision worth writing down once and testing, rather than four `setBadgeText`
 * calls scattered through the service worker.
 */

/** Badge colours, matching the linter's own severity palette. */
export const BADGE_COLORS = {
  /** No findings at all. */
  valid: '#1a7f37',
  /** Warnings only: readable, but worth a look. */
  warning: '#9a6700',
  /** At least one error: a wallet will break. */
  error: '#cf222e',
  /** Nothing inspected (non-https tab, or a request that never completed). */
  neutral: '#59636e',
} as const;

/** The state the action badge should be put into. */
export interface BadgeState {
  /** At most four characters; a longer string is truncated by the browser. */
  text: string;
  color: string;
  /** Tooltip, shown on hover. */
  title: string;
}

/** The shape this module needs from a lint result. */
export interface BadgeCounts {
  ok: boolean;
  counts: { error: number; warning: number; info: number };
}

/** Nothing to inspect: an empty badge, never a misleading checkmark. */
export const NEUTRAL_BADGE: BadgeState = { text: '', color: BADGE_COLORS.neutral, title: '' };

/**
 * Maps a lint result onto the badge.
 *
 * Errors win over warnings, and the number shown is the count of the worst
 * severity present — "3" on a red badge means three errors, not three findings.
 * A clean file gets a checkmark because the absence of a badge is
 * indistinguishable from the extension not running.
 */
export function badgeFor(result: BadgeCounts): BadgeState {
  const { error, warning } = result.counts;

  if (error > 0) {
    return {
      text: String(error),
      color: BADGE_COLORS.error,
      title: `${error} error${error === 1 ? '' : 's'} in stellar.toml`,
    };
  }
  if (warning > 0) {
    return {
      text: String(warning),
      color: BADGE_COLORS.warning,
      title: `${warning} warning${warning === 1 ? '' : 's'} in stellar.toml`,
    };
  }
  return { text: '✓', color: BADGE_COLORS.valid, title: 'stellar.toml is valid' };
}

/** The badge for a site that served something unusable, or no file at all. */
export function badgeForUnreachable(origin: string): BadgeState {
  const host = new URL(origin).hostname;
  return {
    text: '?',
    color: BADGE_COLORS.neutral,
    title: `Could not read https://${host}/.well-known/stellar.toml`,
  };
}

/** The badge for a site the extension deliberately does not inspect. */
export function badgeForSkipped(): BadgeState {
  return { ...NEUTRAL_BADGE, title: 'Not an https site; nothing to inspect' };
}
