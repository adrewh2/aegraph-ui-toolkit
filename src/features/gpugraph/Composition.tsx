import { Fragment, type ReactNode } from 'react'
import type { EntityId } from '../../core/entity/types'
import { isLayoutKind, type BlockInfo, type BlockItem } from '../../core/slides/slides'

/**
 * A block drawn as DOM — what a composed slide's card and a block's plate
 * hold. Rows and columns lay their blocks out; flows, stats, lists and
 * timelines draw their boxes, each box marked with the entity it is bound to
 * (`data-ref`) and each leaf block with its id (`data-block`), which is how
 * the slide layer finds where on the card a beam or a composition line
 * leaves from (`measureCard`). Text from data is text: React elements, never
 * HTML.
 */
/** The most blocks one composition draws and how deep it nests: a slide is a handful; data asking for more is cut. */
const MAX_BLOCKS = 64
const MAX_DEPTH = 6

interface Planned {
  block: BlockInfo
  children: Planned[]
}

/**
 * What a composition draws, worked out before anything is drawn: each block once (as `leafBlocks` reads it), at most
 * `MAX_BLOCKS` of them, at most `MAX_DEPTH` deep. A block that contains itself, or rows whose children repeat one
 * block, would otherwise draw 2^depth copies — thirty such rows froze the tab.
 */
function plan(root: EntityId, blocks: Map<EntityId, BlockInfo>): Planned | null {
  const drawn = new Set<EntityId>()
  const walk = (id: EntityId, depth: number): Planned | null => {
    const b = blocks.get(id)
    if (!b || drawn.has(id) || drawn.size >= MAX_BLOCKS || depth > MAX_DEPTH) return null
    drawn.add(id)
    return { block: b, children: isLayoutKind(b.kind) ? b.children.map((c) => walk(c, depth + 1)).filter((x): x is Planned => !!x) : [] }
  }
  return walk(root, 0)
}

export function Composition({ id, blocks, labelOf }: { id: EntityId; blocks: Map<EntityId, BlockInfo>; labelOf: (id: EntityId) => string | undefined }): ReactNode {
  const p = plan(id, blocks)
  return p ? <Planned node={p} labelOf={labelOf} /> : null
}

function Planned({ node: { block: b, children }, labelOf }: { node: Planned; labelOf: (id: EntityId) => string | undefined }): ReactNode {
  if (isLayoutKind(b.kind))
    return (
      <div className={`gg-c gg-c--${b.kind}`}>
        {children.map((c) => (
          <Planned key={c.block.id} node={c} labelOf={labelOf} />
        ))}
      </div>
    )
  return (
    <div className={`gg-c gg-c--leaf gg-c--${b.kind}`} data-block={b.id} data-title={b.showTitle ? b.label : ''}>
      {b.showTitle && <div className="gg-c__title">{b.label}</div>}
      <Leaf block={b} labelOf={labelOf} />
    </div>
  )
}

/** A leaf block alone — a plate's whole content. */
export function Leaf({ block: b, labelOf }: { block: BlockInfo; labelOf: (id: EntityId) => string | undefined }): ReactNode {
  const text = (it: BlockItem) => it.label ?? (it.ref ? labelOf(it.ref) : undefined) ?? it.ref ?? ''
  const box = (it: BlockItem, k: number, cls: string, body: ReactNode) => (
    <div key={k} className={cls} data-ref={it.ref} data-label={text(it)} data-value={it.value ?? ''}>
      {body}
    </div>
  )
  switch (b.kind) {
    case 'flow':
      return (
        <div className="gg-flow">
          {b.items.map((it, k) => (
            <Fragment key={k}>
              {k > 0 && <span className="gg-flow__arrow">→</span>}
              {box(
                it,
                k,
                'gg-box',
                <>
                  {it.value && <span className="gg-box__value">{it.value}</span>}
                  <span className="gg-box__label">{text(it)}</span>
                  {it.note && <span className="gg-box__note">{it.note}</span>}
                </>,
              )}
            </Fragment>
          ))}
        </div>
      )
    case 'stats':
      return (
        <div className="gg-stats">
          {b.items.map((it, k) =>
            box(
              it,
              k,
              'gg-box gg-box--stat',
              <>
                <span className="gg-box__big">{it.value ?? '—'}</span>
                <span className="gg-box__label">{text(it)}</span>
                {it.note && <span className="gg-box__note">{it.note}</span>}
              </>,
            ),
          )}
        </div>
      )
    case 'list':
      return (
        <div className="gg-list">
          {b.items.map((it, k) =>
            box(
              it,
              k,
              'gg-list__item',
              <>
                <span className="gg-list__dot" />
                <span className="gg-box__label">{text(it)}</span>
                {it.value && <span className="gg-list__value">{it.value}</span>}
              </>,
            ),
          )}
        </div>
      )
    case 'timeline':
      return (
        <div className="gg-timeline">
          {b.items.map((it, k) =>
            box(
              it,
              k,
              'gg-timeline__item',
              <>
                <span className="gg-timeline__date">{it.value ?? ''}</span>
                <span className="gg-timeline__dot" />
                <span className="gg-box__label">{text(it)}</span>
              </>,
            ),
          )}
        </div>
      )
    default:
      return (
        <div className="gg-c__text">
          {b.text
            .split('\n')
            .filter((l) => l.trim())
            .map((l, k) => (
              <p key={k}>{l.replace(/\*\*/g, '')}</p>
            ))}
        </div>
      )
  }
}
