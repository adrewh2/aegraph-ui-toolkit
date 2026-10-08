import { Link } from 'react-router-dom'
import { CircleSlash } from 'lucide-react'
import { turnedOff, type FeatureName } from '../../app/features'
import './FeatureOff.css'

/** What stays when the feature is off: its data, and where to find it. */
const STILL_HERE: Record<FeatureName, string> = {
  maps: 'Maps, places, paths and areas stay in the Library: browse them in Entities.',
  globe: 'The same places are on the flat map.',
  videos: 'Videos stay in the Library: browse them in Entities.',
  audio: 'Tracks and episodes stay in the Library: browse them in Entities.',
}

/**
 * What a page of a feature this deployment turned off (`app/features.ts`) shows instead of loading the feature's
 * code: a top-level route, a workstation tab, a link from elsewhere, a bundle's opening route all land here — never on
 * a blank pane. `to` is an address that does work (the flat map for the globe).
 */
export function FeatureOff({ feature, to }: { feature: FeatureName; to?: string }) {
  return (
    <div className="feature-off" role="status" data-feature-off={feature}>
      <CircleSlash size={22} aria-hidden />
      <h1 className="feature-off__title">{turnedOff(feature)}</h1>
      <p className="muted">{STILL_HERE[feature]}</p>
      <Link className="btn btn--sm" to={to ?? '/entities'}>
        {to ? 'Open the flat map' : 'Open Entities'}
      </Link>
    </div>
  )
}
