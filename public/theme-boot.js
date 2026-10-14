// The colour theme before the first paint, so a dark theme never flashes light while the app loads: the same
// choice `src/app/theme.ts › resolveTheme` makes, read from the same setting (`aegraph:account:settings` › theme).
// A file of its own rather than an inline script: the site's script-src is 'self'.
;(function () {
  var themes = ['paper', 'dark', 'midnight', 'contrast']
  var dark = { dark: 1, midnight: 1 }
  var pref = 'system'
  try {
    var s = JSON.parse(localStorage.getItem('aegraph:account:settings') || '{}')
    if (s && (s.theme === 'system' || themes.indexOf(s.theme) >= 0)) pref = s.theme
  } catch {
    /* no storage: the system's */
  }
  var id = pref
  if (pref === 'system') id = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'paper'
  var root = document.documentElement
  root.setAttribute('data-theme', id)
  root.setAttribute('data-scheme', dark[id] ? 'dark' : 'light')
  root.style.colorScheme = dark[id] ? 'dark' : 'light'
})()
