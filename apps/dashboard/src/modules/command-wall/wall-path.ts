/** /wall and /wall/* mount the Command Wall instead of the operator app (see main.tsx). */
export const isCommandWallPath = (pathname: string) => pathname === '/wall' || pathname.startsWith('/wall/')
