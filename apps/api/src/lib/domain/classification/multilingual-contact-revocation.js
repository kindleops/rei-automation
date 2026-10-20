// ─── multilingual-contact-revocation.js ─────────────────────────────────────
// P0 COMPLIANCE (2026-10-19). A request to stop contacting is an opt-out in
// EVERY language we text, not only in the phrases someone happened to list.
// Production misses (all classified unclear / not_interested and left
// contactable): an imperative-with-clitic Spanish remove ("Quíteme de su
// lista", "sáqueme de su lista"), a Spanish "never contact me again"
// periphrasis, and Haitian Creole stop requests ("Tanpri sispann voye mesaj ban
// mwen", "sispann ekri m").
//
// This module is a GRAMMAR, not a phrase list. Per language it composes the
// intent families from verb stems, inflection, clitics, objects and negation:
//
//   stop_sending        a cease verb + a communication verb / object
//                       ("deje de escribirme", "sispann voye mesaj", "arrêtez de m'écrire")
//   remove_from_list    a remove verb (any inflection, incl. clitic imperatives
//                       quíteme / sáquenme / bórrenme / elimíneme) + a list /
//                       database / "my number" object
//   no_contact          a negation + a communication verb in the imperative /
//                       subjunctive ("no me vuelvan a contactar", "pa ekri m ankò",
//                       "ne m'écrivez plus", "wag nyo na akong i-text")
//   unsubscribe         darme de baja / descadastrar / désabonner / 退订 / 수신거부 / отписаться
//   leave_alone         déjame en paz / kite m anpè / zostaw mnie w spokoju
//   stop_asking_property  "stop asking about <the house | an address>" — the
//                       existing owner rule (round 9 / 10-14): a stop aimed at OUR
//                       outreach is an opt-out (stop_texting)
//   wrong_number        phone-IDENTITY only (número equivocado, move nimewo, 打错了):
//                       mapped to the EXISTING wrong-number handling, never an opt-out.
//                       An ownership denial ("no soy el dueño") is NOT here — the
//                       classifier's own property-scoped rules decide it.
//
// Every language is matched on a normalized view: Latin-script languages are
// folded (case, accents, ł/đ/ß, curly apostrophes, letter elongation), so
// "QUÍTEME", "quiteme" and "Quítenme" are one form; Arabic is folded (hamza /
// alef / ta-marbuta / tashkeel); Russian ё→е. Vietnamese is matched with its
// diacritics, and separately in the no-diacritic texting style only when the
// message carries no Vietnamese diacritics (so "đúng" = "correct" can never
// read as "đừng" = "don't").
//
// Controls (never an opt-out): plain disinterest ("no me interesa"), a stop of
// something that is not communication ("pare de llorar", "no para de sonar",
// "stop by"), a call-only prohibition WITH a text affirmative ("no me llames,
// escríbeme" — a channel preference), a language preference ("no me escriba en
// inglés"), a negated remove ("no me quite de la lista"), a why/if question
// ("¿por qué no me llaman?").
//
// FAIL-SAFE: a message in a non-English language that carries a stop / remove /
// contact-negation FAMILY TOKEN but matches no confident family is
// `possible_opt_out`. The classifier turns that into a precautionary contact-wide
// hold pending operator review (automation_suppressions precautionary_no_contact),
// never "unclear and contactable".
//
// Rules only, no AI, no I/O.

export const MULTILINGUAL_CONTACT_REVOCATION_VERSION = "ml_contact_revocation_v2_2026_10_19";

export const REVOCATION_FAMILIES = Object.freeze({
  STOP_SENDING: "stop_sending",
  REMOVE_FROM_LIST: "remove_from_list",
  NO_CONTACT: "no_contact",
  UNSUBSCRIBE: "unsubscribe",
  LEAVE_ALONE: "leave_alone",
  STOP_ASKING_PROPERTY: "stop_asking_property",
  WRONG_NUMBER: "wrong_number",
  POSSIBLE_OPT_OUT: "possible_opt_out",
});

const F = REVOCATION_FAMILIES;
const OPT_OUT_FAMILIES = new Set([F.STOP_SENDING, F.REMOVE_FROM_LIST, F.NO_CONTACT, F.UNSUBSCRIBE, F.LEAVE_ALONE, F.STOP_ASKING_PROPERTY]);

// ── normalization ───────────────────────────────────────────────────────────
const VI_DIACRITIC_RE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/u;

export function revocationViews(message = "") {
  const nfc = String(message ?? "").normalize("NFC");
  const lower = nfc
    .toLowerCase()
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const latin = lower
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ı/g, "i")
    // "stoooop", "porfaaaa", "mesaaaj" -> one letter (no real word here needs 3+)
    .replace(/([a-z])\1{2,}/g, "$1");
  const arabic = lower
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
  const cyr = lower.replace(/ё/g, "е");
  const vi_ascii = !VI_DIACRITIC_RE.test(lower);
  return { raw: nfc, lower, latin, arabic, cyr, vi_ascii };
}

// Unicode-aware word edges (JS \b is ASCII-only).
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
// One clause: no sentence punctuation in between.
const GAP = (n) => `(?:[^.!?;\\n]{0,${n}}?\\s)?`;

/** [language, family, view, pattern, opts] — opts.call = the verb is a CALL verb only. */
const RULES = [];
const add = (language, family, view, source, opts = {}) => {
  RULES.push({ language, family, view, re: new RegExp(source, "iu"), all: new RegExp(source, "giu"), ...opts });
};

// ── Spanish ─────────────────────────────────────────────────────────────────
{
  const L = "Spanish";
  const COMM_INF = "(?:escribir|mandar|enviar|textear|texear|textar|contactar|llamar|molestar|marcar|mensajear|whatsappear|wasapear|acosar|hostigar|fastidiar|spamear)";
  const COMM_GER = "(?:escribiendo|mandando|enviando|texteando|textando|contactando|llamando|molestando|marcando|buscando|mensajeando|acosando|fastidiando)";
  const COMM_GER_ACC = "(?:escribi[eé]ndo|mand[aá]ndo|envi[aá]ndo|texte[aá]ndo|contact[aá]ndo|llam[aá]ndo|molest[aá]ndo|marc[aá]ndo|busc[aá]ndo|mensaje[aá]ndo|acos[aá]ndo)(?:me|nos)?";
  const NEG = "(?:no|nunca|jamas|ya\\s+no|nunca\\s+mas|ni)";
  const ME = "(?:me|nos|m)";
  // negative imperative / subjunctive (usted / ustedes / tú) — never the indicative
  // ("¿por qué no me llaman?" keeps its meaning)
  const INTRANS = "(?:escrib(?:a|an|as)|contact(?:e|en|es)|llam(?:e|en|es)|molest(?:e|en|es)|busqu(?:e|en|es)|marqu(?:e|en|es)|texte(?:e|en|es)|textee(?:n|s)?|mensaje(?:e|en|es)|acos(?:e|en|es)|hostigu(?:e|en|es)|fastidi(?:e|en|es)|insist(?:a|an|as)|whatsappe(?:e|en|es))";
  const TRANS = "(?:mand(?:e|en|es)|envi(?:e|en|es))";
  const LANG_OR_TIME = "(?:en\\s+(?:ingles|espanol|english|spanish|otro\\s+idioma)|tan\\s+(?:temprano|tarde)|a\\s+esta\\s+hora|de\\s+noche|en\\s+la\\s+noche|en\\s+la\\s+manana|despues\\s+de|antes\\s+de|hasta\\s+(?:el|la|mas)|al\\s+trabajo|ahorita|ahora\\s+mismo|hoy)";
  // lower view: "deje"/"pare" (usted imperative) is never "dejé"/"paré" (I stopped ...)
  add(L, F.STOP_SENDING, "lower", `${B}(?:ya\\s+)?(?:dej(?:a|en|an|ar|ad)|par(?:a|en|an|ar|ad)|deje|pare)\\s+(?:usted\\s+|ustedes\\s+)?(?:ya\\s+)?de\\s+(?:(?:me|nos)\\s+)?(?:estar\\s+)?(?:${COMM_INF}(?:me|nos|le|les)?|buscar(?:me|nos)|${COMM_GER_ACC})${E}`, { callVerb: /llam|marc/ });
  add(L, F.STOP_SENDING, "latin", `${B}basta\\s+(?:ya\\s+)?(?:de|con)\\s+(?:(?:los|sus|tus|tanto|tantos|estos|esos|esas|tantas)\\s+)?(?:mensajes|mensajitos|textos|llamadas|sms|msjs|molestar|escribir|mandar)${E}`);
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+${ME}\\s+(?:vuelv(?:a|an|as|e|en)\\s+a\\s+)?${INTRANS}${E}(?!\\s+${LANG_OR_TIME})`, { callVerb: /llam|marqu/ });
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+${ME}\\s+${TRANS}\\s+(?:(?:ya|usted|ustedes|tu)\\s+)?(?:mas|\\+|nada|ningun\\w*|mensaj\\w*|msjs?|mjs|mensajitos|textos?|text|txts?|sms|whats\\w*|propuestas|ofertas|informacion|info|cosas|eso|esto|publicidad|spam)${E}(?!\\s+(?:por|al)\\s+(?:correo|email|mail|carta))`);
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+${ME}\\s+${TRANS}(?=\\s*(?:$|[.,!;]|\\s+(?:por\\s+favor|porfa|xfa|x\\s+favor|gracias|ok)))`);
  // "No llamen" / "no llame" (no clitic): a call prohibition — an opt-out unless a text affirmative
  // makes it a channel preference
  add(L, F.NO_CONTACT, "latin", `${B}(?:no|nunca|ya\\s+no)\\s+(?:llam(?:e|en|es)|marqu(?:e|en|es))${E}(?!\\s+${LANG_OR_TIME})(?![^.!;\\n]*\\?)`, { callVerb: /llam|marqu/ });
  add(L, F.NO_CONTACT, "latin", `${B}ya\\s+no\\s+${ME}\\s+(?:${INTRANS}|${TRANS})${E}(?!\\s+${LANG_OR_TIME})`, { callVerb: /llam|marqu/ });
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+${ME}\\s+vuelv(?:a|an|as|e|en)\\s+a\\s+${COMM_INF}${E}`, { callVerb: /llamar|marcar/ });
  add(L, F.NO_CONTACT, "latin", `${B}(?:no|nunca)\\s+vuelv(?:a|an|as|e|en)\\s+a\\s+${COMM_INF}(?:me|nos)${E}`, { callVerb: /llamar|marcar/ });
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+(?:${ME}\\s+)?(?:esten|este|estes|sigan|siga|sigas)\\s+${COMM_GER}${E}`, { callVerb: /llamando|marcando/ });
  add(L, F.NO_CONTACT, "latin", `${B}no\\s+(?:quiero|queremos|deseo|deseamos|necesito)\\s+(?:(?:que|q|k)\\s+${ME}\\s+(?:(?:sigan|vuelvan\\s+a|esten)\\s+)?(?:escrib|contact|llam|molest|mand|envi|textee|texte|busqu|marqu|mensaje)\\w*|recibir\\s+(?:mas\\s+)?nada|(?:recibir\\s+)?(?:mas\\s+|ningun\\w*\\s+|sus\\s+|tus\\s+|estos\\s+|esos\\s+)?(?:mensajes|msjs|mensajitos|textos|sms|llamadas|whatsapps?)|ser\\s+(?:contactad|molestad|llamad)[oa]s?|(?:mas\\s+)?(?:contacto|comunicacion))${E}`, { callVerb: /llam|llamadas/ });
  add(L, F.NO_CONTACT, "latin", `${B}(?:no\\s+me\\s+interesa|no\\s+gracias|no\\s+necesito)${GAP(20)}(?:que|q)\\s+${ME}\\s+(?:sigan\\s+)?(?:escrib|contact|llam|molest|mand|envi|textee|busqu)\\w*`);
  add(L, F.NO_CONTACT, "latin", `${B}(?:ya\\s+)?no\\s+(?:mas|more|\\+)\\s+(?:mensajes|mensajitos|textos|sms|msjs|llamadas|whatsapps?)${E}`);
  // remove: any inflection of the stem (quíteme, quítenme, sáquenme, bórrenme,
  // elimíneme, remuévanme, quitarme, me pueden sacar ...) + a list / my-number object
  // lower view, accent-optional stems, STRICT endings: quíteme / quítenme / sáquenme / bórrenme /
  // elimíneme / remuévanme / quitarme / me pueden sacar — never the preterite "quité" / "saqué".
  const REM = "(?:qu[ií]t|s[aá]c|s[aá]qu|b[oó]rr|elim[ií]n|remu[eé]v|remov|ret[ií]r|t[aá]ch|desapunt|excl[uú]y|exclu)";
  const END = "(?:a|e|en|an|as|es|ar|er|ir|ame|eme|enme|anme|arme|erme|irme|anos|enos|arnos|ernos|enlo|enla)?";
  const NOT_NEG = "(?<!(?:^|[^\\p{L}])no\\s(?:me\\s|nos\\s)?)";
  const LIST = "(?:lista|listas|listado|base\\s+de\\s+datos|registros?|contactos|directorio|mailing|database)";
  add(L, F.REMOVE_FROM_LIST, "lower", `${B}${NOT_NEG}${REM}${END}\\s+${GAP(40)}(?:de|del|d)\\s+(?:(?:su|tu|la|sus|tus|las|esta|esa|estas|esas|vuestra|el|los|ese|este|todas?\\s+(?:sus|las))\\s+)?${LIST}${E}`);
  add(L, F.REMOVE_FROM_LIST, "lower", `${B}${NOT_NEG}${REM}(?:ame|eme|enme|anme|arme|enos|anos)(?:\\s+(?:por\\s+favor|porfa|porfavor|xfa|x\\s+favor|ya|ahora|ahorita|gracias|de\\s+aqu[ií]|de\\s+esto|de\\s+todo|de\\s+una\\s+vez))*\\s*(?:$|[.,!;])`);
  add(L, F.REMOVE_FROM_LIST, "lower", `${B}${NOT_NEG}${REM}${END}\\s+${GAP(20)}(?:mi|este|nuestro)\\s+(?:n[uú]mero|num|tel[eé]fono|tel|cel|celular|contacto)${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}(?:dar(?:me|nos)?|da(?:me|nos)|de(?:me|nme|nos)|den(?:me|nos)?|me\\s+(?:dan|den|da|de|doy|pueden\\s+dar|puede\\s+dar))\\s+de\\s+baja${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}(?:desuscrib|desinscrib|dessuscrib|desubscrib|dessubscrib)[a-z]*|${B}(?:cancelar|anular|quitar)\\s+(?:mi\\s+|la\\s+)?suscripcion${E}`);
  add(L, F.LEAVE_ALONE, "latin", `${B}(?:ya\\s+)?d[e]j(?:a|e|en|ar|ad)(?:me|nos)\\s+(?:en\\s+paz|tranquil[oa]s?|de\\s+molestar)${E}`);
  const PROP = "(?:(?:la|mi|esa|esta|el|ese|este|nuestra|su|mis|las)\\s+)?(?:casa|casas|propiedad|propiedades|terreno|lote|inmueble|apartamento|apto|depa|departamento|edificio|vivienda|duplex|rancho|\\d{1,6}\\s+[a-z])";
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}(?:dej|par)(?:a|e|en|an|ar)\\s+de\\s+(?:${ME}\\s+)?preguntar(?:me|nos)?\\s+(?:por|sobre|acerca\\s+de|de)\\s+${PROP}`);
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}${NEG}\\s+${ME}\\s+(?:pregunt(?:e|en|es)|vuelv\\w*\\s+a\\s+preguntar)\\s+(?:mas\\s+)?(?:por|sobre|acerca\\s+de)\\s+${PROP}`);
  add(L, F.WRONG_NUMBER, "latin", `${B}(?:numero|num|telefono)\\s+(?:equivocado|incorrecto|errado|erroneo|mal)${E}|${B}(?:se\\s+)?equivoc\\w*\\s+de\\s+(?:numero|persona)${E}|${B}tiene(?:n)?\\s+(?:el\\s+)?numero\\s+(?:equivocado|incorrecto|mal)${E}|${B}no\\s+(?:conozco|se\\s+quien\\s+es)\\s+(?:a\\s+)?(?:esa\\s+persona|ese\\s+senor|esa\\s+senora|nadie\\s+(?:con\\s+ese\\s+nombre|asi))${E}|${B}este\\s+no\\s+es\\s+(?:el\\s+)?(?:numero|telefono|cel)\\s+de${E}|${B}aqui\\s+no\\s+(?:vive|hay)\\s+nadie\\s+(?:con\\s+ese\\s+nombre|asi|que\\s+se\\s+llame)`);
}

// ── Portuguese ──────────────────────────────────────────────────────────────
{
  const L = "Portuguese";
  const COMM = "(?:mandar|enviar|escrever|ligar|contatar|contactar|incomodar|perturbar|chatear|encher|mensagear|textar|procurar|importunar|telefonar|mandando|enviando|escrevendo|ligando|incomodando|perturbando)";
  const NEG = "(?:nao|n|naum|nunca|jamais|nunca\\s+mais|nem)";
  const SUBJ = "(?:mande|mandem|envie|enviem|escreva|escrevam|ligue|liguem|contate|contatem|contacte|contactem|procure|procurem|incomode|incomodem|perturbe|perturbem|chame|chamem|telefone|telefonem|encha|encham|importune|importunem)";
  const NOT_WHY = "(?<!(?:por\\s*que|porque|pq|se|quando)\\s)";
  add(L, F.STOP_SENDING, "latin", `${B}(?:par(?:e|a|em|ar)|deix(?:e|a|em|ar))\\s+(?:ja\\s+)?de\\s+(?:me\\s+|nos\\s+)?(?:ficar\\s+)?${COMM}(?:-me|-nos)?${E}`, { callVerb: /ligar|ligando|telefonar/ });
  add(L, F.STOP_SENDING, "latin", `(?:^|[,.!;:]\\s*|\\s)(?:parem|pare\\s+por\\s+favor|por\\s+favor\\s+parem?)\\s*[.!]*\\s*$`);
  add(L, F.STOP_SENDING, "latin", `${B}(?:chega|basta)\\s+de\\s+(?:(?:tanta|tantas|essas|suas)\\s+)?(?:mensage\\w*|msgs?|sms|ligac\\w*|textos?|torpedos?)${E}`);
  add(L, F.NO_CONTACT, "latin", `${B}${NOT_WHY}${NEG}\\s+(?:me\\s+|nos\\s+)?${SUBJ}${E}(?:[^.,!?;\\n]{0,30}?\\s)?(?:mais(?!\\s+(?:tarde|cedo))|nunca\\s+mais|de\\s+novo|novamente|outra\\s+vez|nada|mensage\\w*|msgs?|sms)${E}`, { callVerb: /ligu|telefon|cham/ });
  add(L, F.NO_CONTACT, "latin", `${B}${NOT_WHY}${NEG}\\s+me\\s+(?:contate|contatem|contacte|contactem|ligue|liguem|procure|procurem|incomode|incomodem|perturbe|perturbem|escreva|escrevam|chame|chamem)${E}(?![^.!?;\\n]*\\?)`, { callVerb: /ligu|cham/ });
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+(?:quero|queremos|desejo|preciso)\\s+(?:mais\\s+)?(?:(?:que|q)\\s+(?:me|nos)\\s+(?:mand|envi|escrev|lig|contat|contact|procur|incomod|perturb|cham|telefon)\\w*|receber\\s+(?:mais\\s+)?(?:nada|(?:nenhuma\\s+)?(?:mensage\\w*|sms|ligac\\w*|contato))|(?:mais\\s+)?(?:mensage\\w*|sms|ligac\\w*|contato)|ser\\s+(?:mais\\s+)?(?:contatad|contactad|incomodad|perturbad)[oa]s?)${E}`, { callVerb: /lig|cham|telefon/ });
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+(?:entre(?:m)?|entrar)\\s+(?:mais\\s+)?em\\s+contato${E}`);
  add(L, F.NO_CONTACT, "latin", `${B}(?:sem\\s+mais|nada\\s+(?:mais\\s+)?de)\\s+(?:mensage\\w*|sms|ligac\\w*)${E}`);
  const LIST = "(?:lista|listas|cadastro|cadastros|base\\s+de\\s+dados|contatos|banco\\s+de\\s+dados|mailing)";
  // imperative / infinitive / present only — never the past ("tirei a casa da lista")
  const REM = "(?:tir(?:e|a|em|ar)|retir(?:e|a|em|ar)|remov(?:a|e|am|er|em)|exclu(?:a|i|am|ir)|apag(?:ue|a|uem|ar)|delet(?:e|a|em|ar)|risc(?:a|ar|que)|elimin(?:e|a|em|ar))";
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?<!(?:^|[^\\p{L}])(?:nao|n)\\s(?:me\\s)?)${REM}(?:-me|-nos)?\\s+${GAP(40)}(?:d[aeo]s?|dess[ae]s?|dest[ae]s?|na|no|nessa|nesta|em|de)\\s+(?:(?:sua|vossa|tua|seu|vosso|essa|esta|minha)\\s+)?${LIST}${E}`);
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?<!(?:^|[^\\p{L}])(?:nao|n)\\s(?:me\\s)?)${REM}(?:-me)?\\s+${GAP(20)}(?:o\\s+)?meu\\s+(?:numero|telefone|celular|contato|cadastro|zap|whats\\w*)${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}descadastr[a-z]*|${B}cancel[a-z]*\\s+(?:a\\s+|minha\\s+)?(?:inscricao|assinatura)${E}|${B}(?:quero\\s+)?sair\\s+d(?:a|essa|esta)\\s+(?:sua\\s+)?lista${E}`);
  add(L, F.LEAVE_ALONE, "latin", `${B}(?:me\\s+)?deix(?:e|a|em)(?:-me)?\\s+em\\s+paz${E}|${B}me\\s+deix(?:e|a|em)\\s+(?:quiet[oa]|sossegad[oa])${E}`);
  const PROP = "(?:(?:a|o|minha|meu|essa|esse|esta|este)\\s+)?(?:casa|imovel|propriedade|terreno|lote|apartamento|apto|predio|\\d{1,6}\\s+[a-z])";
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}par(?:e|a|em)\\s+de\\s+(?:me\\s+)?perguntar\\s+(?:sobre|pel[ao]|d[ao]|a\\s+respeito\\s+d[ao])\\s+${PROP}`);
  add(L, F.WRONG_NUMBER, "latin", `${B}(?:numero|telefone)\\s+(?:errado|equivocado|incorreto|trocado)${E}|${B}(?:e|foi)\\s+engano${E}|^\\s*engano\\s*[.!]*\\s*$|${B}nao\\s+conheco\\s+(?:essa\\s+pessoa|esse\\s+senhor|essa\\s+senhora|ninguem\\s+com\\s+esse\\s+nome)${E}|${B}(?:discou|ligou|mandou|enviou)\\s+(?:para\\s+)?(?:o\\s+)?numero\\s+errado${E}|${B}esse\\s+nao\\s+e\\s+o\\s+(?:numero|telefone)\\s+d`);
}

// ── French ──────────────────────────────────────────────────────────────────
{
  const L = "French";
  const COMM = "(?:ecrire|envoyer|contacter|appeler|harceler|texter|textoter|deranger|relancer|spammer|solliciter|importuner|embeter|emmerder|joindre|recontacter|telephoner)";
  const NOT_AUX = "(?<!(?:ai|as|a|avons|avez|ont|avais|avait|j'ai|suis|est|sont)\\s)";
  add(L, F.STOP_SENDING, "latin", `${B}${NOT_AUX}(?:arret(?:e|es|ez|er)|cess(?:e|es|ez|er)|stop(?:pez|pe)?)\\s+(?:donc\\s+|tout\\s+de\\s+suite\\s+|svp\\s+|s'il\\s+vous\\s+plait\\s+)?(?:de\\s+|d'|d\\s)(?:me\\s+|m'\\s*|m\\s+|nous\\s+)?${COMM}${E}`, { callVerb: /appeler|telephoner/ });
  add(L, F.STOP_SENDING, "latin", `(?:^|[,.!;:]\\s*|\\s)(?:arretez|arrete[sz]?)(?:\\s+(?:svp|stp|s'il\\s+vous\\s+plait|merci|maintenant|tout\\s+de\\s+suite))?\\s*[.!]*\\s*$`);
  add(L, F.STOP_SENDING, "latin", `${B}(?:assez|marre)\\s+de\\s+(?:vos\\s+|ces\\s+|tes\\s+|tous\\s+ces\\s+)?(?:messages|textos|sms|appels)${E}`);
  const V = "(?:ecri|envoi|envoy|contact|appel|appell|text|derang|relanc|recontact|harcel|sollicit|telephon|joign)";
  add(L, F.NO_CONTACT, "latin", `(?:${B}ne\\s+|${B}n'\\s*|${B}n\\s+)(?:me\\s+|m'\\s*|m\\s+|nous\\s+)?${V}[a-z]*\\s+(?:[a-z']+\\s+){0,3}?plus${E}(?!\\s+(?:tard|tot|souvent|vite))`, { callVerb: /appel|telephon/ });
  add(L, F.NO_CONTACT, "latin", `${B}(?:me\\s+|m')(?:ecri|envoi|envoy|contact|appel|appell|text|recontact|derang)[a-z]*\\s+plus(?=\\s*(?:$|[.,!;]|jamais|svp|stp|merci|s'il|de\\s+(?:messages?|sms|textos?)))`, { callVerb: /appel/ });
  // "Ne m'appelez pas" — a call prohibition (an opt-out unless a text affirmative makes it a channel preference)
  add(L, F.NO_CONTACT, "latin", `(?:${B}ne\\s+|${B}n'\\s*)(?:me\\s+|m'\\s*|m\\s+)(?:appel|appell|telephon)[a-z]*\\s+pas${E}`, { callVerb: /appel|telephon/ });
  add(L, F.NO_CONTACT, "latin", `${B}ne\\s+(?:plus|jamais|plus\\s+jamais|pas)\\s+(?:me\\s+|m'|nous\\s+)${COMM}${E}`, { callVerb: /appeler|telephoner/ });
  add(L, F.NO_CONTACT, "latin", `${B}(?:je\\s+ne|j'|je|nous\\s+ne)\\s*(?:veux|voulons|souhaite|souhaitons|desire)\\s+(?:plus|pas)\\s+(?:(?:recevoir|etre\\s+(?:contacte|sollicite|derange|appele|relance)e?s?)|de\\s+(?:vos\\s+)?(?:messages?|sms|textos?|appels?)|d'(?:appels?|autres\\s+messages)|(?:que\\s+)?(?:vous\\s+)?(?:me\\s+|m')(?:contact|ecri|appel|envoy|relanc)[a-z]*)`, { callVerb: /appel/ });
  add(L, F.NO_CONTACT, "latin", `(?:^|[.!?;]\\s*)(?:plus|pas|plus\\s+jamais)\\s+de\\s+(?:messages?|sms|textos?|appels?)(?:\\s+(?:svp|stp|merci|s'il\\s+vous\\s+plait))?\\s*(?:$|[.!])`);
  const LIST = "(?:liste|listes|fichier|fichiers|base|bases|repertoire|annuaire|systeme|contacts|mailing)";
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}${NOT_AUX}(?<!(?:^|[^\\p{L}])ne\\s(?:me\\s)?)(?:retir|enlev|supprim|effac|ray|sort|radi|desinscriv)(?:ez|e|er|es)(?:[- ](?:moi|nous))?\\s+${GAP(40)}(?:de|des|du|d')\\s*(?:(?:votre|vos|ta|tes|la|les|cette|ce|son|leur)\\s+)?${LIST}${E}`);
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}${NOT_AUX}(?:retir|enlev|supprim|effac|ray)(?:ez|e|er|es)\\s+${GAP(20)}(?:mon|mes)\\s+(?:numero|num|coordonnees|contact|telephone)${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}(?:me\\s+)?(?:desabonn|desinscri)[a-z]*`);
  add(L, F.LEAVE_ALONE, "latin", `${B}(?:laiss|fich|fout)[a-z]*[- ](?:moi|nous)\\s+(?:tranquilles?|en\\s+paix|la\\s+paix)${E}`);
  const PROP = "(?:(?:la|ma|cette|mon|ce|notre|votre)\\s+)?(?:maison|propriete|bien|terrain|appartement|appart|immeuble|logement|\\d{1,6}\\s+[a-z])";
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}(?:arret|cess)[a-z]*\\s+de\\s+(?:me\\s+)?(?:demander|questionner|poser\\s+des\\s+questions)\\s+(?:pour|sur|au\\s+sujet\\s+de|a\\s+propos\\s+de|concernant)\\s+${PROP}`);
  add(L, F.WRONG_NUMBER, "latin", `${B}(?:mauvais|faux)\\s+numero${E}|${B}(?:erreur|trompe|trompee|trompes|trompez)\\s+de\\s+(?:numero|personne)${E}|${B}ce\\s+n'est\\s+pas\\s+(?:moi|la\\s+bonne\\s+personne|mon\\s+numero)${E}|${B}je\\s+ne\\s+connais\\s+pas\\s+(?:cette|ce)\\s+(?:personne|monsieur|madame)${E}`);
}

// ── Haitian Creole ──────────────────────────────────────────────────────────
{
  const L = "Haitian Creole";
  const ME = "(?:m|mwen|mw|mwn|m')";
  const TO_ME = "(?:ban\\s*(?:m|mwen|mw)|ba\\s*(?:m|mwen|mw)|bam|banm|pou\\s+(?:m|mwen)|(?:m|mwen|mw|mwn))";
  const STOP = "(?:sispann|sispan|sispn|sipann|sispanm|sespann|kanpe|estope|stope)";
  const COMM = "(?:voye|vwoye|voy|ekri|rele|kontakte|kontakter|kontak|deranje|anmede|anbete|tekste|texte|teks|text|mesaj|ankese)";
  const NOT_WHY = "(?<!(?:poukisa|pouki|pouki\\s+sa|si|le|lè|kile|kilè)\\s(?:ou\\s|nou\\s|w\\s)?)";
  add(L, F.STOP_SENDING, "latin", `${B}${STOP}\\s+(?:(?:tanpri|souple|non|la|non\\s+tanpri)\\s+)?${COMM}${E}`, { callVerb: /rele/ });
  add(L, F.STOP_SENDING, "latin", `(?:^|[,.!;:]\\s*|\\s)(?:tanpri\\s+)?(?:sispann|sispan|sipann|sispanm|kanpe)(?:\\s+(?:tanpri|souple|non|la|non\\s+tanpri|sa|sa\\s+a))?\\s*[.!]*\\s*$`);
  add(L, F.NO_CONTACT, "latin", `${B}${NOT_WHY}pa\\s+(?:janm\\s+|jame\\s+|janmen\\s+)?(?:${COMM})\\s+(?:[a-z']+\\s+){0,4}?(?:anko|enko|ankò)${E}`, { callVerb: /rele/ });
  add(L, F.NO_CONTACT, "latin", `${B}${NOT_WHY}pa\\s+(?:janm\\s+|jame\\s+|janmen\\s+)?(?:voye|ekri|rele|kontakte|deranje|tekste|anmede)\\s+(?:mesaj\\s+|tekst?\\s+|sms\\s+)?${TO_ME}${E}(?![^.!;\\n]*\\?)`, { callVerb: /rele/ });
  add(L, F.NO_CONTACT, "latin", `${B}(?:m|mwen|mw)\\s+pa\\s+vle\\s+(?:(?:ou|nou|okenn|pyes)\\s+)?(?:${COMM}|resevwa\\s+(?:okenn\\s+)?(?:mesaj|tekst?|apel|sms)|mesaj|tekst?|apel)${E}`, { callVerb: /rele|apel/ });
  add(L, F.NO_CONTACT, "latin", `${B}pa\\s+bezwen\\s+(?:${COMM})\\s+${TO_ME}${E}`, { callVerb: /rele/ });
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:retire|retiren|wete|wetire|efase|elimine|soti)\\s+(?:(?:tanpri|souple)\\s+)?(?:${ME}|nimewo\\s+(?:${ME}|la|sa\\s+a|mwen)|non\\s+(?:m|mwen))\\s+(?:[a-z']+\\s+){0,2}?(?:nan|sou|de|nan\\s+tout)\\s+(?:lis|lista|list|sistem|baz)${E}`);
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:efase|retire|wete|elimine)\\s+(?:(?:tanpri|souple)\\s+)?nimewo\\s+(?:${ME}|telefon\\s+(?:m|mwen))${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}(?:dezabone|dezabonnen|dezenskri|dezabonnman)[a-z]*`);
  add(L, F.LEAVE_ALONE, "latin", `${B}kite\\s+(?:m|mwen|mw)\\s+(?:an\\s*pe|anpe|trankil|anrepo|an\\s+repo)${E}|${B}lage\\s+(?:m|mwen)\\s*(?:$|[.!]|tanpri)`);
  const PROP = "(?:(?:kay|pwopriyete|te|teren|lakay)(?:\\s+(?:la|sa|mwen|m))?|\\d{1,6}\\s+[a-z])";
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}${STOP}\\s+mande\\s+(?:m\\s+|mwen\\s+)?(?:pou|sou|konsenan)\\s+${PROP}`);
  add(L, F.WRONG_NUMBER, "latin", `${B}(?:move|mauvais|mal)\\s+nimewo${E}|${B}nimewo\\s+(?:a\\s+|sa\\s+a\\s+)?pa\\s+bon${E}|${B}(?:ou|nou)\\s+(?:pran|gen|rele|voye\\s+bay)\\s+(?:yon\\s+)?move\\s+nimewo${E}|${B}se\\s+pa\\s+(?:mwen|moun\\s+sa\\s+a|nimewo\\s+(?:li|moun\\s+sa))${E}|${B}(?:m|mwen)\\s+pa\\s+konnen\\s+moun\\s+sa${E}`);
}

// ── Italian ─────────────────────────────────────────────────────────────────
{
  const L = "Italian";
  const COMM = "(?:scriver|mandar|inviar|contattar|chiamar|messaggiar|disturbar|cercar|importunar|tartassar|assillar|telefonar|ricontattar|spammar)[a-z]*";
  add(L, F.STOP_SENDING, "latin", `${B}smett(?:i|a|ete|ila|etela|iamola|erla|ere)\\s+(?:(?:subito|per\\s+favore|gentilmente)\\s+)?di\\s+(?:mi\\s+)?${COMM}`, { callVerb: /chiamar|telefonar/ });
  add(L, F.STOP_SENDING, "latin", `${B}basta\\s+(?:con\\s+)?(?:(?:i|questi|i\\s+vostri|tutti\\s+questi|con\\s+i)\\s+)?(?:messaggi|sms|chiamate|telefonate)${E}`);
  const V = "(?:scriv|chiam|contatt|mand|cerc|disturb|messaggi|invi|telefon|ricontatt)";
  add(L, F.NO_CONTACT, "latin", `${B}non\\s+(?:mi\\s+|ci\\s+)?${V}[a-z]*\\s+(?:[a-z']+\\s+){0,2}?(?:piu|mai\\s+piu|ancora|altri\\s+messaggi|messaggi|sms)${E}`, { callVerb: /chiam|telefon/ });
  add(L, F.NO_CONTACT, "latin", `${B}non\\s+(?:scrivermi|chiamarmi|contattarmi|mandarmi|cercarmi|disturbarmi|messaggiarmi|inviarmi|telefonarmi|ricontattarmi|scriverci|contattarci)${E}`, { callVerb: /chiamarmi|telefonarmi/ });
  add(L, F.NO_CONTACT, "latin", `${B}non\\s+mi\\s+(?:contatti|contattate|scriva|scrivete|chiami|chiamate|disturbi|disturbate|cerchi|cercate|telefoni|telefonate)${E}(?!\\s+(?:in\\s+(?:inglese|spagnolo)|dopo|prima|alle|la\\s+mattina|la\\s+sera|di\\s+sera|stasera|oggi))(?![^.!;\\n]*\\?)`, { callVerb: /chiam|telefon/ });
  add(L, F.NO_CONTACT, "latin", `${B}non\\s+(?:voglio|vogliamo|desidero)\\s+(?:piu\\s+)?(?:essere\\s+(?:contattat|disturbat|chiamat|ricontattat)[oaie]|ricevere|messaggi|sms|chiamate|che\\s+mi\\s+(?:scriv|chiam|contatt|mand)[a-z]*)`, { callVerb: /chiamat|chiam/ });
  const LIST = "(?:lista|liste|elenco|elenchi|database|archivio|rubrica|mailing|contatti|sistema)";
  const REM = "(?:cancell(?:a|ami|atemi|are|ate|i|armi)|togli(?:mi|etemi|ere|ete|ermi)?|tolg(?:a|ano)|rimuov(?:i|imi|etemi|ere|ete|a|ermi)|lev(?:ami|atemi|are|ate|armi)|elimin(?:a|ami|atemi|are|ate|i|armi)|depenn(?:a|ami|atemi|are|ate)|esclud(?:i|imi|etemi|ere|ete|ermi))";
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?<!(?:^|[^\\p{L}])non\\s(?:mi\\s)?)${REM}\\s+${GAP(40)}(?:dalla|dalle|dal|dai|dagli|da)\\s+(?:(?:vostra|vostre|tua|sua|questa|vostro|vostri|vs)\\s+)?${LIST}${E}`);
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}${REM}\\s+${GAP(20)}(?:il\\s+)?mio\\s+(?:numero|contatto|recapito)${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}disiscriv[a-z]*|${B}annull[a-z]*\\s+(?:l'\\s*|la\\s+)?iscrizione${E}`);
  add(L, F.LEAVE_ALONE, "latin", `${B}lasci(?:a|ate|ami|atemi|ateci|ateme)\\s*(?:mi\\s+|ci\\s+)?(?:in\\s+pace|stare)${E}`);
  const PROP = "(?:(?:la|mia|quella|questa|il|mio)\\s+)?(?:casa|proprieta|immobile|terreno|appartamento|\\d{1,6}\\s+[a-z])";
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}smett[a-z]*\\s+di\\s+(?:chieder|domandar)[a-z]*\\s+(?:della|del|per|sulla|sul|riguardo\\s+(?:alla|al)|a\\s+proposito\\s+(?:della|del))\\s+${PROP}`);
  add(L, F.WRONG_NUMBER, "latin", `${B}numero\\s+(?:sbagliato|errato)${E}|${B}(?:ha|hai|avete)\\s+sbagliato\\s+(?:numero|persona)${E}|${B}non\\s+conosco\\s+(?:questa|quella|tale)\\s+persona${E}`);
}

// ── Polish ──────────────────────────────────────────────────────────────────
{
  const L = "Polish";
  const COMM = "(?:pisac|dzwonic|wysylac|esemesowac|smsowac|nekac|zawracac(?:\\s+glowy)?|wydzwaniac|kontaktowac(?:\\s+sie)?|przesylac|spamowac)";
  add(L, F.STOP_SENDING, "latin", `${B}(?:przestan(?:cie)?|przestac|skoncz(?:cie)?|daj(?:cie)?\\s+sobie\\s+spokoj\\s+z)\\s+(?:(?:do\\s+mnie|mi|mnie|juz|prosze|wreszcie|w\\s+koncu)\\s+){0,3}(?:${COMM}|sms\\w*|wiadomosc\\w*|telefon\\w*)${E}`, { callVerb: /dzwonic|wydzwaniac|telefon/ });
  add(L, F.NO_CONTACT, "latin", `${B}nie\\s+(?:pisz|piszcie|dzwon|dzwoncie|wysylaj|wysylajcie|kontaktuj|kontaktujcie|nekaj|nekajcie|zawracaj|zawracajcie|wydzwaniaj|wydzwaniajcie|przesylaj|przesylajcie|spamuj|spamujcie)(?:\\s+sie)?${E}(?!\\s+(?:po\\s+angielsku|wieczorem|rano|tak\\s+pozno|tak\\s+wczesnie|teraz|dzisiaj))`, { callVerb: /dzwon|wydzwan/ });
  add(L, F.NO_CONTACT, "latin", `${B}nie\\s+(?:chce|chcemy|zycze\\s+sobie)\\s+(?:juz\\s+|wiecej\\s+)*(?:zadnych\\s+)?(?:wiadomosci|sms\\w*|smsow|kontaktu|telefonow|polaczen|byc\\s+(?:kontaktowan|nekan)\\w*|zeby\\s+(?:ktos\\s+)?(?:do\\s+mnie\\s+)?(?:pisal|dzwonil|pisali|dzwonili))`, { callVerb: /telefonow|polaczen|dzwonil/ });
  add(L, F.NO_CONTACT, "latin", `${B}prosze\\s+(?:o\\s+)?(?:juz\\s+|wiecej\\s+)?nie\\s+(?:pisac|dzwonic|kontaktowac|wysylac|nekac)${E}`, { callVerb: /dzwonic/ });
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:usun|usuncie|usunac|wykresl|wykreslcie|wykreslic|wypisz|wypiszcie|wypisac|skasuj|skasujcie|wymaz|wymazcie)\\s+(?:(?:prosze|mnie|moj|moje)\\s+)?(?:mnie|moj\\s+(?:numer|telefon|kontakt)|moje\\s+dane|numer|z\\s+(?:listy|bazy))${E}`);
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:usun|wykresl|wypisz|skasuj)\\w*\\s+${GAP(30)}z\\s+(?:listy|bazy|systemu|kontaktow|waszej\\s+listy|waszej\\s+bazy)${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}wypisz\\w*\\s+(?:mnie|sie)${E}|${B}rezygnuj\\w*\\s+z\\s+(?:subskrypcji|wiadomosci|sms\\w*|kontaktu)${E}|${B}wypisuje\\s+sie${E}`);
  add(L, F.LEAVE_ALONE, "latin", `${B}zostaw(?:cie)?\\s+mnie\\s+w\\s+spokoju${E}|${B}daj(?:cie)?\\s+mi\\s+(?:swiety\\s+)?spokoj${E}`);
  const PROP = "(?:(?:moj|moja|moje|ten|ta|to|moim|moja)\\s+)?(?:dom|domu|nieruchomosc\\w*|dzialk\\w*|mieszkani\\w*|\\d{1,6}\\s+[a-z])";
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}przesta\\w*\\s+(?:mnie\\s+)?(?:pytac|wypytywac)\\s+(?:o|w\\s+sprawie)\\s+${PROP}`);
  add(L, F.WRONG_NUMBER, "latin", `${B}(?:zly|bledny|niewlasciwy|zle\\s+wybrany)\\s+numer${E}|${B}pomylk[ai]${E}|${B}pomylil[a-z]*\\s+(?:sie\\s+)?(?:numer|numery|z\\s+numerem|osob)\\w*|${B}to\\s+nie\\s+(?:ja|moj\\s+numer)${E}|${B}nie\\s+znam\\s+(?:tej|tego)\\s+(?:osoby|pana|pani|czlowieka)${E}`);
}

// ── Tagalog ─────────────────────────────────────────────────────────────────
{
  const L = "Tagalog";
  const NEG = "(?:huwag|wag|huag|wg|hwag|'wag)";
  const FILL = "(?:mo|nyo|niyo|ninyo|n'yo|na|po|ako|akong|kong|ko|nang|ng|kayo|nyong|niyong|ninyong|nako|lang|pong|ulit|sakin|sa\\s+akin|kami|kaming|muna|kayong|niyong|nyo\\s+na)";
  const COMM = "(?:i-?text|itext|mag-?text|magtext|text(?:in|an|ahan)?|tex|i-?txt|txt|i-?message|imessage|mag-?message|message(?:an)?|mensahe|tawag(?:an|in)?|tumawag|mag-?call|i-?call|kontakin|kontakan|i-?contact|contact(?:in)?|padalhan|magpadala|istorbo(?:hin)?|abala(?:hin)?|guluhin|kulitin|mangulit)";
  add(L, F.NO_CONTACT, "latin", `${B}${NEG}\\s+(?:${FILL}\\s+){0,4}${COMM}${E}`, { callVerb: /tawag|tumawag|call/ });
  add(L, F.NO_CONTACT, "latin", `${B}ayoko\\s+(?:na\\s+)?(?:ng|nang)?\\s*(?:mga\\s+)?(?:text|message|tawag|mensahe|ma-?text|matext|kontak|contact|txt)${E}`, { callVerb: /tawag/ });
  add(L, F.NO_CONTACT, "latin", `${B}(?:hindi|di)\\s+(?:ko\\s+)?(?:na\\s+)?(?:kailangan|gusto)\\s+(?:ng|nang)\\s+(?:mga\\s+)?(?:text|message|tawag|mensahe)${E}`, { callVerb: /tawag/ });
  add(L, F.STOP_SENDING, "latin", `(?:^|[,.!;:]\\s*|\\s)(?:tigil|itigil|tigilan\\s+(?:nyo|niyo|mo)|tama\\s+na)(?:\\s+(?:na|po|nyo|niyo|na\\s+po|nyo\\s+na|na\\s+nga|nga))*\\s*[.!]*\\s*$`);
  add(L, F.STOP_SENDING, "latin", `${B}(?:tigil(?:an|in)?|itigil|tumigil|stop)\\s+(?:(?:mo|nyo|niyo|na|po|ninyo|kayo|ang|nyo\\s+na|na\\s+po|na\\s+kayo|na\\s+nga)\\s+){0,4}(?:ang\\s+|sa\\s+|na\\s+)?(?:pag-?text|pagtetext|pagte-?text|pagtext|pag-?message|pagmemessage|pagme-?message|pagtawag|pagtatawag|pag-?contact|pagpapadala|text|message|txt|pagkulit|pangungulit|pang-?iistorbo|pag-?istorbo)${E}`, { callVerb: /pagtawag|pagtatawag/ });
  const OBJ = "(?:ako|number\\s+ko|numero\\s+ko|ang\\s+number\\s+ko|ang\\s+numero\\s+ko|pangalan\\s+ko|ang\\s+pangalan\\s+ko)";
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:paki-?)?(?:tanggal(?:in)?|alisin|alis|burahin|bura|i-?remove|remove|i-?delete|delete|tanggalan)\\s+(?:(?:nyo|mo|na|po|niyo|ninyo|na\\s+po|ang|nyo\\s+na|niyo\\s+na)\\s+){0,4}(?:${OBJ}\\s+)?(?:sa|mula\\s+sa|sa\\s+inyong|sa\\s+mga)\\s+(?:inyong\\s+|mga\\s+)?(?:listahan|list|lista|database|system|contacts)${E}`);
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:paki-?)?(?:bura|burahin|tanggal|tanggalin|delete|i-?delete|alisin)\\s+(?:(?:nyo|mo|na|po|niyo)\\s+){0,3}(?:ang\\s+)?(?:number|numero|contact|pangalan)\\s+ko${E}`);
  add(L, F.UNSUBSCRIBE, "latin", `${B}(?:mag|i)-?unsubscribe${E}`);
  add(L, F.LEAVE_ALONE, "latin", `${B}(?:lubayan|tantanan|pabayaan|layuan|tigilan)\\s+(?:(?:mo|nyo|niyo|na|po|ninyo|kayo|na\\s+po|nyo\\s+na)\\s+){0,3}(?:na\\s+)?ako${E}`);
  const PROP = "(?:(?:ang\\s+|yung\\s+|aming\\s+|aking\\s+)?(?:bahay|lupa|property|propyedad|ari-arian|lote)|\\d{1,6}\\s+[a-z])";
  add(L, F.STOP_ASKING_PROPERTY, "latin", `${B}(?:tigil|tigilan|itigil|huwag|wag)\\w*\\s+(?:(?:mo|nyo|na|po|niyo|ako|akong|nyo\\s+na)\\s+){0,4}(?:ang\\s+)?(?:pagtatanong|pagtanong|magtanong|itanong|tanungin)\\s+(?:ako\\s+)?(?:tungkol\\s+sa|sa)\\s+${PROP}`);
  add(L, F.WRONG_NUMBER, "latin", `${B}(?:maling|mali\\s+ang)\\s+(?:numero|number|tao|tinext|na\\s+text)${E}|${B}hindi\\s+(?:ko\\s+)?(?:po\\s+)?kilala\\s+(?:yan|iyan|yun|iyon|ang\\s+tao|si)${E}|${B}hindi\\s+(?:po\\s+)?ako\\s+si${E}`);
}

// ── Vietnamese (with diacritics) ────────────────────────────────────────────
{
  const L = "Vietnamese";
  const ME = "(?:tôi|em|anh|chị|mình|tui|tao|t|con|cháu|chúng\\s+tôi)";
  const COMM = "(?:nhắn(?:\\s+tin)?|gửi(?:\\s+tin(?:\\s+nhắn)?)?|liên\\s+(?:lạc|hệ)|gọi(?:\\s+điện)?|làm\\s+phiền|quấy\\s+rầy|quấy\\s+rối|text|tin\\s+nhắn|spam|nhắn\\s+tin)";
  add(L, F.NO_CONTACT, "lower", `${B}(?:xin\\s+|làm\\s+ơn\\s+|vui\\s+lòng\\s+)?(?:đừng|đừng\\s+có|không\\s+được|cấm)\\s+${COMM}`, { callVerb: /gọi/ });
  add(L, F.NO_CONTACT, "lower", `${B}vui\\s+lòng\\s+không\\s+${COMM}`, { callVerb: /gọi/ });
  add(L, F.NO_CONTACT, "lower", `${B}(?:không|ko|k|hok|chẳng)\\s+(?:cần\\s+|muốn\\s+)?${COMM}[^.!?]{0,20}?\\s+nữa${E}`, { callVerb: /gọi/ });
  add(L, F.NO_CONTACT, "lower", `${B}không\\s+muốn\\s+(?:nhận|bị)\\s+(?:thêm\\s+)?(?:tin\\s+nhắn|cuộc\\s+gọi|làm\\s+phiền|liên\\s+lạc|quấy\\s+rầy)`, { callVerb: /cuộc\\s+gọi/ });
  add(L, F.STOP_SENDING, "lower", `${B}(?:ngừng|dừng|thôi|ngưng|dẹp)\\s+(?:(?:việc|lại|ngay|hẳn)\\s+)?${COMM}`, { callVerb: /gọi/ });
  add(L, F.REMOVE_FROM_LIST, "lower", `${B}(?<!đã\\s)(?:xóa|xoá|gỡ|loại|bỏ)\\s+(?:bỏ\\s+)?(?:số(?:\\s+điện\\s+thoại|\\s+đt)?(?:\\s+của)?\\s+${ME}|${ME}\\s+(?:ra\\s+)?khỏi|tên\\s+${ME})`);
  add(L, F.REMOVE_FROM_LIST, "lower", `${B}(?:xóa|xoá|gỡ|loại|bỏ|đưa)[^.!?]{0,30}khỏi\\s+(?:danh\\s+sách|ds|hệ\\s+thống|list)`);
  add(L, F.UNSUBSCRIBE, "lower", `${B}(?:hủy|huỷ)\\s+(?:đăng\\s+k[ýí]|nhận\\s+tin)`);
  add(L, F.LEAVE_ALONE, "lower", `${B}để\\s+(?:cho\\s+)?${ME}\\s+(?:được\\s+)?yên${E}`);
  add(L, F.STOP_ASKING_PROPERTY, "lower", `${B}(?:đừng|ngừng|thôi)\\s+hỏi\\s+(?:${ME}\\s+)?(?:về|chuyện)\\s+(?:căn\\s+)?(?:nhà|đất|bất\\s+động\\s+sản|\\d)`);
  add(L, F.WRONG_NUMBER, "lower", `${B}(?:sai|nhầm|lộn)\\s+số${E}|${B}nhầm\\s+người${E}|${B}(?:gọi|nhắn)\\s+nhầm${E}|${B}không\\s+phải\\s+số\\s+(?:của\\s+)?(?:tôi|em|mình)${E}|${B}(?:tôi|em|mình)\\s+không\\s+(?:biết|quen)\\s+(?:người\\s+này|ai\\s+tên)`);
}

// ── Vietnamese (no-diacritic texting style; only when the message has none) ─
{
  const L = "Vietnamese";
  const ME = "(?:toi|em|anh|chi|minh|tui|tao|con|chau)";
  const COMM = "(?:nhan(?:\\s+tin)?|gui(?:\\s+tin(?:\\s+nhan)?)?|lien\\s+lac|lien\\s+he|goi(?:\\s+dien)?|lam\\s+phien|quay\\s+ray|text|spam)";
  const o = { viAscii: true };
  add(L, F.NO_CONTACT, "latin", `${B}(?:xin\\s+|lam\\s+on\\s+|vui\\s+long\\s+)?(?:dung|dung\\s+co|khong\\s+duoc|cam)\\s+${COMM}${E}`, { ...o, callVerb: /goi/ });
  add(L, F.NO_CONTACT, "latin", `${B}(?:khong|ko|k|hok)\\s+(?:can\\s+|muon\\s+)?${COMM}[^.!?]{0,20}?\\s+nua${E}`, { ...o, callVerb: /goi/ });
  add(L, F.STOP_SENDING, "latin", `${B}(?:ngung|thoi|ngung\\s+lai|dep)\\s+${COMM}${E}`, { ...o, callVerb: /goi/ });
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:xoa|go|bo|loai)\\s+(?:bo\\s+)?(?:so(?:\\s+dien\\s+thoai|\\s+dt)?(?:\\s+cua)?\\s+${ME}|${ME}\\s+(?:ra\\s+)?khoi)${E}`, o);
  add(L, F.REMOVE_FROM_LIST, "latin", `${B}(?:xoa|go|loai|bo)[^.!?]{0,30}khoi\\s+(?:danh\\s+sach|ds|he\\s+thong|list)${E}`, o);
  add(L, F.UNSUBSCRIBE, "latin", `${B}huy\\s+(?:dang\\s+k[yi]|nhan\\s+tin)${E}`, o);
  add(L, F.LEAVE_ALONE, "latin", `${B}de\\s+(?:cho\\s+)?${ME}\\s+(?:duoc\\s+)?yen${E}`, o);
  add(L, F.WRONG_NUMBER, "latin", `${B}(?:sai|nham|lon)\\s+so${E}|${B}nham\\s+nguoi${E}`, o);
}

// ── Chinese (simplified + traditional) ──────────────────────────────────────
{
  const L = "Mandarin";
  const NEG = "(?:不要|不用|别|別|勿|请勿|請勿|请不要|請不要|不准|不许|不許|甭)";
  const MSG = "(?:短信|简讯|簡訊|讯息|訊息|信息|消息|短讯|短訊|微信|text|sms)";
  const COMM = `(?:(?:发|發|传|傳|寄)(?:送)?(?:${MSG}|了|给我|給我)|联系|聯繫|聯絡|联络|打扰|打擾|骚扰|騷擾|(?<!麻)烦(?!恼|惱)|(?<!麻)煩(?!惱|恼)|打(?:电话|電話)|来电|來電|打来|打來|找我|${MSG})`;
  add(L, F.NO_CONTACT, "lower", `${NEG}\\s*再?\\s*(?:给我|給我|跟我|和我|向我|对我|對我)?\\s*${COMM}`, { callVerb: /电话|電話|来电|來電|打来|打來/ });
  add(L, F.STOP_SENDING, "lower", `(?:停止|请停止|請停止|不要再|别再|別再)\\s*(?:给我|給我|向我)?\\s*(?:发送|發送|传送|傳送|发|發|传|傳)(?:${MSG}|了)?`);
  add(L, F.STOP_SENDING, "lower", `停止(?:联系|聯繫|聯絡|联络|骚扰|騷擾|打扰|打擾|发短信|發簡訊|发信息|發訊息)`);
  add(L, F.REMOVE_FROM_LIST, "lower", `(?:把我|將我|将我|请把我|請把我)(?:的(?:号码|號碼|电话|電話|名字|资料|資料))?\\s*(?:从|從)?[^。！？!?]{0,12}?(?:删除|刪除|删掉|刪掉|删了|刪了|移除|去掉|除名|拿掉|撤掉|移出)`);
  add(L, F.REMOVE_FROM_LIST, "lower", `(?:删除|刪除|删掉|刪掉|移除|去掉)\\s*我的\\s*(?:号码|號碼|电话|電話|联系方式|聯繫方式|聯絡方式|资料|資料)`);
  add(L, F.REMOVE_FROM_LIST, "lower", `(?:从|從)(?:你们的|你們的|你的)?(?:名单|名單|列表|清单|清單|通讯录|通訊錄)(?:中|上|里|裡)?(?:删除|刪除|移除|去掉|删掉|刪掉)`);
  add(L, F.UNSUBSCRIBE, "lower", `退订|退訂|取消订阅|取消訂閱|退出(?:名单|名單)`);
  add(L, F.LEAVE_ALONE, "lower", `(?:别|別|不要)(?:再)?(?:烦|煩)我|让我清静|讓我清靜`);
  add(L, F.STOP_ASKING_PROPERTY, "lower", `${NEG}再?(?:问|問)(?:我)?(?:关于|關於)?(?:那个|那個|这个|這個)?(?:房子|房产|房產|物业|物業|地)`);
  add(L, F.WRONG_NUMBER, "lower", `打错|打錯|发错|發錯|找错人|找錯人|错号|錯號|号码错|號碼錯|(?:错误|錯誤)的?(?:号码|號碼)`);
}

// ── Korean ──────────────────────────────────────────────────────────────────
{
  const L = "Korean";
  const COMM = "(?:문자|메시지|메세지|카톡|카카오톡|연락|전화|톡|메일)";
  add(L, F.NO_CONTACT, "lower", `${COMM}\\s*(?:를|을|는|은|도|좀)?\\s*(?:더\\s*(?:이상)?\\s*|다시\\s*|두\\s*번\\s*다시\\s*)?(?:하지|보내지|주지|걸지|드리지)\\s*(?:마|말)`, { callVerb: /^전화/ });
  add(L, F.NO_CONTACT, "lower", `(?:더\\s*이상|다시는|다신)\\s*(?:${COMM}\\s*(?:을|를)?\\s*)?(?:하지|보내지|주지)\\s*(?:마|말)`, { callVerb: /전화/ });
  add(L, F.NO_CONTACT, "lower", `(?:연락|문자|전화|메시지)\\s*(?:을|를)?\\s*(?:원하지\\s*않|받고\\s*싶지\\s*않|안\\s*받)`, { callVerb: /^전화/ });
  add(L, F.NO_CONTACT, "lower", `연락\\s*사절|(?:연락|문자)\\s*금지`);
  add(L, F.STOP_SENDING, "lower", `${COMM}\\s*(?:를|을|는|은|좀)?\\s*그만\\s*(?:좀\\s*)?(?:보내|하|해|주|걸)`, { callVerb: /^전화/ });
  add(L, F.STOP_SENDING, "lower", `그만\\s*(?:좀\\s*)?(?:보내|연락|문자)`);
  add(L, F.REMOVE_FROM_LIST, "lower", `(?:번호|연락처|명단|목록|리스트|전화번호|데이터베이스)\\s*(?:에서|를|을|좀)?\\s*(?:제\\s*(?:번호|연락처|이름)\\s*(?:를|을)?\\s*)?(?:삭제|지워|지우|빼|제외|없애)`);
  add(L, F.UNSUBSCRIBE, "lower", `수신\\s*거부|수신\\s*차단|수신\\s*거절|구독\\s*취소|광고\\s*(?:거부|사절)`);
  add(L, F.LEAVE_ALONE, "lower", `귀찮게\\s*(?:좀\\s*)?(?:하지|굴지)\\s*(?:마|말)|(?:날|나를|저를|절)\\s*(?:좀\\s*)?(?:내버려|가만히?\\s*(?:둬|놔|두세요|놔두))`);
  add(L, F.STOP_ASKING_PROPERTY, "lower", `(?:집|부동산|매물|그\\s*집|주택|땅)\\s*(?:에\\s*대해(?:서)?|관련(?:해서)?|얘기|이야기)?\\s*(?:은|는|을|를)?\\s*(?:그만|더\\s*이상|다시는)\\s*(?:좀\\s*)?(?:물어|묻)`);
  add(L, F.WRONG_NUMBER, "lower", `잘못\\s*(?:된|걸린|거신|보내신|보낸|아신|알고)?\\s*(?:번호|문자|전화|연락)|번호\\s*(?:를|가)?\\s*잘못|번호\\s*(?:가\\s*)?틀렸|(?:저|전|나|난)\\s*(?:그\\s*)?(?:사람|분)\\s*(?:이|가)?\\s*(?:아니|아닌|아녜|아냐)`);
}

// ── Arabic (folded: alef / hamza / ta-marbuta / alef-maqsura / tashkeel) ──────
{
  const L = "Arabic";
  const COMM_N = "(?:ترسل|ترسلوا|ترسلو|تبعت|تبعتوا|تراسلني|تراسلوني|تتصل|تتصلوا|تزعجني|تزعجوني|مراسلتي|مراسلتنا|ارسال|الارسال|الاتصال|التواصل|ازعاجي|الازعاج|الرسايل|رسايل|المراسله|المراسلات|الرساله|المكالمات|الاتصالات)";
  add(L, F.STOP_SENDING, "arabic", `${B}(?:توقف|توقفوا|توقفي|وقف|اوقف|اوقفوا|كف|كفوا|بطل|بطلوا|يكفي|كفايه|خلاص|ارجو\\s+التوقف|الرجاء\\s+التوقف|يرجي\\s+التوقف)\\s+(?:عن\\s+|من\\s+)?${COMM_N}`, { callVerb: /الاتصال|المكالمات|الاتصالات/ });
  add(L, F.NO_CONTACT, "arabic", `${B}(?<!(?:ليش|لماذا|ليه|لما|اذا|لو)\\s)(?:لا|ما|رجاء\\s+لا|ارجوك\\s+لا|ارجو\\s+ان\\s+لا|من\\s+فضلك\\s+لا|ممنوع)\\s+(?:ترسل|ترسلوا|ترسلو|ترسلي|تبعت|تبعتوا|تبعتلي|تبعث|تبعثوا|تراسلني|تراسلوني|تراسلنا|تتصل|تتصلوا|تتصلي|تتواصل|تتواصلوا|تكتب|تكتبوا|تكتبلي|تزعجني|تزعجوني|تكلمني|تكلموني|تدق|ترن)${E}(?!\\s+(?:الا|قبل|بعد|في\\s+الصباح|بالليل|الان))(?![^.!؟?\\n]*[؟?])`, { callVerb: /تتصل|تكلم|تدق|ترن/ });
  add(L, F.NO_CONTACT, "arabic", `${B}(?:يرجي|ارجو|الرجاء|نرجو)\\s+عدم\\s+(?:الاتصال|الارسال|ارسال|مراسلتي|التواصل|ازعاجي)`, { callVerb: /الاتصال/ });
  add(L, F.NO_CONTACT, "arabic", `${B}عدم\\s+(?:الاتصال|مراسلتي|التواصل|الارسال)\\s+(?:بي|معي|لي)`, { callVerb: /الاتصال/ });
  add(L, F.NO_CONTACT, "arabic", `${B}(?:لا|ما)\\s+(?:اريد|ابغي|ابي|بدي|عايز|عاوز|اود|احب)\\s+(?:اي\\s+)?(?:رسايل|رساله|اتصال|اتصالات|تواصل|مكالمات|ان\\s+(?:تتصل|ترسل|تتواصل|يتم\\s+الاتصال|تراسلني))`, { callVerb: /اتصال|مكالمات|تتصل/ });
  add(L, F.REMOVE_FROM_LIST, "arabic", `${B}(?:احذف|احذفوا|احذفي|امسح|امسحوا|شيل|شيلوا|ازل|ازيلوا|الغي|الغوا|اشطب|اشطبوا)(?:ني|وني)?\\s+(?:رقمي|اسمي|بياناتي|رقم\\s+(?:هاتفي|تلفوني|جوالي|موبايلي)|(?:من|عن)\\s+(?:ال)?(?:قايمه|قايمتكم|قايمتك|قوايم|لسته|ليست|قاعده\\s+البيانات|سجل|سجلات|نظام))`);
  add(L, F.REMOVE_FROM_LIST, "arabic", `${B}(?:احذفني|احذفوني|امسحني|امسحوني|شيلني|شيلوني|ازلني|ازيلوني|اشطبني|اشطبوني)${E}`);
  add(L, F.UNSUBSCRIBE, "arabic", `${B}الغاء\\s+(?:ال)?(?:اشتراك|تسجيل)|${B}الغي\\s+(?:ال)?اشتراك`);
  add(L, F.LEAVE_ALONE, "arabic", `${B}(?:اتركني|اتركوني|سيبني|سيبوني|دعني|دعوني)\\s+(?:وشاني|في\\s+حالي|بحالي|بحال\\s+سبيلي)|${B}(?:خليني|خلوني)\\s+(?:في\\s+حالي|بحالي)`);
  add(L, F.STOP_ASKING_PROPERTY, "arabic", `${B}(?:توقف|كف|بطل)\\S*\\s+عن\\s+(?:السوال|سوالي|الاسيله)\\s+عن\\s+(?:ال)?(?:بيت|منزل|عقار|ارض|شقه|\\d)`);
  add(L, F.WRONG_NUMBER, "arabic", `${B}(?:رقم|الرقم)\\s+(?:خطا|خاطي|غلط|غير\\s+صحيح)${E}|${B}(?:ليس|مش|مو)\\s+(?:انا|رقمي)${E}|${B}غلطان\\s+(?:في|ب)\\s*الرقم|${B}(?:اتصلت|ارسلت)\\s+(?:علي|الي|ل)?\\s*(?:ال)?رقم\\s+(?:ال)?(?:خطا|غلط)`);
}

// ── Russian (ё folded) ──────────────────────────────────────────────────────
{
  const L = "Russian";
  const COMM = "(?:писать|звонить|присылать|отправлять|слать|беспокоить|названивать|спамить|донимать|надоедать|тревожить|рассылать|смс\\S*|сообщени\\S*|эсэмэски)";
  add(L, F.STOP_SENDING, "cyr", `${B}(?:перестаньте|перестань|прекратите|прекрати|хватит|хорош|завязывайте|кончайте)\\s+(?:(?:мне|уже|пожалуйста|меня|наконец)\\s+){0,3}${COMM}`, { callVerb: /звонить|названивать/ });
  add(L, F.NO_CONTACT, "cyr", `${B}(?<!(?:почему|если|зачем)\\s)(?:не|больше\\s+не|никогда\\s+не|прошу\\s+не|просьба\\s+не|больше\\s+никогда\\s+не)\\s+(?:пишите|пиши|звоните|звони|беспокойте|беспокой|присылайте|присылай|отправляйте|шлите|шли|тревожьте|названивайте|связывайтесь|связывайся|донимайте|спамьте|писать|звонить|беспокоить)${E}(?!\\s+(?:после|до|утром|вечером|ночью|рано|поздно|по\\s+выходным|в\\s+выходные|сейчас|сегодня))`, { callVerb: /звон|названива/ });
  add(L, F.NO_CONTACT, "cyr", `${B}не\\s+надо\\s+(?:мне\\s+|больше\\s+)*(?:писать|звонить|беспокоить|присылать|слать)${E}`, { callVerb: /звонить/ });
  add(L, F.NO_CONTACT, "cyr", `${B}(?:не\\s+хочу|не\\s+желаю|не\\s+хотим)\\s+(?:больше\\s+)?(?:получать\\s+)?(?:никаких\\s+|ваших\\s+|ваши\\s+|этих\\s+)?(?:сообщени\\S*|смс\\S*|звонк\\S*|рассылк\\S*|писем|чтобы\\s+(?:мне\\s+)?(?:писали|звонили))`, { callVerb: /звонк|звонили/ });
  add(L, F.REMOVE_FROM_LIST, "cyr", `${B}(?:удалите|удали|уберите|убери|исключите|исключи|вычеркните|вычеркни|сотрите|сотри)\\s+(?:(?:пожалуйста|мой|мои)\\s+)*(?:меня|номер|мой\\s+номер|мои\\s+данные|мой\\s+телефон|мой\\s+контакт)${E}`);
  add(L, F.REMOVE_FROM_LIST, "cyr", `${B}(?:удал|убер|исключ|вычеркн)\\S*\\s+${GAP(30)}из\\s+(?:списка|базы|рассылки|контактов|вашего\\s+списка|вашей\\s+базы)${E}`);
  add(L, F.UNSUBSCRIBE, "cyr", `${B}(?:отписа\\S*|отпишите|отписка)`);
  add(L, F.LEAVE_ALONE, "cyr", `${B}оставь(?:те)?\\s+меня\\s+в\\s+покое|${B}(?:отстаньте|отстань|отвяжитесь|отвяжись)${E}`);
  add(L, F.STOP_ASKING_PROPERTY, "cyr", `${B}(?:перестаньте|хватит|прекратите|не)\\s+(?:спрашивать|расспрашивать|спрашивайте)\\s+(?:меня\\s+)?(?:про|о|об|насчет)\\s+(?:мо\\S+\\s+|эт\\S+\\s+)?(?:дом\\S*|квартир\\S*|участ\\S*|недвижимост\\S*|\\d)`);
  add(L, F.WRONG_NUMBER, "cyr", `${B}(?:ошиблись|ошибся|ошиблась)\\s+номером${E}|${B}не\\s+тот\\s+номер${E}|${B}(?:неправильный|неверный|чужой)\\s+номер${E}|${B}это\\s+не\\s+я${E}|${B}не\\s+знаю\\s+(?:такого|такую|этого|эту)\\s+(?:человека|женщину|мужчину)${E}`);
}

// ── English: the one gap in the English lists — a stop on OUR questions about a
// property named by address ("stop asking about 123 Main St"); the existing
// owner rule makes a stop on our outreach about a property an opt-out.
{
  add("English", F.STOP_ASKING_PROPERTY, "latin", `${B}(?:stop|quit|cease|no\\s+more)\\s+(?:asking|inquiring|questioning)\\s+(?:me\\s+|us\\s+)?(?:about|regarding|re:?|on|for|over)\\s+(?:\\d{1,6}\\s+[a-z]|(?:my|the|that|this|our|his|her|their)\\s+(?:house|home|property|properties|land|lot|place|building|duplex|triplex|condo|apartment|unit|rental|parcel|farm|mobile\\s+home|trailer))`);
}

// ── whole-message keywords (folded comparison) ──────────────────────────────
const EXACT = new Map();
const exact = (language, family, words) => {
  for (const w of words) EXACT.set(revocationViews(w).latin.replace(/[^\p{L}\p{M}\p{N}' -]+/gu, "").trim(), { language, family });
};
exact("Spanish", F.REMOVE_FROM_LIST, ["quíteme", "quítenme", "quítame", "quitenme", "sácame", "sáqueme", "sáquenme", "bórrame", "bórreme", "bórrenme", "elimíname", "elimíneme", "elimínenme", "remuévame", "remuévanme", "quitarme de la lista", "sacarme de la lista"]);
exact("Spanish", F.UNSUBSCRIBE, ["darme de baja", "dame de baja", "denme de baja", "deme de baja", "desuscribir", "desuscribirme", "desuscríbanme"]);
exact("Portuguese", F.UNSUBSCRIBE, ["descadastre", "descadastrar", "descadastre-me", "me descadastre", "parem", "me tira da lista", "me tire da lista"]);
exact("French", F.UNSUBSCRIBE, ["désabonnement", "désinscription", "retirez-moi", "supprimez-moi", "désabonnez-moi", "désinscrivez-moi"]);
exact("Italian", F.UNSUBSCRIBE, ["toglimi", "toglietemi", "rimuovimi", "rimuovetemi", "disiscrivimi", "cancellatemi"]);
exact("Polish", F.UNSUBSCRIBE, ["wypisz", "wypiszcie mnie", "usuń mnie", "usuńcie mnie"]);
exact("Haitian Creole", F.STOP_SENDING, ["sispann", "sispan", "kanpe", "tanpri sispann", "sispann tanpri", "dezabone", "dezabone m"]);
exact("Tagalog", F.STOP_SENDING, ["tigil", "itigil", "tigilan nyo na", "tigilan niyo na", "stop na po", "stop po", "unsubscribe po"]);
exact("Vietnamese", F.UNSUBSCRIBE, ["hủy đăng ký", "huỷ đăng ký", "ngừng nhắn tin", "dung nhan tin", "huy dang ky"]);
exact("Korean", F.UNSUBSCRIBE, ["수신거부", "수신 거부", "수신차단"]);
exact("Arabic", F.UNSUBSCRIBE, ["الغاء الاشتراك", "إلغاء الاشتراك", "احذفني"]);
exact("Russian", F.UNSUBSCRIBE, ["отписаться", "отписка", "отпишите", "отпишите меня"]);
exact("Mandarin", F.UNSUBSCRIBE, ["退订", "退訂", "取消订阅", "取消訂閱"]);

// ── fail-safe family tokens (a stop / remove / contact-negation token, no family) ──
// Non-English only. Never the plain-disinterest vocabulary ("no me interesa",
// "não tenho interesse"), never a bare "no".
const TOKENS = [
  ["Spanish", "latin", `${B}(?:quit|saqu|borr|elimin|remuev)[a-z]*(?:me|nme|nos)${E}|${B}(?:dej|par)(?:a|e|en)\\s+de\\s+[a-z]+(?:rme|rnos)${E}|${B}bloque(?:ar|o|e|en|ado|are)[a-z]*${E}|${B}acoso${E}|${B}lista\\s+negra${E}|${B}(?:insist|joder|chingar|fregar)[a-z]*(?:me|nos)${E}`],
  ["Portuguese", "latin", `${B}(?:tir|remov|exclu|apag)[a-z]*-me${E}|${B}me\\s+(?:tir|remov|exclu|apag)[a-z]+${E}|${B}(?:nao|n)\\s+(?:me\\s+)?(?:mande|envie|escreva|ligue|contate|incomode|perturbe)[a-z]*${E}(?!\\s+mais\\s+(?:tarde|cedo))|${B}parem${E}|${B}bloque(?:ar|ei|io)${E}`],
  ["French", "latin", `${B}(?:arret|cess)(?:e|es|ez|er)${E}|${B}(?:supprim|retir|enlev|effac)[a-z]*[- ]moi${E}|${B}(?:desabonn|desinscri)[a-z]*|${B}harcel[a-z]*|${B}ne\\s+(?:me\\s+|m')[a-z]+\\s+plus${E}`],
  ["Haitian Creole", "latin", `${B}(?:sispann|sispan|sipann|sispanm)${E}|${B}kanpe\\s+(?:voye|ekri|rele)${E}|${B}(?:efase|retire|wete)\\s+(?:m|mwen|nimewo)${E}|${B}pa\\s+[a-z]+\\s+(?:m|mwen)\\s+(?:anko|enko)${E}|${B}deranje\\s+(?:m|mwen)${E}|${B}anmede${E}`],
  ["Italian", "latin", `${B}smett[a-z]+${E}|${B}(?:togli|cancell|rimuov)[a-z]*(?:mi|temi)${E}|${B}non\\s+mi\\s+(?:scriv|chiam|contatt|cerc|disturb)[a-z]*${E}`],
  ["Polish", "latin", `${B}przesta[nc][a-z]*${E}|${B}(?:usun|usuncie|usunac)${E}|${B}wypis[a-z]*${E}|${B}w\\s+spokoju${E}|${B}nie\\s+(?:pisz|dzwon|kontaktuj)[a-z]*${E}`],
  ["Tagalog", "latin", `${B}(?:tigil[a-z]*|itigil|tanggal[a-z]*|pakitanggal|alisin|burahin|pakibura|lubayan|tantanan|istorbo[a-z]*|nangungulit|makulit)${E}`],
  ["Vietnamese", "lower", `ngừng|(?<!đã\\s)(?:xóa|xoá)|hủy|huỷ|(?<!lỗi\\s)làm\\s+phiền|quấy\\s+rầy|danh\\s+sách`],
  ["Vietnamese", "latin", `${B}(?:ngung|xoa|lam\\s+phien|danh\\s+sach|quay\\s+ray)${E}`, { viAscii: true }],
  ["Mandarin", "lower", `停止|删除|刪除|移除|退订|退訂|骚扰|騷擾|(?<!麻)烦我|(?<!麻)煩我|名单|名單|别再发|別再發|不要再发|不要再發|别再联系|別再聯繫`],
  ["Korean", "lower", `그만(?![큼두한])|중지|중단|삭제|지워|빼\\s*주|거부|차단|보내지\\s*마|귀찮`],
  ["Arabic", "arabic", `${B}(?:توقف|توقفوا|كفوا|بطل|بطلوا|احذف|امسح|شيلني|شيلوني|الغاء|ازعاج|ازعاجي|اتركني|اتركوني)${E}|${B}عدم\\s+ال`],
  ["Russian", "cyr", `${B}(?:перестан\\S*|прекрат\\S*|отпис\\S*|удалите|удали|отстан\\S*|спам\\S*)|${B}в\\s+покое${E}`],
].map(([language, view, source, opts = {}]) => ({ language, view, re: new RegExp(source, "iu"), ...opts }));

// ── carves ──────────────────────────────────────────────────────────────────
/** A text affirmative ("text me instead") — with a CALL-only prohibition it is a channel preference. */
const TEXT_AFFIRMATIVE = [
  /(?<![\p{L}])(?:escrib(?:a|e|ame|eme|anme|enme|ime|ime)|mand(?:a|e|en)(?:me)?\s+(?:un\s+)?(?:mensaje|texto|msj|whats\w*)|por\s+(?:texto|mensaje|whats\w*|aqui|aca)|mejor\s+(?:texto|mensaje|escrib\w*)|solo\s+(?:texto|mensajes)|textea(?:me)?|texteame)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:me\s+mande\s+mensagem|manda\s+mensagem|por\s+mensagem|so\s+mensagem|me\s+escreva|pode\s+mandar\s+mensagem|(?:so|apenas)\s+por\s+(?:mensagem|texto|whats\w*))(?![\p{L}])/iu,
  /(?<![\p{L}])(?:ecrivez[- ]moi|envoyez[- ]moi\s+un\s+(?:message|sms|texto)|par\s+(?:sms|message|texto)|textez[- ]moi)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:ekri\s+m(?:wen)?\s+pito|voye\s+mesaj\s+pito|tekste\s+m)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:mi\s+scriva|scrivimi|scrivetemi|mandatemi\s+un\s+messaggio|per\s+messaggio)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:napisz|piszcie|prosze\s+pisac|tylko\s+sms)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:text\s+na\s+lang|i-?text\s+(?:mo|nyo)\s+na\s+lang|mag-?text\s+na\s+lang)(?![\p{L}])/iu,
  /(?:nhắn\s+tin\s+(?:được|thôi)|cứ\s+nhắn\s+tin|nhan\s+tin\s+(?:duoc|thoi))/iu,
  /(?:发短信就行|發簡訊就好|发信息吧|發訊息吧|发短信吧)/u,
  /(?:문자\s*(?:로|는)?\s*(?:주세요|괜찮|해\s*주세요|보내\s*주세요))/u,
  /(?:راسلني|ارسل\s+رساله|ابعتلي\s+رساله)/u,
  /(?<![\p{L}])(?:пишите|напишите|лучше\s+смс)(?![\p{L}])/iu,
];

const TEXT_VERB_IN_SPAN = /mand|envi|escrib|escrev|mensag|mensaj|text|sms|ecri|envoy|messag|scriv|pisa|wysy|nhắn|gửi|nhan\s|gui\s|发|發|短信|簡訊|信息|訊息|문자|메시지|메세지|카톡|ترسل|رسا|راسل|تكتب|пис|сообщ|смс|voye|ekri|mesaj|tekst|kontak/iu;

function viewText(v, view) {
  return view === "latin" ? v.latin : view === "arabic" ? v.arabic : view === "cyr" ? v.cyr : v.lower;
}

function matchesTextAffirmative(v) {
  return TEXT_AFFIRMATIVE.some((re) => re.test(v.latin) || re.test(v.lower) || re.test(v.arabic));
}

const ruleId = (family, language) => `ml_${family}_${String(language).split(" ")[0].toLowerCase()}`;

/**
 * Every family match in the message (opt-out families + wrong number), the
 * channel-preference carve applied.
 */
function collectMatches(v) {
  const hits = [];
  for (const rule of RULES) {
    if (rule.viAscii && !v.vi_ascii) continue;
    // every occurrence: "не звоните и не пишите" is a call AND a text prohibition
    for (const m of viewText(v, rule.view).matchAll(rule.all)) {
    // call-only = the span names a CALL verb and no text / message verb ("no me ligue nem me mande
    // mensagem" is one span carrying both: never call-only)
    hits.push({ language: rule.language, family: rule.family, span: m[0].trim(), call_only: Boolean(rule.callVerb && rule.callVerb.test(m[0]) && !TEXT_VERB_IN_SPAN.test(m[0])) });
    }
  }
  return hits;
}

/**
 * @returns {{
 *   opt_out: null | { language, family, rule_id, kind: 'phrase'|'keyword', span, version },
 *   wrong_number: null | { language, family, rule_id, span, version },
 *   possible_opt_out: null | { language, family, rule_id, token, version },
 *   carved: null | 'channel_preference',
 *   version: string,
 * }}
 */
export function analyzeContactRevocation(message = "") {
  const out = { opt_out: null, wrong_number: null, possible_opt_out: null, carved: null, version: MULTILINGUAL_CONTACT_REVOCATION_VERSION };
  const v = revocationViews(message);
  if (!v.lower) return out;

  const bare = v.latin.replace(/^[^\p{L}\p{M}\p{N}]+/u, "").replace(/[^\p{L}\p{M}\p{N}]+$/u, "").replace(/[^\p{L}\p{M}\p{N}' -]+/gu, "").trim();
  const keyword = EXACT.get(bare) || EXACT.get(v.lower.replace(/^[^\p{L}\p{M}\p{N}]+/u, "").replace(/[^\p{L}\p{M}\p{N}]+$/u, ""));
  if (keyword) {
    out.opt_out = { language: keyword.language, family: keyword.family, rule_id: `${ruleId(keyword.family, keyword.language)}_keyword`, kind: "keyword", span: bare, version: MULTILINGUAL_CONTACT_REVOCATION_VERSION };
    return out;
  }

  const hits = collectMatches(v);
  const optHits = hits.filter((h) => OPT_OUT_FAMILIES.has(h.family));
  // Channel preference: every revocation is about CALLS, and they ask for text instead.
  if (optHits.length && optHits.every((h) => h.call_only) && matchesTextAffirmative(v)) {
    out.carved = "channel_preference";
  } else if (optHits.length) {
    const h = optHits[0];
    out.opt_out = { language: h.language, family: h.family, rule_id: ruleId(h.family, h.language), kind: "phrase", span: h.span, version: MULTILINGUAL_CONTACT_REVOCATION_VERSION };
  }
  const wrong = hits.find((h) => h.family === F.WRONG_NUMBER);
  if (wrong) out.wrong_number = { language: wrong.language, family: wrong.family, rule_id: ruleId(wrong.family, wrong.language), span: wrong.span, version: MULTILINGUAL_CONTACT_REVOCATION_VERSION };

  if (!out.opt_out && !out.carved && !out.wrong_number) {
    for (const t of TOKENS) {
      if (t.viAscii && !v.vi_ascii) continue;
      const m = t.re.exec(viewText(v, t.view));
      if (m) {
        out.possible_opt_out = { language: t.language, family: F.POSSIBLE_OPT_OUT, rule_id: ruleId(F.POSSIBLE_OPT_OUT, t.language), token: m[0].trim(), version: MULTILINGUAL_CONTACT_REVOCATION_VERSION };
        break;
      }
    }
  }
  return out;
}

// ── channel preference (deterministic, every language) ───────────────────────
// "Don't call, text is fine" / "No me llames, mándame un mensaje" / "Pa rele m, ekri m pito":
// a prohibition of CALLS only, with an explicit text affirmative, is a channel preference —
// never an SMS opt-out. Any text / contact prohibition anywhere ("don't call or text",
// "no me llamen ni me escriban") keeps it an opt-out.
const EN_CALL_ONLY = /\b(?:do\s*n[o'’]?t|never|stop|quit|no|please\s+don'?t)\s+(?:call(?:ing)?(?:\s+me)?|phone\s+calls?|calls)\b/i;
const EN_TEXT_OK = /\b(?:text(?:ing)?\s+(?:is\s+)?(?:fine|ok|okay|better|good|works|only|instead)|texts?\s+(?:are|is)\s+(?:fine|ok|okay|better)|text\s+me|just\s+text|text\s+only|prefer\s+(?:to\s+)?text|rather\s+text|you\s+can\s+text|send\s+(?:me\s+)?a\s+text|message\s+me)\b/i;
const EN_TEXT_PROHIBITION = /\b(?:do\s*n[o'’]?t|never|stop|quit|no\s+more)\s+(?:text|texting|message|messaging|msg|contact|contacting|sms|writing)|\bunsubscribe\b|\bremove\s+me\b|\bopt[\s-]?out\b|\bleave\s+me\s+alone\b|\btake\s+me\s+off\b|\bcall(?:ing)?(?:\s+me)?\s+(?:or|and|n|&|nor)\s+(?:me\s+)?text|\btext(?:ing)?(?:\s+me)?\s+(?:or|and|nor)\s+(?:me\s+)?call/i;

export function isChannelPreferenceOnly(message = "") {
  const text = String(message ?? "");
  if (!text.trim() || EN_TEXT_PROHIBITION.test(text)) return false;
  if (EN_CALL_ONLY.test(text) && EN_TEXT_OK.test(text)) return true;
  return analyzeContactRevocation(text).carved === "channel_preference";
}

export default analyzeContactRevocation;
