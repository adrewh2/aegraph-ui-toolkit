import { createEntity } from '../../entity/entity'
import type { EntityStore } from '../../entity/store'
import type { AnyEntity } from '../../entity/types'

/** A diagram entity without the feature layer (which owns createDiagram). */
export function createDiagramEntityForTest(store: EntityStore, label: string, source: string, format: 'dot' | 'mermaid' | 'excalidraw'): AnyEntity {
  const e = createEntity({ type: 'diagram', label, data: { source, format } })
  store.upsert(e)
  return e
}
