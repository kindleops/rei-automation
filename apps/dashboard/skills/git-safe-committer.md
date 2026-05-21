# Git Safe Committer

## Purpose
Ensure that every commit to the repository is clean, verified, and follows the project's standards for code quality and documentation.

## When to use
- Before committing any changes to the repository.
- When wrapping up a feature or a bug fix.

## Exact steps
1. **Review Changes**: Check the status and diff of your changes to ensure only intended files are being staged.
   ```bash
   git status && git diff HEAD
   ```
2. **Verify Integrity**: Run the relevant proof scripts or tests to ensure no regressions were introduced.
   ```bash
   node scripts/proof/inbox-integrity.mjs
   # or
   node scripts/test-supabase.mjs
   ```
3. **Draft Commit Message**: Craft a concise, "why"-focused commit message. Follow the project's style (e.g., lowercase imperative or conventional commits if established).
   - *Example*: `fix: update classifier to catch 'stop' with emoji`
   - *Example*: `feat: add hydrated views for inbox dashboard`
4. **Stage and Commit**: Add the files and commit with the drafted message.
   ```bash
   git add .
   git commit -m "your message"
   ```
5. **Final Status Check**: Confirm the commit was successful and the working directory is clean.
   ```bash
   git status
   ```

## Safety rules
- **Never** commit `.env` files, secrets, or API keys.
- **Never** commit broken tests or proof scripts.
- **Always** review the `git diff` to catch accidental console logs or temporary "scratch" code.

## Commands to run
- `git status && git diff HEAD && git log -n 3`: Gathers context for the commit.
- `git add <files>`: Stages specific changes.
- `git commit -m "<message>"`: Performs the commit.

## Proof requirements
- Clean `git status` output after the commit.
- Passing proof scripts/tests as recorded in the session history.

## “Do not” rules
- Do not use generic messages like "fix" or "update". Explain the *intent*.
- Do not stage large amounts of unrelated changes in a single commit. Keep commits atomic.
- Do not commit to `main` directly if a feature branch workflow is required (check `GEMINI.md` for project-specific rules).
