// ─── stop-scope.js ──────────────────────────────────────────────────────────
// CONTEXTUAL STOP (owner 2026-10-07). A "stop" verb is an opt-out only when it
// stops COMMUNICATION:
//   STOP_COMMUNICATION  stop texting / contacting / calling me, remove my number,
//                       unsubscribe, or a BARE stop keyword (STOP / 停止 / Стоп / 중지)
//   STOP_OTHER_ACTION   "stop crying", "stop asking that", "enough with the
//                       lowballs", "Pare de llorar", "Хватит", "रुको" (wait)
// Only STOP_COMMUNICATION may become a suppression. STOP_OTHER_ACTION keeps its
// ordinary meaning (frustration / hostile / not interested / wait).
//
// Precedence (fail toward compliance): any communication object anywhere in
// the message → communication. A stop verb with a NON-communication complement
// → other action. Otherwise (bare keyword, "please stop") → not decided here:
// the existing opt-out rules stand. Rules only, native script.

export const STOP_SCOPE_VERSION = "stop_scope_v1_2026_10_07";
export const STOP_SCOPE = Object.freeze({ COMMUNICATION: "stop_communication", OTHER_ACTION: "stop_other_action" });

/** Any communication object — texting, messages, calls, contact, my number, a list. */
const COMMUNICATION_RE = new RegExp(
  [
    "\\b(?:text|texts|texting|message|messages|messaging|msg|msgs|sms|contact|contacting|call|calls|calling|phone|bother|bothering|bug|bugging|pester\\w*|annoy\\w*|harass\\w*|spam\\w*|number|list|unsubscribe|opt[\\s-]?out|email|emails|write|writing|reach(?:ing)?\\s+out|hit(?:ting)?\\s+me\\s+up)\\b",
    "\\b(?:escrib\\w*|mensaj\\w*|text\\w*|llam\\w*|contact\\w*|molest\\w*|n[uú]mero|lista|whatsapp)\\b",
    "\\b(?:mensag\\w*|escrev\\w*|lig\\w*|contat\\w*|incomod\\w*)\\b",
    "(?:[ée]cri\\w*|\\bmessage\\w*|\\btexto\\w*|\\bappel\\w*|\\bcontact\\w*|\\bnum[ée]ro|\\bliste\\b|\\bharcel\\w*|\\bd[ée]rang\\w*)",
    "\\b(?:schreib\\w*|nachricht\\w*|anruf\\w*|kontakt\\w*|nummer|belästig\\w*|nerv\\w*|simsen|texten)\\b",
    "\\b(?:scriv\\w*|messagg\\w*|chiam\\w*|contatt\\w*|disturb\\w*)\\b",
    "(?:pis(?:a[cć]|ać|z|cie)|wiadomo\\w*|dzwo\\w*|kontakt\\w*|numer\\w*|sms)",
    "(?:nhắn|tin\\s+nhắn|gọi|liên\\s+lạc|số\\s+(?:điện\\s+thoại|của\\s+tôi)|làm\\s+phiền)",
    "(?:短信|信息|消息|联系|電話|电话|号码|打扰|发送|再发|别发|不要发)",
    "(?:문자|연락|전화|번호|메시지|수신|보내)",
    "(?:連絡|メッセージ|メール|電話|番号|配信|送らない|送信)",
    "(?:הודע\\S*|לשלוח|לכתוב|להתקשר|מספר|לפנות)",
    "(?:رسائل|رسالة|مراسل\\S*|إرسال|ارسال|الاتصال|اتصال|رقم\\S*|التواصل|إزعاج\\S*|ازعاج\\S*)",
    "(?:пис\\S*|звон\\S*|сообщ\\S*|номер\\S*|смс|контакт\\S*|рассылк\\S*)",
    "(?:μήνυμ\\S*|μηνύμ\\S*|στέλν\\S*|γράφ\\S*|τηλεφων\\S*|αριθμ\\S*|ενοχλ\\S*)",
    "(?:मैसेज|मेसेज|संदेश|कॉल|फ़ोन|फोन|नंबर|संपर्क|एसएमएस)",
  ].join("|"),
  "iu",
);

/** A stop verb with a complement (something other than communication follows). */
const STOP_WITH_COMPLEMENT = [
  // "stop asking" alone stays communication; "stop asking that / about …" is another action.
  /\bstop\s+(?:(?!asking\b)\w+ing\b|asking\s+(?:that|this|about|for|so|such|the|me\s+(?:that|about|the|for))\b|with\b|it\s+with\b|being\b|the\b|that\b|this\b|your\b|these\b|those\b|lying\b)/i,
  /\benough\s+(?:with|of)\b/i,
  /\b(?:pare|para|par[eé]|deja|deje|dejen|basta|ya\s+basta)\s+(?:de|con|ya\s+de)\s+\S+/i,
  /\bpar[ea]\s+(?:de|com)\s+\S+/i,
  /\barr[eê]te[sz]?\s+(?:de|d'|avec|ça|ca)\b/i,
  /\bh[oö]r(?:en\s+sie|t|e)?\s+auf\s*,?\s+(?:zu|mit|damit)\b/i,
  /\bsmett(?:a|ila|ete|i|etela)\s+(?:di|con)\b/i,
  /przesta[nń](?:cie)?\s+(?!ju[zż]\b|prosz[eę]\b|wreszcie\b|natychmiast\b)\S+/i,
  /dừng\s+lại\s+(?!đi\b|nhé\b|ngay\b|giùm\b|dùm\b)\S+/i,
  /그만\s+(?:좀\s+)?(?!하|해)\S+/u,
  /\S+(?:は|を|が)(?:やめて|止めて)/u,
  /(?:תפסיק|תפסיקו|הפסק)\s+(?:עם|ל)\S+/u,
  /(?:توقف|توقفوا|كف)\s+عن\s+\S+/u,
  /(?:прекратите|перестаньте|перестань|хватит)\s+(?!уже|пожалуйста|немедленно)\S+/iu,
  /σταματ(?:ήστε|α|ά)\s+(?:να|με)\s+\S+/iu,
];

/** Whole-message words that mean "wait" / "enough" — not a stop-texting instruction (owner list). */
const BARE_OTHER_ACTION = new Set(["хватит", "रुको", "ruko", "wait", "hold on", "espera", "espere", "attends", "attendez", "warte", "aspetta", "czekaj"]);

const bare = (s) => String(s || "").trim().replace(/^[^\p{L}\p{M}\p{N}]+/u, "").replace(/[^\p{L}\p{M}\p{N}]+$/u, "").toLowerCase();

/**
 * @returns {"stop_communication" | "stop_other_action" | null}
 *   null = no stop-scope judgement (the existing rules decide).
 */
export function classifyStopScope(message = "") {
  const text = String(message || "");
  if (!text.trim()) return null;
  if (COMMUNICATION_RE.test(text)) return STOP_SCOPE.COMMUNICATION;
  if (BARE_OTHER_ACTION.has(bare(text))) return STOP_SCOPE.OTHER_ACTION;
  if (STOP_WITH_COMPLEMENT.some((re) => re.test(text))) return STOP_SCOPE.OTHER_ACTION;
  return null;
}

export function isStopOtherAction(message = "") {
  return classifyStopScope(message) === STOP_SCOPE.OTHER_ACTION;
}

export default classifyStopScope;
