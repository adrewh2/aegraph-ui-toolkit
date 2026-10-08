import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { describeAccess, resolveEngine } from '../voice/access'
import { getVoiceSettings } from '../voice/settings'
import { voice } from '../voice/voice'
import { json } from './toolkit'
import type { AppHost } from './tools'

/**
 * Talking with the user: a question with options they pick from (in the
 * assistant, or by voice when it is on), and the speaker and microphone
 * themselves — so a reply can be read aloud, and voice control can be
 * turned on or off, from any tool runner.
 */
export function createVoiceTools(host: AppHost) {
  const askUser = betaTool({
    name: 'ask_user',
    description:
      "Put a question with options to the user and wait for their pick. The question shows as a card in the assistant (opening it if closed) and, when voice control is on, is read aloud with the options — the user answers by clicking or by saying an option. Use it when a request is ambiguous in a way that changes the work (which document, which reading, where something goes), with two to five short options; don't ask for what the context or a lookup already answers. Returns the chosen option, or `declined: true` when the user picks none.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One sentence, as it will be read aloud.' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6, description: 'Short labels (a few words each); the answer is one of them verbatim.' },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    } as const,
    run: async ({ question, options }) => {
      if (!host.choose) throw new Error('This runner cannot ask the user questions; decide from the context, or say what you would need to know.')
      const labels = options.map((o) => o.trim()).filter(Boolean)
      if (labels.length < 2) throw new Error('ask_user needs at least two options.')
      const answer = await host.choose(question.trim(), labels)
      return json(answer === null ? { declined: true, question } : { answer, question })
    },
  })

  const voiceTool = betaTool({
    name: 'voice',
    description:
      'The speaker and the microphone. `say` reads `text` aloud (Markdown is flattened; long text is cut at a sentence around 1200 characters — pass the passage you mean, not a whole document). `listen` turns voice control on after the user says yes in the app (for this page only; it is not remembered across reloads): the app listens continuously and every phrase goes to the assistant as a message, replies are read back, and questions are put by voice. `stop` turns it off; `hush` stops speaking without turning it off. `status` reports what the browser supports, which listener and speaker are set (the browser\'s own, or OpenAI transcription / neural voice, chosen in the assistant settings) and the current state (listening / thinking / speaking, the last phrase heard, the last thing said).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'say', 'listen', 'stop', 'hush'] },
        text: { type: 'string', description: 'For `say`: what to read aloud.' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, text }) => {
      const status = () => {
        const s = voice.getState()
        const vs = getVoiceSettings()
        return { canListen: s.canListen, canSpeak: s.canSpeak, enabled: s.enabled, status: s.status, listener: resolveEngine(vs.listener) === 'openai' ? vs.openaiSttModel : 'browser', speaker: resolveEngine(vs.speaker) === 'openai' ? `openai:${vs.openaiVoice}` : vs.browserVoice || 'browser:best', openai: describeAccess(), pauseMs: vs.pauseMs, heard: s.heard, said: s.said, ...(s.error ? { error: s.error } : {}), ...(s.question ? { waitingFor: s.question } : {}) }
      }
      if (action === 'status') return json(status())
      if (action === 'say') {
        if (!text?.trim()) throw new Error('say needs text.')
        if (!voice.getState().canSpeak) throw new Error('This browser cannot speak (no speechSynthesis).')
        await voice.speak(text, { markdown: true })
        return json({ said: voice.getState().said })
      }
      if (action === 'hush') {
        voice.hush()
        return json(status())
      }
      if (action === 'listen') {
        if (!voice.getState().canListen) throw new Error('This browser cannot listen (no SpeechRecognition). Chrome and Safari can.')
        if (voice.getState().enabled) return json(status())
        // The microphone is the user's to turn on: whoever is calling, they are asked, and a yes lasts this page only.
        if (!(await host.confirm('Turn the microphone on? The app listens until voice is turned off, and what you say goes to the assistant as messages. It stays on for this page only.', { yes: 'Turn on' }))) throw new Error('The user kept the microphone off.')
        voice.start({ remember: false })
        return json(status())
      }
      voice.stop()
      return json(status())
    },
  })

  return [askUser, voiceTool]
}
