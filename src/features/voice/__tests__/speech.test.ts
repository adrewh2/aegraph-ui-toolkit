import { describe, expect, it } from 'vitest'
import { endsCommand, fixTranscript, isEcho, matchOption, speakableSoFar, speechText, typedAnswer } from '../speech'

describe('speechText', () => {
  it('flattens Markdown for the ear', () => {
    const md = `## Summary\n\nFiltered the graph to **Person** within \`2\` hops of [Ada](/entities/ada); 84 nodes.\n\n- three hubs\n- two clusters\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n\n| type | n |\n| --- | --- |\n| Person | 12 |\n`
    const t = speechText(md, { markdown: true })
    expect(t).toBe('Summary. Filtered the graph to Person within 2 hops of Ada; 84 nodes. three hubs, two clusters. type, n. Person, 12.')
  })

  it('keeps plain text as it is, joining lines with pauses', () => {
    expect(speechText('One\nTwo')).toBe('One, Two')
    expect(speechText('One.\nTwo')).toBe('One. Two')
    expect(speechText('One.\n\nTwo')).toBe('One. Two')
  })

  it('cuts long text at a sentence end', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ')
    const t = speechText(long, { max: 200 })
    expect(t.length).toBeLessThanOrEqual(200)
    expect(t.endsWith('.')).toBe(true)
    expect(t).toMatch(/^Sentence number 1 is here\./)
  })

  it('cuts at a word with an ellipsis when there is no sentence end', () => {
    const t = speechText('word '.repeat(100).trim(), { max: 40 })
    expect(t.endsWith('…')).toBe(true)
    expect(t.length).toBeLessThanOrEqual(41)
  })
})

describe('matchOption', () => {
  const options = ['The open document', 'A new note', 'Cancel the whole thing']

  it('takes yes and no for a confirmation, in several phrasings', () => {
    expect(matchOption('yes', [], 'confirm')).toBe(true)
    expect(matchOption('Yeah, go ahead.', [], 'confirm')).toBe(true)
    expect(matchOption('delete it', [], 'confirm')).toBe(true)
    expect(matchOption('no', [], 'confirm')).toBe(false)
    expect(matchOption("No, don't", [], 'confirm')).toBe(false)
    expect(matchOption('never mind', [], 'confirm')).toBe(false)
    expect(matchOption('what is the weather', [], 'confirm')).toBeUndefined()
  })

  it('matches an option said outright, inside a phrase, or by its start', () => {
    expect(matchOption('a new note', options, 'choice')).toBe('A new note')
    expect(matchOption("let's do a new note please", options, 'choice')).toBe('A new note')
    expect(matchOption('the open doc', options, 'choice')).toBe('The open document')
  })

  it('matches an option by position', () => {
    expect(matchOption('the first one', options, 'choice')).toBe('The open document')
    expect(matchOption('two', options, 'choice')).toBe('A new note')
    expect(matchOption('number 3', options, 'choice')).toBe('Cancel the whole thing')
    expect(matchOption('option two', options, 'choice')).toBe('A new note')
    expect(matchOption('the last one', options, 'choice')).toBe('Cancel the whole thing')
  })

  it('prefers the longest option when several are in the phrase', () => {
    expect(matchOption('the new note, not the note', ['note', 'new note'], 'choice')).toBe('new note')
  })

  it('declines on none / neither, and is undefined for anything else', () => {
    expect(matchOption('none of those', options, 'choice')).toBeNull()
    expect(matchOption('neither', options, 'choice')).toBeNull()
    expect(matchOption('tell me a joke', options, 'choice')).toBeUndefined()
    expect(matchOption('', options, 'choice')).toBeUndefined()
  })
})

describe('endsCommand', () => {
  it('strips a closing "send it" and marks the command ended', () => {
    expect(endsCommand('filter the graph to people, send it')).toEqual({ body: 'filter the graph to people', ends: true })
    expect(endsCommand("and colour them by type. That's all.")).toEqual({ body: 'and colour them by type.', ends: true })
    expect(endsCommand('send')).toEqual({ body: '', ends: true })
  })
  it('leaves an ordinary phrase alone, including "start over"', () => {
    expect(endsCommand('start over')).toEqual({ body: 'start over', ends: false })
    expect(endsCommand('send the document to the archive')).toEqual({ body: 'send the document to the archive', ends: false })
  })
})

describe('fixTranscript', () => {
  it('restores the product name from what the transcriber hears', () => {
    for (const heard of ['open Agraph', 'open AGraph', 'open ae graph', 'open Ay-graph', 'open egraph', 'open A-graph', 'what is agraf']) expect(fixTranscript(heard)).toMatch(/Aegraph$/)
    expect(fixTranscript('what does Aegraph do')).toBe('what does Aegraph do')
  })
  it('leaves "a graph" alone — it is usually a request for one', () => {
    expect(fixTranscript('show me a graph of the people')).toBe('show me a graph of the people')
    expect(fixTranscript('draw a graph')).toBe('draw a graph')
  })
})

describe('speakableSoFar', () => {
  it('hands over complete sentences as they arrive and the rest at the end', () => {
    let text = 'Filtered the graph to 84 people around Ada'
    expect(speakableSoFar(text, 0, false)).toEqual({ chunk: '', upTo: 0 })
    text += '. The three hubs are Babbage, Lovelace and Menabrea. Want me to'
    const first = speakableSoFar(text, 0, false)
    expect(first.chunk).toBe('Filtered the graph to 84 people around Ada. The three hubs are Babbage, Lovelace and Menabrea.')
    text += ' frame them?'
    expect(speakableSoFar(text, first.upTo, false)).toEqual({ chunk: '', upTo: first.upTo }) // no space after the ? yet
    expect(speakableSoFar(text, first.upTo, true)).toEqual({ chunk: ' Want me to frame them?', upTo: text.length })
  })
  it('does not break at a decimal point or a list number, and waits for enough text', () => {
    const text = 'The ratio is 3.5 and rising. Two things:\n1. Tags are '
    const r = speakableSoFar(text, 0, false)
    expect(r.chunk).toBe('The ratio is 3.5 and rising. Two things:\n')
    expect(speakableSoFar('Yes. No', 0, false)).toEqual({ chunk: '', upTo: 0 })
  })
  it('skips code fences', () => {
    const text = 'Here is the script that prints the number one. ```js\nconsole.log(1)\n``` It prints one, and then it stops. And more text follows here.'
    // A closed fence rides along in the chunk (the ear never gets it: speechText drops code blocks).
    const r1 = speakableSoFar(text, 0, false)
    expect(speechText(r1.chunk, { markdown: true })).toBe('Here is the script that prints the number one. It prints one, and then it stops.')
    expect(text.slice(r1.upTo).trim()).toBe('And more text follows here.')
    // An open fence: nothing past the sentence before it, until it closes.
    const open = 'Here is the script that prints the number one. ```js\nwhile (true) {}\n'
    expect(speakableSoFar(open, 0, false).chunk).toBe('Here is the script that prints the number one.')
    expect(speakableSoFar('Look: ```js\nwhile (true) {}', 0, false)).toEqual({ chunk: '', upTo: 0 })
  })
})

describe('isEcho', () => {
  const said = ['Filtered the graph to 84 people around Ada. The three hubs are Babbage, Lovelace and Menabrea.', 'Done.']
  it('recognises the speaker heard back, word drops and all', () => {
    expect(isEcho('the three hubs are Babbage Lovelace and Menabrea', said)).toBe(true)
    expect(isEcho('filtered the graph to 84 people around Ada the three hubs are', said)).toBe(true)
    expect(isEcho('filtered a graph to 84 people around Ada three hubs are babbage lovelace', said)).toBe(true)
  })
  it('lets the user through, even when they use the same words', () => {
    expect(isEcho('done', said)).toBe(false) // too short to be sure
    expect(isEcho('show me the graph', said)).toBe(false)
    expect(isEcho('frame Babbage and Lovelace', said)).toBe(false)
    expect(isEcho('what am I looking at', [])).toBe(false)
  })
  it('never takes an answer for an echo: option labels are short, and the question just read them out', () => {
    const question = ['Which one do you mean? 1: The map. 2: A new note. Choose in the assistant, or say one.']
    expect(isEcho('a new note', question)).toBe(false)
    expect(isEcho('the map', question)).toBe(false)
    expect(isEcho('the second one', question)).toBe(false)
  })
})

describe('typedAnswer', () => {
  it('takes a whole reply that is a yes, a no, or the button’s own word — and nothing longer', () => {
    for (const t of ['yes', 'Yes!', 'ok', 'go ahead', ' y e s '.replace(/ /g, '')]) expect(typedAnswer(t, 'Allow')).toBe(true)
    expect(typedAnswer('allow', 'Allow')).toBe(true)
    expect(typedAnswer('Save and go on', 'Save and go on')).toBe(true)
    for (const t of ['no', 'Cancel', 'nope.']) expect(typedAnswer(t, 'Allow')).toBe(false)
    // A message, not an answer: it goes to the chat as usual.
    for (const t of ['yes but read the other page', 'no, delete the other one', 'allow', '', '   ']) expect(typedAnswer(t, t === 'allow' ? undefined : 'Allow')).toBeUndefined()
  })
})
