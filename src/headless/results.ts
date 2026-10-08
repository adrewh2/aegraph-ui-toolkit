import { frame } from '../../mcp/frame.mjs'

/**
 * What a tool hands the MCP client, as the bridge hands it (`mcp/frame.mjs`): the workspace's text — entity labels,
 * documents, a page an import fetched, a bundle someone sent — can carry words written to steer a model, and the
 * model on the other end is a developer's Claude Code with their shell. So every text block, a tool's error included
 * (an error quotes what it was given), goes over inside one `<untrusted_data tool="…">` envelope the text cannot
 * close, and the server's instructions (`HEADLESS_INSTRUCTIONS`) say nothing inside it is an instruction.
 */

type TextBlock = { type: 'text'; text: string }

/** A tool's result → MCP content, every text block framed. Headless there are no images to fetch: a picture would need a renderer. */
export function toolContent(tool: string, result: unknown): TextBlock[] {
  const framed = (text: string): TextBlock => ({ type: 'text', text: frame(tool, text) })
  if (typeof result === 'string') return [framed(result)]
  if (Array.isArray(result)) {
    const out = result.map((b) => {
      const block = b as { type?: string; text?: string }
      if (block?.type === 'text' && typeof block.text === 'string') return framed(block.text)
      if (block?.type === 'image') return framed('[an image; the headless engine has no renderer]')
      return framed(JSON.stringify(b))
    })
    if (out.length) return out
  }
  return [framed(JSON.stringify(result) ?? '')]
}

/** A tool's error, framed like its results: the message is the tool's, and may quote the data it choked on. */
export const toolError = (tool: string, message: string) => ({ content: [{ type: 'text' as const, text: frame(tool, message) }], isError: true })

/** An error of the server's own (an unknown tool name): ours, not the workspace's, so not framed. */
export const serverError = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true })
