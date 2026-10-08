import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { readScene, sceneVersion, writeScene } from './scene'
import './DiagramEditor.css'

export interface DiagramEditorProps {
  /** The scene file as text (see `scene.ts`). An empty or unreadable value is an empty canvas. */
  source: string
  /** Called, debounced, with the scene as text whenever an element changes. Not called for pure view changes (pan, zoom, selection). */
  onChange?: (source: string) => void
  /** View only: no tools, no edits. */
  readOnly?: boolean
  theme?: 'light' | 'dark'
  /** Debounce for `onChange`, ms. */
  debounce?: number
  /** Excalidraw's imperative API once mounted, for callers that export or focus. */
  onApi?: (api: ExcalidrawImperativeAPI) => void
  className?: string
}

/** What the canvas offers the page beyond its props. */
export interface DiagramEditorHandle {
  /** The scene as text right now, emitting it through `onChange` if an edit was still waiting on the debounce. Undefined when nothing is pending. */
  flush(): string | undefined
}

/**
 * The drawing canvas: Excalidraw, wrapped so the rest of the app sees one
 * controlled text value. Edits flow out through `onChange`; a new `source`
 * that the editor did not itself produce flows back in as a scene update,
 * so an entity edited elsewhere (another pane, the assistant) shows up
 * without remounting.
 */
export const DiagramEditor = forwardRef<DiagramEditorHandle, DiagramEditorProps>(function DiagramEditor({ source, onChange, readOnly, theme = 'light', debounce = 400, onApi, className }, ref) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  /** What the last `onChange` from Excalidraw carried, until it has been emitted. */
  const pending = useRef<{ elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null>(null)
  const emitPending = () => {
    const p = pending.current
    if (!p) return undefined
    pending.current = null
    clearTimeout(timer.current)
    const text = writeScene(p.elements, p.appState, p.files)
    if (text === seen.current) return text
    seen.current = text
    onChangeRef.current?.(text)
    return text
  }
  useImperativeHandle(ref, () => ({ flush: emitPending }))
  /** The last text this editor emitted or was given — a `source` equal to it needs no scene update. */
  const seen = useRef(source)
  const lastVersion = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // The initial scene is read once; later sources arrive through updateScene.
  const initial = useMemo(() => {
    const s = readScene(source)
    return { elements: s.elements, appState: { ...s.appState, collaborators: new Map() }, files: s.files, scrollToContent: true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * A drawing that has just arrived is shown whole, and the hand is the tool: opening a diagram is looking at it,
   * not selecting things. After the canvas has measured itself, so the fit is to the real viewport.
   */
  const settleView = (a: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[]) => {
    requestAnimationFrame(() => {
      if (elements.length) a.scrollToContent(elements, { fitToContent: true, animate: false })
      if (!readOnly) a.setActiveTool({ type: 'hand' })
    })
  }

  /** Put a source the editor did not produce onto the canvas. */
  const applySource = (text: string) => {
    if (text === seen.current || !api.current) return
    seen.current = text
    pending.current = null
    clearTimeout(timer.current)
    const s = readScene(text)
    lastVersion.current = sceneVersion(s.elements)
    api.current.updateScene({ elements: s.elements, appState: s.appState as never })
    if (Object.keys(s.files).length) api.current.addFiles(Object.values(s.files))
    settleView(api.current, s.elements)
  }
  const sourceRef = useRef(source)
  sourceRef.current = source
  useEffect(() => applySource(source), [source]) // eslint-disable-line react-hooks/exhaustive-deps

  // Unmounting (a format switch, leaving the page) must not lose the last edit.
  useEffect(() => () => void emitPending(), [])

  return (
    <div className={`diagram-editor ${className ?? ''}`}>
      <Excalidraw
        initialData={initial}
        theme={theme}
        viewModeEnabled={readOnly}
        // A drawing is data, and an embeddable is a frame of someone else's page shown the moment the drawing is —
        // Excalidraw's default list frames YouTube, Figma, GitHub gists and more, whatever the Third-party
        // services switch says. None is framed: the element stays, with its link, and nothing loads.
        validateEmbeddable={false}
        excalidrawAPI={(a) => {
          api.current = a
          onApi?.(a)
          // A source that changed before the canvas was ready is applied now (and fitted by applySource); else fit the initial scene.
          if (sourceRef.current === seen.current) settleView(a, initial.elements)
          else applySource(sourceRef.current)
        }}
        onChange={(elements, appState, files) => {
          if (readOnly) return
          const v = sceneVersion(elements)
          if (v === lastVersion.current) return
          lastVersion.current = v
          pending.current = { elements, appState, files }
          clearTimeout(timer.current)
          timer.current = setTimeout(emitPending, debounce)
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true, clearCanvas: true, changeViewBackgroundColor: true, toggleTheme: false } }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
        {!readOnly && (
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>An empty canvas</WelcomeScreen.Center.Heading>
              <WelcomeScreen.Hints.ToolbarHint />
              <WelcomeScreen.Hints.HelpHint />
            </WelcomeScreen.Center>
          </WelcomeScreen>
        )}
      </Excalidraw>
    </div>
  )
})
