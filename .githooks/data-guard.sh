# The one description of "this is your data, not the project's", sourced by
# .githooks/pre-commit (what you are about to commit) and .githooks/pre-push
# (everything you are about to send). Kept here once so the two can never
# disagree; `scripts/__tests__/data-guard.test.ts` checks that .gitignore and
# the CI job agree with it too.
#
# Adding a dataset this repo really ships is a deliberate edit in three places,
# in one commit: DATA_ALLOW below, the allow-list in .gitignore, and the CI job
# in .github/workflows/ci.yml. The test names the file that is out of step.

# Shapes that are data: a project bundle or pack, a ChatGPT export, an
# environment file or a key (wherever it sits in the tree), a published page
# or a screenshot from a driven run.
DATA_SHAPES='\.(ae|aegraph)\.json(\.gz)?$|\.aeb(\.gz)?$|(^|/)(chatgpt|conversations)[^/]*\.(json|gz|html)$|[Cc]hat[Gg][Pp][Tt]|(^|/)\.env($|\.)|\.screenshot\.png$|(^|/)(shot|smoke)-[^/]*\.png$|\.(pem|key|p12|pfx)$|(^|/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$|(^|/)[^/]*service-account[^/]*\.json$'
# An environment file's documented example is not one, at any depth.
DATA_ALLOW_ANYWHERE='(^|/)\.env\.example$'

# The files this repo ships that those shapes would otherwise catch, exactly.
# The demo projects are not among them: they live in the aegraph-ui-demos
# repository and arrive in public/demos/ at build time.
DATA_ALLOW='^(public/spec/example\.ae\.json|public/templates/conversation-atlas\.template\.ae\.json|src/.*\.(ae|aegraph)\.json|\.env\.example)$'

# Source is small; a dataset is not. One tracked file is legitimately large.
DATA_MAX_BYTES=5000000
DATA_BIG_ALLOW='^(package-lock\.json)$'

# Is this path one of your data files? Prints a reason and returns 0 when it is.
data_guard_reason() {
  f=$1
  if printf '%s' "$f" | grep -qiE "$DATA_SHAPES" &&
     ! printf '%s' "$f" | grep -qE "$DATA_ALLOW" &&
     ! printf '%s' "$f" | grep -qE "$DATA_ALLOW_ANYWHERE" &&
     ! printf '%s' "$f" | grep -qiE '^src/.*chatgpt'; then
    printf 'a project bundle, an export, a ChatGPT file, an environment file or a key'
    return 0
  fi
  return 1
}

# Is this blob too big to be source? `$2` is its size in bytes.
data_guard_oversized() {
  # `wc -c` pads its number on some systems; the arithmetic strips that.
  size=$(( $2 + 0 ))
  [ "$size" -gt "$DATA_MAX_BYTES" ] || return 1
  printf '%s' "$1" | grep -qE "$DATA_BIG_ALLOW" && return 1
  printf '%s bytes, over the %s MB limit' "$size" "$((DATA_MAX_BYTES / 1000000))"
  return 0
}

# Run the hook this clone had before `npm install` pointed core.hooksPath here —
# an organisation's own scanner (gitleaks, a pre-commit framework) keeps running
# after ours. scripts/hooks.mjs records where it was in aegraph.previousHooksPath.
# `$1` is the hook's name; the rest are its arguments. Its status is ours.
data_guard_chain() {
  hook=$1
  shift
  prev=$(git config --get aegraph.previousHooksPath 2>/dev/null) || return 0
  [ -n "$prev" ] || return 0
  case "$prev" in "~/"*) prev="$HOME/${prev#\~/}" ;; esac
  [ -x "$prev/$hook" ] || return 0
  "$prev/$hook" "$@"
}
