# Vercel Production Operator Skill

This skill manages Vercel deployment workflows, crons, and edge function limits.

## Vercel Deployment Checklist
- [ ] Verify `npm run build` passes locally.
- [ ] Check `build_output.txt` for any warnings.
- [ ] Ensure all environment variables are synced with `.env.example`.

## Cron Flow Documentation
- Crons are defined in `vercel.json`.
- Each cron must point to a specific API route (e.g., `api/translate.ts`).
- Cron execution logs must be audited weekly for timeout failures.

## Handling Edge Function Limits
- Keep execution time under 10s for synchronous routes.
- Use background jobs for long-running tasks.
- Avoid large dependencies in edge routes to minimize bundle size.

## Environment Variable Auditing
- Run a monthly audit of environment variables.
- Ensure no secrets are leaked in client-side bundles (no `NEXT_PUBLIC_` or `VITE_` prefixes for sensitive keys).
