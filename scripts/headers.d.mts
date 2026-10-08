import type { Plugin } from 'vite'
export interface HeaderRule { source: string; headers: { key: string; value: string }[] }
export function headerRules(root?: string): HeaderRule[]
export function headersFor(path: string, rules?: HeaderRule[]): Record<string, string>
export function scriptHash(text: string): string
export function withSources(policy: string, directive: string, sources: string[]): string
export function securityHeaders(options?: { devInlineScripts?: string[] }): Plugin
