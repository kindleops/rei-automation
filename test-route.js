import { NextResponse } from 'next/server';
import { GET } from './apps/api/src/app/api/cockpit/inbox/thread-hydration/route.js';

async function run() {
  const req = { url: 'http://localhost:3000/api/cockpit/inbox/thread-hydration?thread_key=%2B14802257752', nextUrl: new URL('http://localhost:3000/api/cockpit/inbox/thread-hydration?thread_key=%2B14802257752') };
  const res = await GET(req);
  console.log(await res.json());
}
run();
