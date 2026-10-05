/** The Ender ID screen's logic: what to say under the field, and whether Continue works. */
import { MAX_LABEL, MIN_LABEL, validateLabel, type LabelProblem } from '../../../protocol/names';

export const RULES = `${MIN_LABEL} to ${MAX_LABEL} letters, numbers or hyphens. You can't change it later.`;

const SAY: Record<LabelProblem | 'taken', string> = {
  characters: 'Only letters a to z, numbers and hyphens.',
  hyphens: 'Hyphens go between letters, one at a time.',
  'too-short': `At least ${MIN_LABEL} characters.`,
  'too-long': `At most ${MAX_LABEL} characters.`,
  reserved: "That one's reserved. Pick another.",
  taken: 'Taken. Pick another.',
};

/** Typed or pasted text as a label: lowercase, no spaces, no leading @ or trailing .ender.my. */
export const cleanLabel = (t: string) =>
  t.toLowerCase().replace(/\s+/g, '').replace(/^@/, '').replace(/\.ender\.my$/, '');

/** The gateway's answer for `label` (GET /names/check); `failed`: no answer (offline). */
export type Checked = { label: string; available?: boolean; reason?: string; failed?: true };

export type NameStatus = { text: string; tone: 'plain' | 'positive' | 'negative'; ok: boolean };

export const nameStatus = (label: string, checked?: Checked): NameStatus => {
  if (!label) return { text: RULES, tone: 'plain', ok: false };
  const problem = validateLabel(label);
  // Still typing: too short, or a hyphen that a letter may follow, is a hint rather than an error.
  if (problem === 'too-short' || (problem === 'hyphens' && /^[a-z0-9]+(-[a-z0-9]+)*-$/.test(label)))
    return { text: problem === 'too-short' ? SAY['too-short'] : RULES, tone: 'plain', ok: false };
  if (problem) return { text: SAY[problem], tone: 'negative', ok: false };
  if (checked?.label !== label) return { text: 'Checking…', tone: 'plain', ok: false };
  // The gateway decides on Continue anyway.
  if (checked.failed) return { text: "Couldn't check it just now. You can still try it.", tone: 'plain', ok: true };
  if (!checked.available) return { text: SAY[checked.reason as LabelProblem | 'taken'] ?? SAY.taken, tone: 'negative', ok: false };
  return { text: `${label}.ender.my is free.`, tone: 'positive', ok: true };
};
