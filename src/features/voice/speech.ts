/**
 * Text for the ear: what a Markdown answer sounds like when read aloud,
 * and what a spoken phrase means as the answer to a question. Pure, so
 * the voice controller's decisions are testable without a microphone.
 */

/** Flatten Markdown to speakable prose and cut it at a sentence near `max` characters. */
export function speechText(text: string, { markdown = false, max = 1200 }: { markdown?: boolean; max?: number } = {}): string {
  let t = text
  if (markdown) {
    t = t
      .replace(/```[\s\S]*?```/g, ' ') // code blocks are for the eye
      .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '') // table rules
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '.') // table rows → "a, b, c."
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
      .replace(/<[^>]+>/g, ' ') // html
      .replace(/^#{1,6}\s+(.*)$/gm, '$1.') // headings end the sentence
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '') // list markers
      .replace(/^\s*>\s?/gm, '') // quotes
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/^[-*_]{3,}\s*$/gm, '')
  }
  t = t
    // A paragraph break ends the sentence; a line break within one is a pause — unless the line already ended one.
    .replace(/([.!?:;,])[ \t]*\n\s*\n\s*/g, '$1 ')
    .replace(/[ \t]*\n\s*\n\s*/g, '. ')
    .replace(/([.!?:;,])[ \t]*\n\s*/g, '$1 ')
    .replace(/[ \t]*\n\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
  if (t.length <= max) return t
  // Cut at the last sentence end before the limit, else at the last word.
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return (end > max * 0.4 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ')) + '…').trim()
}

/**
 * Names the transcriber gets wrong, and what was meant. Only spellings that cannot be anything else: "a graph" with
 * a space stays, since "show me a graph" is a real request; the assistant is told to read it as the product anyway.
 */
const NAMES: [RegExp, string][] = [
  [/\b(?:a+|ae|ay|ai|eigh|e)[-\s]?graph(?=\b)/gi, 'Aegraph'], // Agraph, AEgraph, Ay-graph, egraph…
  [/\bae\s?graph\b/gi, 'Aegraph'],
  [/\bagraf\b/gi, 'Aegraph'],
]

/** Fix what the transcriber is known to mishear, leaving everything else as said. */
export function fixTranscript(text: string): string {
  let out = text
  for (const [re, name] of NAMES) out = out.replace(re, (m) => (/^a graph$/i.test(m) ? m : name))
  return out
}

const YES = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed', 'do it', 'go ahead', 'delete', 'delete it', 'proceed', 'affirmative', 'correct']
const NO = ['no', 'nope', 'nah', 'cancel', 'stop', "don't", 'do not', 'never mind', 'nevermind', 'negative', 'decline', 'keep it', 'leave it']
const DECLINE = ['none', 'none of them', 'none of those', 'neither', 'cancel', 'skip', 'never mind', 'nevermind', 'no']
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/**
 * A typed reply to a confirmation, taken strictly: the whole reply is a yes ("yes", "ok", "go ahead", the button's
 * own word) or a no ("no", "cancel"). Anything longer is a message, not an answer — undefined.
 */
export function typedAnswer(text: string, yesLabel?: string): boolean | undefined {
  const t = normalize(text)
  if (!t) return undefined
  if (YES.includes(t) || (yesLabel && t === normalize(yesLabel))) return true
  if (NO.includes(t)) return false
  return undefined
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** `heard` contains `phrase` as whole words. */
const has = (heard: string, phrase: string) => ` ${heard} `.includes(` ${phrase} `)

/**
 * What a phrase means as the answer to a question: for a confirmation, true / false; for a choice, the chosen
 * option's text; null when the user declines; undefined when the phrase is not an answer at all.
 */
export function matchOption(heard: string, options: string[], kind: 'confirm' | 'choice'): string | boolean | null | undefined {
  const h = normalize(heard)
  if (!h) return undefined
  if (kind === 'confirm') {
    if (NO.some((w) => has(h, w))) return false
    if (YES.some((w) => has(h, w))) return true
    return undefined
  }
  const opts = options.map(normalize)
  // The option said outright, or the phrase is the option ("the second one" is handled below).
  const exact = opts.findIndex((o) => o === h)
  if (exact >= 0) return options[exact]
  // The option is in the phrase ("I'll take the map"), or the phrase is the start of the option (a short label said in full).
  const within = opts.map((o, i) => (o.length >= 3 && has(h, o) ? i : -1)).filter((i) => i >= 0)
  if (within.length === 1) return options[within[0]]
  if (within.length > 1) return options[within.reduce((a, b) => (opts[a].length >= opts[b].length ? a : b))]
  const prefix = opts.map((o, i) => (h.length >= 3 && o.startsWith(h) ? i : -1)).filter((i) => i >= 0)
  if (prefix.length === 1) return options[prefix[0]]
  // By position: "the second one", "number two", "option 2", "two", "the last one".
  if (has(h, 'last') || has(h, 'last one')) return options[options.length - 1]
  for (let i = 0; i < options.length; i++) {
    if (has(h, ORDINALS[i]) || has(h, `number ${NUMBERS[i]}`) || has(h, `number ${i + 1}`) || has(h, `option ${NUMBERS[i]}`) || has(h, `option ${i + 1}`) || h === NUMBERS[i] || h === String(i + 1)) return options[i]
  }
  if (DECLINE.some((w) => has(h, w))) return null
  return undefined
}

/** The phrases that end a dictated command, said on their own or at the end of the last phrase. */
const TERMINATOR = /(?:^|[\s,.!?])(send it|send that|send now|that's it|that's all|that is all|end of message)[\s.!?]*$/i

/** Strip a closing "send it" / "that's all" from a phrase: the words to keep, and whether the command ended there. */
export function endsCommand(phrase: string): { body: string; ends: boolean } {
  if (/^\s*send[\s.!?]*$/i.test(phrase)) return { body: '', ends: true }
  const m = TERMINATOR.exec(phrase)
  if (!m) return { body: phrase.trim(), ends: false }
  return { body: phrase.slice(0, m.index).replace(/[\s,]+$/, '').trim(), ends: true }
}

/**
 * Whether a phrase the microphone heard is the app's own voice coming back: a run of at least four words that is
 * in something said just now, or a long phrase nearly all of whose words are. Short phrases are never echo — they
 * are too likely to be the user using the same words.
 */
export function isEcho(heard: string, said: string[]): boolean {
  const h = normalize(heard)
  if (!h) return false
  const words = h.split(' ')
  if (words.length < 4) return false
  for (const s of said) {
    const n = normalize(s)
    if (!n) continue
    if (n.includes(h)) return true
    // A long phrase: nearly every word of it appears in what was said (the recogniser drops and swaps a few).
    if (words.length >= 6) {
      const bag = new Set(n.split(' '))
      const hits = words.filter((w) => bag.has(w)).length
      if (hits / words.length >= 0.8) return true
    }
  }
  return false
}

/**
 * The part of a streaming reply that can be read aloud now: complete sentences (or lines) past `from`, as one
 * chunk, once there is enough of them to be worth a breath — everything, when the reply is done. Nothing inside an
 * unclosed code fence is read. Returns the chunk and where the next call should start.
 */
export function speakableSoFar(text: string, from: number, done: boolean, minChars = 40): { chunk: string; upTo: number } {
  const rest = text.slice(from)
  if (!rest.trim()) return { chunk: '', upTo: from }
  // Inside an open code fence: wait for it to close (the fence is dropped by speechText anyway).
  const fencesBefore = (text.slice(0, from).match(/```/g) ?? []).length
  if (fencesBefore % 2 === 1) {
    const close = rest.indexOf('```')
    if (close < 0) return { chunk: '', upTo: from }
    return speakableSoFar(text, from + close + 3, done, minChars)
  }
  if (done) return { chunk: rest, upTo: text.length }
  // The last sentence or line end in `rest`, with a fence that opens before it excluded.
  let end = -1
  const re = /[.!?]["')\]]*(?=\s)|\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rest))) {
    const at = m.index + m[0].length
    if ((rest.slice(0, at).match(/```/g) ?? []).length % 2 === 1) continue // inside a fence: not a sentence end
    // A number's decimal point or a list marker ("1.") is not a sentence end.
    if (m[0] !== '\n' && /(^|\s)\d+$/.test(rest.slice(0, m.index))) continue
    end = at
  }
  if (end < 0) return { chunk: '', upTo: from }
  const chunk = rest.slice(0, end)
  if (chunk.trim().length < minChars) return { chunk: '', upTo: from }
  return { chunk, upTo: from + end }
}
