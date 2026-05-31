# Lessons

## Never run `git restore .` / discard without inspecting the diff first
- 2026-05-30: User asked to "revert all changes since the last commit". I ran `git restore .`
  immediately. One of the wiped files (`battleships/index.html`) had uncommitted work the user
  cared about (weapons). Because the changes were never staged/committed, they are
  unrecoverable from git, and I never read them so they aren't in any transcript either.
- Rule: before any destructive revert/restore/checkout that discards working-tree changes,
  FIRST `git diff` (and ideally `git stash` instead of restore) so the work is recoverable.
  Show the user the diff/summary of what will be lost, especially when "all changes" spans
  multiple files. A stash is reversible; `restore` is not.
