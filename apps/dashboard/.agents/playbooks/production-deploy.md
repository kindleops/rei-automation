# Production Deploy

1. Ensure all proof scripts pass: `npm run proof`.
2. Check Vercel project settings for updated Environment Variables.
3. Verify that the `SUPABASE_SERVICE_ROLE_KEY` is NOT exposed to the client.
4. Run a local build: `npm run build`.
5. Deploy to preview and verify hydration.
6. Promote to production.
