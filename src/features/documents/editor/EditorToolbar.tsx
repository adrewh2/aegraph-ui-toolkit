import { useEditorState, type Editor } from '@tiptap/react'
import {
  Bold,
  ChevronDown,
  Code,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Underline,
  Undo2,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Menu, Popover, type MenuItem } from '../../../components/ui/Menu'

interface Props {
  editor: Editor
  onAnnotate: () => void
}

const HEADINGS = [
  { label: 'Text', level: 0 },
  { label: 'Heading 1', level: 1 },
  { label: 'Heading 2', level: 2 },
  { label: 'Heading 3', level: 3 },
] as const

export function EditorToolbar({ editor, onAnnotate }: Props) {
  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
      heading: (editor.getAttributes('heading').level as number | undefined) ?? 0,
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      link: editor.isActive('link'),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      task: editor.isActive('taskList'),
      quote: editor.isActive('blockquote'),
      codeBlock: editor.isActive('codeBlock'),
      hasSelection: !editor.state.selection.empty,
      inTable: editor.isActive('table'),
    }),
  })
  const [headingMenu, setHeadingMenu] = useState<{ x: number; y: number } | null>(null)
  const [urlPop, setUrlPop] = useState<{ kind: 'link' | 'image'; anchor: DOMRect } | null>(null)
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number } | null>(null)

  const chain = () => editor.chain().focus()

  const tableItems: MenuItem[] = s.inTable
    ? [
        { kind: 'item', label: 'Add row below', onSelect: () => chain().addRowAfter().run() },
        { kind: 'item', label: 'Add column after', onSelect: () => chain().addColumnAfter().run() },
        { kind: 'item', label: 'Delete row', onSelect: () => chain().deleteRow().run() },
        { kind: 'item', label: 'Delete column', onSelect: () => chain().deleteColumn().run() },
        { kind: 'item', label: 'Toggle header row', onSelect: () => chain().toggleHeaderRow().run() },
        { kind: 'sep' },
        { kind: 'item', label: 'Delete table', danger: true, onSelect: () => chain().deleteTable().run() },
      ]
    : [
        { kind: 'item', label: 'Insert 2×2 table', onSelect: () => chain().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
        { kind: 'item', label: 'Insert 3×3 table', onSelect: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
        { kind: 'item', label: 'Insert 4×3 table', onSelect: () => chain().insertTable({ rows: 4, cols: 3, withHeaderRow: true }).run() },
      ]

  return (
    <div className="tb" role="toolbar" aria-label="Formatting">
      <Tool title="Undo ⌘Z" disabled={!s.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 size={15} />
      </Tool>
      <Tool title="Redo ⇧⌘Z" disabled={!s.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 size={15} />
      </Tool>
      <span className="tb__sep" />
      <button className="tb__btn tb__heading" onMouseDown={(e) => e.preventDefault()} onClick={(e) => setHeadingMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })} title="Text style">
        <span className="tb__heading-label">{s.heading ? `H${s.heading}` : 'Text'}</span>
        <ChevronDown size={13} />
      </button>
      <span className="tb__sep" />
      <Tool title="Bold ⌘B" active={s.bold} onClick={() => chain().toggleBold().run()}>
        <Bold size={15} />
      </Tool>
      <Tool title="Italic ⌘I" active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic size={15} />
      </Tool>
      <Tool title="Underline ⌘U" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
        <Underline size={15} />
      </Tool>
      <Tool title="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough size={15} />
      </Tool>
      <Tool title="Inline code ⌘E" active={s.code} onClick={() => chain().toggleCode().run()}>
        <Code size={15} />
      </Tool>
      <Tool
        title="Link ⌘K"
        active={s.link}
        onClick={(e) => {
          if (s.link) chain().unsetLink().run()
          else setUrlPop({ kind: 'link', anchor: e.currentTarget.getBoundingClientRect() })
        }}
      >
        <LinkIcon size={15} />
      </Tool>
      <span className="tb__sep" />
      <Tool title="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
        <List size={15} />
      </Tool>
      <Tool title="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={15} />
      </Tool>
      <Tool title="Checklist" active={s.task} onClick={() => chain().toggleTaskList().run()}>
        <ListChecks size={15} />
      </Tool>
      <Tool title="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
        <Quote size={15} />
      </Tool>
      <span className="tb__sep" />
      <Tool title={s.inTable ? 'Table…' : 'Insert table'} active={s.inTable} onClick={(e) => setTableMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })}>
        <TableIcon size={15} />
      </Tool>
      <Tool title="Code block" active={s.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>
        <SquareCode size={15} />
      </Tool>
      <Tool title="Image from URL" onClick={(e) => setUrlPop({ kind: 'image', anchor: e.currentTarget.getBoundingClientRect() })}>
        <ImageIcon size={15} />
      </Tool>
      <Tool title="Divider" onClick={() => chain().setHorizontalRule().run()}>
        <Minus size={15} />
      </Tool>
      <span className="tb__sep" />
      <button className="btn btn--sm tb__annotate" disabled={!s.hasSelection} onMouseDown={(e) => e.preventDefault()} onClick={onAnnotate} title="Create an annotation from the selection">
        <Highlighter size={13} /> Annotate
      </button>

      {headingMenu && (
        <Menu
          x={headingMenu.x}
          y={headingMenu.y}
          onClose={() => setHeadingMenu(null)}
          items={HEADINGS.map((h) => ({
            kind: 'item',
            label: h.label,
            onSelect: () => (h.level === 0 ? chain().setParagraph().run() : chain().toggleHeading({ level: h.level }).run()),
          }))}
        />
      )}
      {tableMenu && <Menu x={tableMenu.x} y={tableMenu.y} items={tableItems} onClose={() => setTableMenu(null)} />}
      {urlPop && (
        <UrlPopover
          kind={urlPop.kind}
          anchor={urlPop.anchor}
          initial={urlPop.kind === 'link' ? (editor.getAttributes('link').href as string | undefined) : undefined}
          onClose={() => setUrlPop(null)}
          onSubmit={(url) => {
            if (urlPop.kind === 'link') {
              if (editor.state.selection.empty) chain().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
              else chain().extendMarkRange('link').setLink({ href: url }).run()
            } else chain().setImage({ src: url }).run()
            setUrlPop(null)
          }}
        />
      )}
    </div>
  )
}

function Tool({ title, active, disabled, onClick, children }: { title: string; active?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <button className={`tb__btn ${active ? 'is-active' : ''}`} title={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  )
}

function UrlPopover({ kind, anchor, initial, onClose, onSubmit }: { kind: 'link' | 'image'; anchor: DOMRect; initial?: string; onClose: () => void; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState(initial ?? '')
  const submit = () => {
    const u = url.trim()
    if (!u) return
    onSubmit(/^(https?:|mailto:|\/|#)/i.test(u) ? u : `https://${u}`)
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={340}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          autoFocus
          placeholder={kind === 'link' ? 'https://… or paste a link' : 'https://…/image.png'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
        />
        <button className="btn btn--primary" onClick={submit} disabled={!url.trim()}>
          {kind === 'link' ? 'Link' : 'Insert'}
        </button>
      </div>
    </Popover>
  )
}
