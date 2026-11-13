// FENCED: dotenv (and any @dotenvx/*) may not be loaded inside LeadCommand MCP. Loading it
// would read a .env file (for example apps/api/.env.local) into process.env. See ../alias-hooks.mjs.
throw Object.assign(new Error('dotenv is refused inside LeadCommand MCP: credentials come only from LEADCOMMAND_MCP_* files'), { code: 'DOTENV_REFUSED' })
