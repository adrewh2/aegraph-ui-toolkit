import { EntityBrowser } from '../resources/EntityBrowser'

/** `/graph/layouts` — presentation collections: layouts, rendering configs, saved views. */
export function GraphCollectionsView() {
  return (
    <EntityBrowser
      category="project"
      layout="facets"
      basePath="/graph/layouts"
      title="Layouts & views"
      subtitle="Presentation state as entities: positions, legends, and saved arrangements that can be shared and exported like anything else."
      newActions={[
        { label: 'Layout', kind: 'layout' },
        { label: 'View', kind: 'view' },
      ]}
    />
  )
}
