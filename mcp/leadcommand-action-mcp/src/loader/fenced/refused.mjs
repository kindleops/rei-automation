// FENCED: dotenv (and any @dotenvx/*) may not be loaded inside the Action MCP. See ../alias-hooks.mjs.
throw Object.assign(new Error('dotenv is refused inside the Action MCP: credentials come only from LEADCOMMAND_ACTION_MCP_* files'), { code: 'DOTENV_REFUSED' })
