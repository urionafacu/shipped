#!/bin/sh
# Installs `shipped` as a command on this machine.
#
# Works two ways:
#
#   curl -fsSL https://raw.githubusercontent.com/urionafacu/shipped/main/install.sh | bash
#       nothing is cloned yet, so this clones the repository first. Running it
#       again updates that clone, which makes the one-liner the upgrade path too.
#
#   ./install.sh
#       run from inside a clone, it installs that clone.
#
# Either way it links the entry point into a directory on PATH rather than
# copying or building: the shebang makes src/index.ts directly executable, and
# bun resolves imports against the real file, so node_modules is found no matter
# where the command is invoked from.
#
#   PREFIX=/usr/local/bin      where to put the `shipped` link (default ~/.local/bin)
#   SHIPPED_HOME=~/src/shipped where to keep the clone   (default ~/.local/share/shipped)
#   SHIPPED_REPO_URL=...       clone from a fork instead of upstream
#
# Safe to run twice.

set -eu

REPO_URL=${SHIPPED_REPO_URL:-"https://github.com/urionafacu/shipped.git"}
REPO_SLUG="urionafacu/shipped"
BUN_INSTALL_URL="https://bun.sh/docs/installation"

PREFIX=${PREFIX:-"$HOME/.local/bin"}
SHIPPED_HOME=${SHIPPED_HOME:-"$HOME/.local/share/shipped"}
DEST="$PREFIX/shipped"

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

# --- prerequisites ---------------------------------------------------------

if ! command -v git >/dev/null 2>&1; then
  fail "git not found on PATH. Install git, then run this again."
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'install: bun not found on PATH.\n' >&2
  printf '         shipped runs on bun; install it from %s\n' "$BUN_INSTALL_URL" >&2
  printf '         then run this again.\n' >&2
  exit 1
fi

# --- where is the project? -------------------------------------------------

# Piped through a shell, $0 is the shell itself and there is no script file to
# take a directory from. Only treat this as a local run when $0 really points at
# a file sitting in a shipped checkout.
is_project_dir() {
  [ -f "$1/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"shipped"' "$1/package.json"
}

PROJECT=
if [ -f "$0" ]; then
  candidate=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
  if is_project_dir "$candidate"; then
    PROJECT="$candidate"
  fi
fi

# Same repository? Normalise the .git suffix away so the https and ssh spellings
# of upstream agree, then also accept whatever REPO_URL currently points at so a
# fork updates itself rather than being refused.
is_our_clone() {
  [ -d "$1/.git" ] || return 1
  url=$(git -C "$1" remote get-url origin 2>/dev/null) || return 1
  case "${url%.git}" in
    *"$REPO_SLUG") return 0 ;;
    "${REPO_URL%.git}") return 0 ;;
    *) return 1 ;;
  esac
}

if [ -z "$PROJECT" ]; then
  # Remote run: fetch the source before anything can be installed.
  if [ -e "$SHIPPED_HOME" ] && [ ! -d "$SHIPPED_HOME" ]; then
    fail "$SHIPPED_HOME exists but is not a directory.
         Move it, or point SHIPPED_HOME somewhere else."
  fi

  if [ -d "$SHIPPED_HOME" ]; then
    if is_our_clone "$SHIPPED_HOME"; then
      say "==> Updating $SHIPPED_HOME"
      git -C "$SHIPPED_HOME" pull --ff-only
    else
      fail "$SHIPPED_HOME already exists and is not a clone of $REPO_SLUG.
         Remove it, or point SHIPPED_HOME somewhere else."
    fi
  else
    say "==> Cloning $REPO_URL into $SHIPPED_HOME"
    mkdir -p "$(dirname -- "$SHIPPED_HOME")"
    git clone --quiet "$REPO_URL" "$SHIPPED_HOME"
  fi

  PROJECT="$SHIPPED_HOME"
fi

ENTRY="$PROJECT/src/index.ts"
[ -f "$ENTRY" ] || fail "entry point missing at $ENTRY — is this the project directory?"

# --- dependencies ----------------------------------------------------------

say "==> Installing dependencies"
( cd "$PROJECT" && bun install --frozen-lockfile )

chmod +x "$ENTRY"

# --- link ------------------------------------------------------------------

if [ -e "$PREFIX" ] && [ ! -d "$PREFIX" ]; then
  fail "$PREFIX exists but is not a directory."
fi
mkdir -p "$PREFIX"

# Only ever replace a link this installer could have made. Anything else at that
# path belongs to the user, and silently overwriting it would be a bug report
# waiting to happen.
if [ -L "$DEST" ]; then
  current=$(readlink "$DEST")
  if [ "$current" != "$ENTRY" ]; then
    fail "$DEST is a symlink to $current.
         Remove it first if you want shipped to take that name."
  fi
elif [ -e "$DEST" ]; then
  fail "$DEST already exists and is not a symlink.
         Remove it first, or pick another directory with PREFIX=..."
fi

ln -sf "$ENTRY" "$DEST"
say "==> Linked $DEST -> $ENTRY"

# --- PATH ------------------------------------------------------------------

case ":$PATH:" in
  *":$PREFIX:"*)
    say "==> Done. Run: shipped --help"
    ;;
  *)
    say ""
    say "==> Done, but $PREFIX is not on your PATH."
    say "    Add this to your shell rc (~/.bashrc, ~/.zshrc):"
    say ""
    say "        export PATH=\"$PREFIX:\$PATH\""
    say ""
    say "    Then open a new shell and run: shipped --help"
    ;;
esac

say ""
say "Run it from inside any git repository:"
say ""
say "        cd path/to/your/repo && shipped"
