import type { Language } from '../../scripting/types'

/**
 * Switching a script's language. The assistant converts the code to the
 * language switched into (the two preludes share one vocabulary, so the
 * conversion is a translation, not a rewrite); the pair — what each side
 * said at the moment of the conversion — is remembered, so switching back
 * with the converted side unedited restores the original untouched, nothing
 * converted twice, while an edit before the switch converts afresh. Without
 * an assistant the code is left alone.
 */

export type Pair = Partial<Record<Language, string>>

export type SwitchPlan =
  /** The other side of the last conversion, unedited: restore it. */
  | { kind: 'cached'; code: string }
  /** The assistant's turn. */
  | { kind: 'assistant' }
  /** Nothing to do (a Visual script, or the same language). */
  | { kind: 'none'; reason: string }

export function planSwitch(pair: Pair | null, from: Language, to: Language, code: string): SwitchPlan {
  if (from === to) return { kind: 'none', reason: 'same language' }
  if (from === 'view' || to === 'view') return { kind: 'none', reason: 'Visual scripts draw with the DOM and are not converted' }
  if (pair && pair[from] === code && pair[to] !== undefined) return { kind: 'cached', code: pair[to]! }
  return { kind: 'assistant' }
}

/** The pair to remember after a conversion. */
export const pairOf = (from: Language, fromCode: string, to: Language, toCode: string): Pair => ({ [from]: fromCode, [to]: toCode })

/** The code block of an assistant's reply — a fenced block, else the whole text. */
export function codeOfReply(text: string): string {
  const fence = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text)
  return (fence ? fence[1] : text).trim() + '\n'
}

export const CONVERT_SYSTEM = (to: Language, jsApi: string, pyApi: string) =>
  `You convert aegraph scripts between JavaScript and Python. Both run in a sandbox over the same dataset with one shared vocabulary — the collections (entities.types.person.filter(…).neighbors(…).sort(…).table(…)), the helpers, the outputs — so the converted script must use the same collection calls and helper names, spelled as the target language spells them (JavaScript camelCase and \`ds.x\`; Python snake_case and the bare names). Records are objects in JavaScript and dicts in Python (e.data.born ↔ e['data']['born']). A JavaScript script returns its result; a Python script's trailing expression is its result. Keep the comments, the structure and the names; do not add features. Reply with the ${to === 'python' ? 'Python' : 'JavaScript'} script only, in one fenced code block, nothing else.\n\nJavaScript reference:\n${jsApi}\n\nPython reference:\n${pyApi}`

export const convertPrompt = (from: Language, to: Language, code: string) =>
  `Convert this ${from === 'python' ? 'Python' : 'JavaScript'} script to ${to === 'python' ? 'Python' : 'JavaScript'}.\n\n\`\`\`${from === 'python' ? 'python' : 'js'}\n${code}\n\`\`\``
