import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import { readScene } from './scene'

/** The scene as standalone SVG markup (fonts embedded), for thumbnails and downloads. */
export async function sceneToSvg(source: string, opts: { background?: boolean; padding?: number } = {}): Promise<string> {
  const s = readScene(source)
  const svg = await exportToSvg({ elements: s.elements, appState: { ...s.appState, exportBackground: opts.background ?? true, exportWithDarkMode: false, exportEmbedScene: false }, files: s.files, exportPadding: opts.padding ?? 16 })
  return svg.outerHTML
}

/** The scene as a PNG blob. */
export async function sceneToPng(source: string, opts: { scale?: number; background?: boolean } = {}): Promise<Blob> {
  const s = readScene(source)
  return exportToBlob({ elements: s.elements, appState: { ...s.appState, exportBackground: opts.background ?? true, exportWithDarkMode: false }, files: s.files, mimeType: 'image/png', getDimensions: (w: number, h: number) => ({ width: w * (opts.scale ?? 2), height: h * (opts.scale ?? 2), scale: opts.scale ?? 2 }) })
}
