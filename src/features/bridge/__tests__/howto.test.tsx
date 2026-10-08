import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../../components/ui/useToast'
import { EDITION, localSetupCommand } from '../../../app/edition'
import { BridgeHowTo } from '../BridgeStatus'

/** The Claude Code dialog's instructions: one command to copy, for this edition's own repository. */
const html = () => renderToString(<ToastProvider><BridgeHowTo /></ToastProvider>)
const at = (hostname: string) => vi.stubGlobal('location', { hostname, origin: `https://${hostname}`, pathname: '/', search: '' })

describe('connecting Claude Code', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is one command for this edition: clone its repository, install, and start the app (or Claude Code) in it', () => {
    expect(localSetupCommand('claude')).toBe(`git clone ${EDITION.repo}.git && cd ${EDITION.name} && npm install && claude`)
    expect(localSetupCommand('npm run dev')).toBe(`git clone ${EDITION.repo}.git && cd ${EDITION.name} && npm install && npm run dev`)
    expect(EDITION.repo).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/)
    expect(EDITION.repo.endsWith(`/${EDITION.name}`)).toBe(true)
  })

  it('on a deployed site, offers one thing: the command that runs the app on your machine — never one that connects Claude Code', () => {
    at('aegraph.example')
    const out = html()
    expect(out).toContain(localSetupCommand('npm run dev').replace(/&/g, '&amp;'))
    expect(out).not.toContain(localSetupCommand('claude').replace(/&/g, '&amp;'))
    expect(out).not.toContain('>claude<')
    expect(out).toContain('Run the app on your machine')
    expect(out).toContain('Copy')
  })

  it('on this machine’s own server, only Claude Code in the checkout', () => {
    at('localhost')
    const out = html()
    expect(out).toContain('>claude<')
    expect(out).not.toContain('git clone')
  })
})
