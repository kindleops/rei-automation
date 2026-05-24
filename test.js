import { NextResponse } from 'next/server.js';
const ALLOWED_ORIGINS = ['https://ops.leadcommand.ai'];
function getCorsHeaders() {
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0] };
}
function withCors(response) {
  const headers = getCorsHeaders();
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}
const res = NextResponse.json({ ok: false });
withCors(res);
console.log(res.headers.get("Access-Control-Allow-Origin"));
