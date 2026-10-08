/**
 * The diagram editor: a self-contained drawing canvas (Excalidraw) behind
 * one component and a text document. Nothing in here knows about
 * entities, stores or routes — the app hands it a scene string and gets a
 * scene string back. Keep it that way; it is what makes the editor
 * swappable and the app simple.
 *
 * The canvas is heavy, so this entry point loads it on demand:
 *
 *   <DiagramEditor source={text} onChange={setText} />   (lazy; wrap in Suspense)
 *   EMPTY_SCENE / isScene / sceneSummary                   the document, no dependencies
 *   sceneToSvg / sceneToPng                                exports, load the editor on first use
 */
import { lazy } from 'react'
import type { DiagramEditorHandle, DiagramEditorProps } from './DiagramEditor'

export type { DiagramEditorHandle, DiagramEditorProps }
export { EMPTY_SCENE, isScene, sceneSummary } from './document'

export const DiagramEditor = lazy(() => import('./DiagramEditor').then((m) => ({ default: m.DiagramEditor })))

export const sceneToSvg = async (...args: Parameters<typeof import('./export').sceneToSvg>) => (await import('./export')).sceneToSvg(...args)
export const sceneToPng = async (...args: Parameters<typeof import('./export').sceneToPng>) => (await import('./export')).sceneToPng(...args)
