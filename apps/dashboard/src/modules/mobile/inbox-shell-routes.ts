/** Routes that render InboxPage with the shared NexusTopBar command shell */
export const INBOX_COMMAND_SHELL_ROUTES = new Set([
  '/',
  '/inbox',
  '/conversation',
  '/map',
  '/pipeline',
  '/calendar',
  '/comp-intelligence',
])

export function routeHasInboxCommandShell(path: string): boolean {
  return INBOX_COMMAND_SHELL_ROUTES.has(path)
}