import type { Diagnostic, Rule, RuleOverrides } from '../types.js';
import {
  checkSep24PostMessage,
  sep24PostMessageRules,
  type Sep24PostMessageOptions,
} from './sep24-postmessage.js';

export interface Sep24Options {
  rules?: RuleOverrides;
  verifyPostmessage?: boolean;
  postmessage?: Omit<Sep24PostMessageOptions, 'rules'>;
}

export async function verifySep24(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options: Sep24Options = {},
): Promise<Diagnostic[]> {
  if (options.verifyPostmessage !== true) return [];

  return checkSep24PostMessage(doc, fetchImpl, {
    ...options.postmessage,
    ...(options.rules !== undefined ? { rules: options.rules } : {}),
  });
}

export const sep24Rules: Rule[] = [...sep24PostMessageRules];

export const sep24RuleIds: readonly string[] = sep24Rules.map((rule) => rule.id);

export {
  analyzeSep24PostMessages,
  checkSep24PostMessage,
  INSECURE_POSTMESSAGE_WILDCARD_RULE,
  MALFORMED_POSTMESSAGE_PAYLOAD_RULE,
  sep24PostMessageRuleIds,
  sep24PostMessageRules,
  verifySep24PostMessage,
} from './sep24-postmessage.js';

export type {
  CapturedPostMessage,
  PostMessageCaptureOptions,
  PostMessageDirection,
  Sep24PostMessageLauncher,
  Sep24PostMessageOptions,
} from './sep24-postmessage.js';
