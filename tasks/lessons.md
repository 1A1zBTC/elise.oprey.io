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

## Deploying elise.oprey.io: git push does NOT deploy — push to AWS S3 + invalidate CloudFront
- 2026-06-20: After adding Hungry Pig and Naughty Shelf I committed + pushed to GitHub and told
  the user it would go live. It did not — the live site is hosted on S3, not GitHub Pages, so
  the push deployed nothing (Hungry Pig had been "pushed" days earlier and still wasn't live).
- The site serves from S3 bucket `s3://elise.oprey.io` (us-east-1 website endpoint) behind
  CloudFront distribution `EDR208IJW4SS7` (alias elise.oprey.io). AWS CLI auths as IAM user
  `claude` (account 212911667782).
- Deploy steps (after committing): upload changed files WITHOUT `--delete` so other games are
  untouched, then invalidate CloudFront:
  ```
  aws s3 cp index.html s3://elise.oprey.io/index.html --content-type text/html
  aws s3 sync <game>/ s3://elise.oprey.io/<game>/
  aws cloudfront create-invalidation --distribution-id EDR208IJW4SS7 \
    --paths "/" "/index.html" "/<game>/*"
  aws cloudfront wait invalidation-completed --distribution-id EDR208IJW4SS7 --id <id>
  ```
- Rule: "ship/publish/go live" for this repo = git commit/push (source control) AND the S3 +
  CloudFront deploy above. A push alone never updates the live site. Verify with
  `curl -o /dev/null -w "%{http_code}" https://elise.oprey.io/<game>/`.
