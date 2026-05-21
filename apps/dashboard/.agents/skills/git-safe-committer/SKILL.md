# Git Safe Committer Skill

This skill ensures clean, safe, and professional git commits.

## Step-by-Step for Clean Commits

1. **Verify State**: Run `git status` to ensure only intended files are changed.
2. **Review Changes**: Run `git diff` to audit code quality.
3. **Pass Proofs**: Ensure all relevant scripts in `scripts/proof/` pass.
4. **No Secrets**: Check that `.env` and other sensitive files are NOT staged.
5. **Clear Messages**: Write messages that explain the "why", not just the "what".

## Rules
- Never use the `-f` (force) flag on shared branches.
- Never commit `node_modules` or `dist`.
- Always verify that the build passes before committing.
