import { DiagramWorkbench, useDiagramEditor } from './DiagramWorkbench'
import type { DiagramEntity } from './diagrams'

/** View, edit, and convert the diagram in place — the page's workbench in its compact form. */
export default function DiagramEmbed({ diagram }: { diagram: DiagramEntity }) {
  const editor = useDiagramEditor(diagram)
  return <DiagramWorkbench key={diagram.id} diagram={diagram} editor={editor} compact />
}
