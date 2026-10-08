import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { oneLineLabel } from '../../core/entity/entity'
import { forgetMemory, memoryLinesMatching, noteMemory, readMemory, rewriteMemory } from './memory'
import { json } from './toolkit'
import type { AppHost } from './tools'

/**
 * The assistant's memory for the open project: read it whole, add a note,
 * forget one, or rewrite it. The notes reach every turn through the
 * context's <assistant_memory> block, so this is how something the user
 * says once stays known.
 */
export function createMemoryTools(host: AppHost) {
  const { store } = host
  const memory = betaTool({
    name: 'memory',
    description:
      "What you remember about this project, kept as the 'Assistant memory' document (tag assistant:memory) in the project and shown in every turn's <assistant_memory>. `note` adds one short dated line, after the user confirms it — use it when the user states a preference, a convention, what they are working on, or asks you to remember something; `forget` drops the lines containing `text` (more than one is shown to the user to confirm first); `rewrite` replaces the whole memory with `text` (to tidy it; the user is shown before and after and confirms); `read` returns it whole (the context carries the first 4000 characters). Keep notes short and factual; never store secrets.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'note', 'forget', 'rewrite'] },
        text: { type: 'string', description: 'The note to add, the words to forget by, or the new memory.' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, text }) => {
      if (action === 'read') return json({ memory: readMemory(store), chars: readMemory(store).length })
      if (!text?.trim()) throw new Error(`${action} needs text.`)
      if (action === 'note') {
        // A note is read into every later turn as the assistant's own words — what a page or a bundle the model just
        // read would most like to plant. So the user sees it, as it will be kept, before it is.
        if (!(await host.confirm(`Remember this for the project? The assistant reads its memory at the start of every turn.\n\n${oneLineLabel(text, 600)}`, { yes: 'Remember' }))) throw new Error('The user did not want that remembered.')
        const { entity, added } = noteMemory(store, text)
        return json({ added, id: entity.id, memory: readMemory(store) })
      }
      if (action === 'forget') {
        // One line goes as asked; more than one — a word as common as ":" matches them all — is shown first.
        const going = memoryLinesMatching(store, text)
        if (going.length > 1 && !(await host.confirm(`Forget ${going.length} lines of the assistant's memory?\n\n${going.slice(0, 12).map((l) => oneLineLabel(l, 160)).join('\n')}${going.length > 12 ? `\n…and ${going.length - 12} more` : ''}`, { yes: 'Forget', danger: true }))) throw new Error('The user kept the memory as it was.')
        const { entity, removed } = forgetMemory(store, text)
        return json({ removed, id: entity.id, memory: readMemory(store) })
      }
      const current = readMemory(store)
      if (current && !(await host.confirm(`Replace the assistant's memory for this project?\n\nNow:\n${current.slice(0, 600)}\n\nAfter:\n${text.trim().slice(0, 600)}`, { yes: 'Replace', danger: true }))) throw new Error('The user kept the memory as it was.')
      const entity = rewriteMemory(store, text)
      return json({ id: entity.id, memory: readMemory(store) })
    },
  })
  return [memory]
}
