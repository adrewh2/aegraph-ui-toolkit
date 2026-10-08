/** Whether a key press belongs to something other than a view's picture: a field, a dialog, a menu. */
export function keyIsElsewhere(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return true
  if (el?.closest?.('[role="menu"], [role="listbox"], [role="slider"], [role="tablist"]')) return true
  return !!document.querySelector('.dialog-backdrop')
}
