import { useState } from 'react'

export type MediaLayout = 'grid' | 'list'

/** Grid or list, remembered per index in localStorage. */
export function useMediaLayout(key: string): [MediaLayout, (l: MediaLayout) => void] {
  const [layout, set] = useState<MediaLayout>(() => (read(key) === 'list' ? 'list' : 'grid'))
  return [layout, (l) => (set(l), write(key, l))]
}

function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* ignore */
  }
}
