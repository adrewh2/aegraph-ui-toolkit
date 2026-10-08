import { PageHeader } from '../../components/Layout/PageHeader'
import type { ReactNode } from 'react'
import { CATEGORIES, CATEGORY_ORDER } from '../../core/entity/categories'
import { useEntityStore, useEntityTypes, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { BASE_FIELDS, type FieldDef } from '../../core/entity/schema'
import './ModelView.css'

/** A readable rendering of the information model: primitives first, then registered types. */
export function ModelView({ embedded = false }: { embedded?: boolean } = {}) {
  const store = useEntityStore()
  useStoreVersion(store)
  const types = useEntityTypes()
  const counts = store.countByType()
  const registry = useTypeRegistry()

  return (
    <div className="model">
      {!embedded && <PageHeader title="Data model" subtitle="A small set of boring primitives. Types add structure only where it's useful." />}

      <section className="model__section">
        <h2>Primitives</h2>
        <div className="model__grid">
          <Card title="Entity" hint="kind: entity">
            The general-purpose unit: <code>id</code>, <code>type</code>, <code>label</code>, <code>tags[]</code>, <code>data{'{}'}</code>,{' '}
            <code>meta</code>. Starts as little more than an id and some data.
          </Card>
          <Card title="Relationship" hint="kind: relationship">
            An entity with a <code>source</code> and <code>target</code> ref. Because it's an entity it can be typed, tagged, annotated, and
            described.
          </Card>
          <Card title="Ref + Selector" hint="addressability">
            <code>{'{ id, selector? }'}</code>. Selectors point inside an entity — a text quote, a character range, an image region, a time
            range — so a paragraph or a highlight is addressable without becoming its own entity.
          </Card>
          <Card title="Tags" hint="flat, many-to-many">
            Plain strings on any entity. Optional per-tag metadata (color, description) lives beside the graph, not on it.
          </Card>
          <Card title="Type" hint="single-valued">
            One semantic type per entity. A registered definition (below) adds fields, validation, and presentation; an unregistered type
            still works everywhere.
          </Card>
          <Card title="Document" hint="aegraph/v1">
            The exchange format: <code>{'{ $schema, entities[], tags[] }'}</code>. Export any view, import into any store.
          </Card>
        </div>
      </section>

      <section className="model__section">
        <h2>Categories</h2>
        <p className="muted">A category is a property of a type — how its data is used — never of an entity. It decides where things are browsed. The test for placing a type is what opening one of its entities does.</p>
        <div className="model__grid">
          {CATEGORY_ORDER.map((c) => (
            <Card key={c} title={CATEGORIES[c].label} hint={`${registry.inCategory(c).length} types · ${registry.countInCategory(c).toLocaleString()} entities`}>
              {CATEGORIES[c].description}
              <div className="muted" style={{ marginTop: 6 }}>
                <em>{CATEGORIES[c].test}</em>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="model__section">
        <h2>Base fields</h2>
        <p className="muted">Every entity carries these regardless of type.</p>
        <FieldTable fields={BASE_FIELDS} />
      </section>

      <section className="model__section">
        <h2>Registered types</h2>
        <p className="muted">
          Defined in code. Types defined from data (as <code>schema:type</code> entities) or merely inferred are listed on the{' '}
          <a href="/entities?category=types">Types</a> page.
        </p>
        <div className="model__types">
          {types.map((t) => {
            const Icon = t.icon
            return (
              <div key={t.type} className="model__type">
                <div className="model__type-head">
                  <span className="model__type-icon" style={{ background: t.color ? `${t.color}22` : 'var(--surface-2)', color: t.color }}>
                    {Icon && <Icon size={16} />}
                  </span>
                  <div>
                    <div className="model__type-name">
                      {t.label} <code>{t.type}</code> <span className="badge">{t.category}</span>
                    </div>
                    {t.description && <div className="muted">{t.description}</div>}
                  </div>
                  <span className="count" style={{ marginLeft: 'auto' }}>
                    {counts.get(t.type) ?? 0}
                  </span>
                </div>
                {t.fields.length > 0 ? (
                  <FieldTable fields={t.fields} />
                ) : (
                  <p className="faint" style={{ margin: '8px 0 0' }}>
                    No type-specific fields.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function Card({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="model__card">
      <div className="model__card-title">
        {title} <span className="faint">{hint}</span>
      </div>
      <div className="model__card-body">{children}</div>
    </div>
  )
}

function FieldTable({ fields }: { fields: FieldDef[] }) {
  return (
    <table className="model__fields">
      <thead>
        <tr>
          <th>Key</th>
          <th>Label</th>
          <th>Kind</th>
          <th>Flags</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.key}>
            <td>
              <code>{f.key}</code>
            </td>
            <td>{f.label}</td>
            <td>
              <span className="badge">{f.kind}</span>
            </td>
            <td className="faint">{[f.required && 'required', f.editable && 'editable', f.hidden && 'hidden by default'].filter(Boolean).join(' · ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
