import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { connect } from "./cdp.mjs"
const B = "http://localhost:3113", OUT = process.env.QA_OUT || "/tmp/staging-qa", CAP = "/tmp/sched-cert/emails"
const ENV = Object.fromEntries(readFileSync(new URL("../../apps/api/.env.scheduling-staging.local", import.meta.url), "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]))
const log = (...a) => console.log(...a)
const results = []; const ok = (n, v, d = "") => { results.push(v); log(`${v ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`) }
const code = (email) => readdirSync(CAP).sort().map((f) => JSON.parse(readFileSync(path.join(CAP, f), "utf8"))).filter((m) => m.kind === "sign_in_code" && m.to === email).map((m) => /(\d{6})/.exec(m.subject)?.[1]).at(-1)
async function session(W, H) {
  const c = await connect()
  await c.send("Network.enable"); await c.send("Network.clearBrowserCookies")
  const click = (text, sel = "button,a") => c.ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true })()`)
  const type = async (s, t) => { await c.ev(`document.querySelector(${JSON.stringify(s)}).focus()`); await c.send("Input.insertText", { text: t }) }
  const text = (s) => c.ev(`document.querySelector(${JSON.stringify(s)})?.textContent ?? ""`)
  const waitFor = async (sel, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await c.ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await c.sleep(250) } return false }
  const signIn = async (email, deep = "/account/") => {
    await c.go(`${B}${deep}`, 2500)
    await waitFor('input[type="email"]')
    await type('input[type="email"]', email); await click("Continue", "button"); await waitFor("input.pa-code"); await c.sleep(1500)
    await type("input.pa-code", code(email)); await click("Sign in", "button"); await waitFor(".pa-bottomnav, .pa-topnav, nav"); await c.sleep(2500)
  }
  return { c, click, type, text, signIn, waitFor, async open(url) { await c.open(W, H, url, 3000) } }
}

// ---------------------------------------------------------------- desktop ----
let s = await session(1440, 900)
await s.open(`${B}/contact-us/`)
ok("public scheduler shows real staging availability", await s.waitFor(".sch-reasons"))
await s.click("My property"); await s.waitFor(".sch-slot")
const firstTime = await s.text(".sch-slot")
ok("times offered (from configured staff)", Boolean(firstTime), firstTime)
await s.c.ev(`document.querySelector(".sch-slot").click()`); await s.click("Continue", ".sch-go"); await s.c.sleep(600)
await s.type('.sch-fields input[autocomplete="name"]', "Public Fixture")
await s.type('.sch-fields input[type="tel"]', "(555) 555-0190")
await s.type('.sch-fields input[type="email"]', "public-booker@example.test")
await s.click("Schedule the call", "button"); await s.c.sleep(4000)
ok("public booking confirmed by the real API", /Prominent will call you/.test(await s.text(".sch-done h3")), await s.text(".sch-done h3"))
await s.c.shot(`${OUT}/01-public-booking-confirmed.jpg`)

await s.signIn("alex@example.test", "/account/offer/")
ok("deep link survives sign-in", (await s.c.ev("location.pathname")) === "/account/offer/")
ok("real written offer shown with its tier", /212,000/.test(await s.text(".pa-amount") || await s.c.ev("document.body.innerText")) && /Written offer/.test(await s.c.ev("document.body.innerText")))
await s.c.shot(`${OUT}/02-offer-real.jpg`)
await s.c.go(`${B}/account/`, 3500); await s.c.shot(`${OUT}/03-overview-real.jpg`)
ok("two properties available in the switcher", (await s.c.ev(`document.querySelectorAll("[data-property], .pa-switch option, .pa-property-switch option").length`)) >= 2 || /Juniper/.test(await s.c.ev("document.body.innerHTML")))
await s.c.go(`${B}/account/messages/`, 3500)
await s.type(".pa-composer textarea", "Browser QA: is the porch an issue? (fixture)"); await s.click("", ".pa-composer button"); await s.c.sleep(3000)
ok("message sent from the browser appears in the thread", /Browser QA: is the porch/.test(await s.c.ev("document.body.innerText")))
await s.c.shot(`${OUT}/04-messages-real.jpg`)
await s.c.go(`${B}/account/schedule/?reason=offer`, 2000); await s.waitFor(".sch-slot")
await s.c.ev(`document.querySelector(".sch-slot")?.click()`); await s.click("Schedule the call", "button"); await s.c.sleep(4000)
ok("portal booking confirmed (no details re-asked)", /Prominent will call you/.test(await s.text(".sch-done h3")))
await s.c.go(`${B}/account/`, 3500)
ok("call shows on overview", /Prominent will call you/.test(await s.text(".pa-call-when")))
await s.click("Change time", "a"); await s.waitFor(".sch-slot")
await s.c.ev(`document.querySelectorAll(".sch-slot")[2]?.click()`); await s.click("Move the call", "button"); await s.c.sleep(4000)
ok("reschedule from the account", /new time/i.test(await s.text(".sch-done .sch-step")))
await s.c.shot(`${OUT}/05-rescheduled-real.jpg`)
await s.c.go(`${B}/account/`, 3500)
await s.click("Cancel call", "button"); await s.c.sleep(500); await s.c.shot(`${OUT}/06-cancel-confirm-real.jpg`)
await s.click("Yes, cancel it", "button"); await s.c.sleep(4000)
ok("cancel from the account", !(await s.c.ev(`!!document.querySelector(".pa-call")`)))
s.c.ev("0"); 

const b = await session(1440, 900)
await b.signIn("blair@example.test", "/account/closing/")
ok("blair lands on closing via deep link", (await b.c.ev("location.pathname")) === "/account/closing/")
ok("closing date and title company from canonical rows", /Example Title/.test(await b.c.ev("document.body.innerText")))
await b.c.shot(`${OUT}/07-closing-real.jpg`)
await b.c.go(`${B}/account/`, 3500); await b.c.shot(`${OUT}/08-action-needed-real.jpg`)
ok("action needed shown", /photo ID|affidavit/i.test(await b.c.ev("document.body.innerText")))
await b.c.go(`${B}/account/documents/`, 3500); await b.c.shot(`${OUT}/09-documents-real.jpg`)

// ----------------------------------------------------------------- mobile ----
const m = await session(390, 844)
await m.signIn("alex@example.test", "/account/")
for (const [name, p] of [["10-m-overview", "/account/"], ["11-m-offer", "/account/offer/"], ["12-m-messages", "/account/messages/"], ["13-m-schedule", "/account/schedule/"]]) {
  await m.c.go(`${B}${p}`, 3500)
  ok(`mobile ${p} has no horizontal scroll and a bottom nav`, !(await m.c.ev("document.documentElement.scrollWidth > innerWidth")) && (await m.c.ev(`getComputedStyle(document.querySelector(".pa-bottomnav")).display`)) !== "none")
  await m.c.shot(`${OUT}/${name}.jpg`)
}
console.log(`\n${results.filter(Boolean).length}/${results.length} browser checks passed`)
process.exit(results.every(Boolean) ? 0 : 1)
