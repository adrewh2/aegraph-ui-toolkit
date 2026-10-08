import { useMemo } from 'react'
import { useTypeRegistry } from '../../core/entity/hooks'
import { useExprSchema } from '../expr/ExprEditor'

/**
 * The data as a script sees it: the expression schema narrowed to what the
 * snapshot carries — types in use; project bookkeeping and type definitions
 * never reach a script. Built once per store data version; the editor's
 * completion and the Reference read it.
 */
export function useScriptSchema() {
  const registry = useTypeRegistry()
  const fullSchema = useExprSchema()
  return useMemo(() => {
    const keep = (t: string) => {
      const c = registry.categoryOf(t)
      return c !== 'project' && c !== 'schema'
    }
    const types = fullSchema.types.filter((t) => t.count > 0 && keep(t.type))
    const inUse = new Set(types.map((t) => t.type))
    return { ...fullSchema, types, properties: new Map([...fullSchema.properties].filter(([t]) => inUse.has(t))) }
  }, [fullSchema, registry])
}
