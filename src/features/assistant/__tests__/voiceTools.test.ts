import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { voice } from '../../voice/voice'
import { createVoiceTools } from '../voiceTools'
import type { AppHost } from '../tools'

const run = (tools: BetaRunnableTool[], name: string) => {
  const t = tools.find((x) => x.name === name)!
  return async (input: unknown) => {
    const r = await t.run(t.parse(input))
    return JSON.parse(typeof r === 'string' ? r : JSON.stringify(r)) as Record<string, unknown>
  }
}

const host = (choose?: AppHost['choose']): AppHost => ({ store: new EntityStore(), navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true, choose })

describe('ask_user', () => {
  it('puts the question and its options to the host and returns the pick', async () => {
    const asked: { message: string; options: string[] }[] = []
    const tools = createVoiceTools(host(async (message, options) => (asked.push({ message, options }), options[1])))
    const r = await run(tools, 'ask_user')({ question: 'Which one? ', options: ['The map', ' A new note ', ''] })
    expect(asked).toEqual([{ message: 'Which one?', options: ['The map', 'A new note'] }])
    expect(r).toEqual({ answer: 'A new note', question: 'Which one? ' })
  })

  it('reports a decline', async () => {
    const tools = createVoiceTools(host(async () => null))
    expect(await run(tools, 'ask_user')({ question: 'Which?', options: ['a', 'b'] })).toEqual({ declined: true, question: 'Which?' })
  })

  it('fails usefully when the runner cannot ask, or with one option', async () => {
    await expect(run(createVoiceTools(host()), 'ask_user')({ question: 'Which?', options: ['a', 'b'] })).rejects.toThrow(/cannot ask/)
    await expect(run(createVoiceTools(host(async () => 'a')), 'ask_user')({ question: 'Which?', options: ['a', ' '] })).rejects.toThrow(/at least two/)
  })
})

describe('voice tool', () => {
  it('reports what this environment supports (nothing, under node)', async () => {
    const r = await run(createVoiceTools(host()), 'voice')({ action: 'status' })
    expect(r).toMatchObject({ canListen: false, canSpeak: false, enabled: false, status: 'off' })
  })

  it('refuses to speak or listen where the browser cannot', async () => {
    const tools = createVoiceTools(host())
    await expect(run(tools, 'voice')({ action: 'say', text: 'hello' })).rejects.toThrow(/cannot speak/)
    await expect(run(tools, 'voice')({ action: 'say' })).rejects.toThrow(/needs text/)
    await expect(run(tools, 'voice')({ action: 'listen' })).rejects.toThrow(/cannot listen/)
    expect((await run(tools, 'voice')({ action: 'stop' })).enabled).toBe(false)
    expect(voice.getState().enabled).toBe(false)
  })
})
