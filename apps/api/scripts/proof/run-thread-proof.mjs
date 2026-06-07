import { GET } from "@/app/api/cockpit/inbox/thread-hydration/route.js";
const numbers = ["+15126291872", "+16023329348", "+17025617084"];
for (const n of numbers) {
  const req = new Request(`http://localhost:3000/api/cockpit/inbox/thread-hydration?thread_key=${encodeURIComponent(n)}`, {
    headers: { "x-ops-dashboard-secret": process.env.OPS_DASHBOARD_SECRET }
  });
  const res = await GET(req);
  const data = await res.json();
  const ok = res.status === 200 && data.degraded === false && !!data.dealContext && data.integrityBlocked === false && data.messages?.length > 0;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${n} HTTP ${res.status} | degraded=${data.degraded} | hasDealContext=${!!data.dealContext} | blocked=${data.integrityBlocked} | messages=${data.messages?.length}`);
}
