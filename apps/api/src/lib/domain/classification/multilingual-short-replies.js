// ─── multilingual-short-replies.js ───────────────────────────────────────────
// We SEND in 16 languages but the classifier only understood English and
// Spanish. Live case (2026-10-06 00:25 UTC, Minneapolis): "是" (Mandarin "yes")
// to our ownership question was language=Mandarin but intent=unclear@0.6, so
// the seller got no reply.
//
// This module maps a reply written in one of the templated non-English /
// non-Spanish languages onto the canonical ENGLISH phrase the existing
// pipeline already understands ("是" -> "yes", "不卖" -> "not for sale",
// "停止" -> "stop", "50万" -> "500000"). Every downstream rule (compliance,
// context binding, routing, review gates) then runs unchanged on that phrase,
// while the reply language stays the seller's.
//
// Precedence (highest first): opt_out > wrong_number > sold > not_interested >
// who_is_this > offer_request > price > affirmative > negative > thanks.
// Opt-out phrases match ANYWHERE in the message; the short answers match the
// WHOLE message only (after normalisation), so "是" binds but a long sentence
// containing 是 does not.
//
// Romanised forms ("hai", "da", "haan") collide with other languages, so they
// only apply when OUR last outbound was written in that language.
//
// English and Spanish are deliberately absent: they have their own, richer
// rules in classify.js. Words shared with Spanish ("claro", "no", "si") are
// left out so a Spanish reply is never relabelled.

export const MULTILINGUAL_SHORT_REPLY_VERSION = "multilingual_short_replies_v1";

const CANONICAL = Object.freeze({
  opt_out: "stop",
  wrong_number: "wrong number",
  sold: "I sold it",
  not_interested: "not for sale",
  who_is_this: "who is this?",
  offer_request: "what is your offer?",
  affirmative: "yes",
  negative: "no",
  thanks: "thanks",
});

const PRECEDENCE = [
  "opt_out",
  "wrong_number",
  "sold",
  "not_interested",
  "who_is_this",
  "offer_request",
  "affirmative",
  "negative",
  "thanks",
];

// Scripts written without spaces between words (or that attach particles):
// phrases match as substrings. Everything else matches on letter boundaries.
const NO_BOUNDARY_SCRIPT_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯ᄀ-ᇿ]/u;

// exact: whole message. phrases: anywhere in the message. romanized: exact,
// only when the thread language is this language.
const LEXICON = {
  Mandarin: {
    affirmative: { exact: ["是", "是的", "对", "對", "对的", "對的", "是我", "我是", "嗯", "嗯嗯", "好", "好的", "没错", "沒錯", "是啊", "对啊", "對啊", "是的我是", "我是业主", "我是業主", "我是房主", "是我的", "对是我", "是的是我"] },
    negative: { exact: ["不", "不是", "没有", "沒有", "不对", "不對"] },
    not_interested: { phrases: ["不卖", "不賣", "不出售", "不感兴趣", "不感興趣", "没兴趣", "沒興趣", "不想卖", "不想賣", "不打算卖", "不打算賣"] },
    wrong_number: { phrases: ["打错了", "打錯了", "发错了", "發錯了", "不是我的", "我不是业主", "我不是業主", "我不是房主", "不是业主", "不是業主", "号码错了", "號碼錯了", "找错人", "找錯人"] },
    sold: { phrases: ["已经卖了", "已經賣了", "卖掉了", "賣掉了", "已售出"] },
    who_is_this: { phrases: ["你是谁", "你是誰", "哪位", "谁啊", "誰啊", "你怎么有我的号码", "你怎麼有我的號碼", "为什么问", "為什麼問", "有什么事", "有什麼事", "什么事", "什麼事"] },
    offer_request: { phrases: ["多少钱", "多少錢", "你出多少", "出价多少", "出價多少", "报价", "報價", "给个价", "給個價", "你的价格", "你的價格", "开个价", "開個價"] },
    thanks: { exact: ["谢谢", "謝謝", "多谢", "多謝", "谢谢你", "謝謝你", "感谢", "感謝"] },
    opt_out: { phrases: ["停止", "别再发", "別再發", "不要再联系", "不要再聯繫", "不要再联络", "不要再發", "不要再发", "别发了", "別發了", "不要发了", "不要發了", "别再联系", "別再聯繫", "退订", "退訂", "取消订阅", "取消訂閱", "别烦我", "別煩我", "不要打扰", "不要打擾", "删除我的号码", "刪除我的號碼", "别再打扰", "別再打擾"] },
    romanized: { affirmative: ["shi", "shi de", "dui", "dui de"], negative: ["bu", "bu shi"], thanks: ["xie xie", "xiexie"], opt_out: ["ting zhi", "bie fa le"] },
  },
  Japanese: {
    affirmative: { exact: ["はい", "ええ", "そうです", "はいそうです", "はい、そうです", "うん", "私です", "はい私です", "はい、私です", "そう"] },
    negative: { exact: ["いいえ", "いや", "違います", "ちがいます", "違う"] },
    not_interested: { phrases: ["売りません", "売らない", "売る気はない", "興味ない", "興味ありません", "結構です", "けっこうです"] },
    wrong_number: { phrases: ["番号違い", "人違い", "間違いです", "私のではありません", "所有者ではありません", "持っていません", "間違い電話"] },
    sold: { phrases: ["売却済み", "もう売りました", "売りました"] },
    who_is_this: { phrases: ["誰ですか", "どなたですか", "どちら様", "どちらさま", "だれですか", "なぜですか", "なんで", "何の用"] },
    offer_request: { phrases: ["いくら", "価格は", "値段は", "金額は", "提示して"] },
    thanks: { exact: ["ありがとう", "ありがとうございます", "どうも", "どうもありがとう"] },
    opt_out: { phrases: ["やめて", "止めて", "送らないで", "連絡しないで", "配信停止", "停止して", "もう送らないで", "メッセージ不要"] },
    romanized: { affirmative: ["hai", "hai sou desu"], negative: ["iie"], thanks: ["arigatou", "arigato"], opt_out: ["yamete"] },
  },
  Korean: {
    affirmative: { exact: ["네", "예", "넵", "응", "맞아요", "맞습니다", "네 맞아요", "네 맞습니다", "제가 주인입니다", "네 제가 주인입니다", "맞아"] },
    negative: { exact: ["아니요", "아니오", "아뇨", "아니"] },
    not_interested: { phrases: ["안 팔아요", "안팔아요", "안 팝니다", "팔지 않", "관심 없", "관심없", "안 팔"] },
    wrong_number: { phrases: ["잘못 보내", "번호 잘못", "잘못된 번호", "제 집이 아니", "주인이 아니", "소유자가 아니", "제 것이 아니"] },
    sold: { phrases: ["팔았어요", "이미 팔았", "팔렸어요", "매각했"] },
    who_is_this: { phrases: ["누구세요", "누구시죠", "누구신가요", "누구야", "왜요", "왜 물어", "번호 어떻게"] },
    offer_request: { phrases: ["얼마", "가격이", "제안해", "가격 제시"] },
    thanks: { exact: ["감사합니다", "고맙습니다", "감사해요", "고마워요", "고마워"] },
    opt_out: { exact: ["그만", "그만해", "그만하세요", "그만해요"], phrases: ["그만 보내", "그만하세요", "그만 연락", "그만 좀", "연락하지 마", "문자 보내지 마", "보내지 마세요", "보내지마", "수신거부", "수신 거부", "차단할", "연락 하지 마"] },
    romanized: { affirmative: ["ne", "ye"], negative: ["aniyo", "anio"], thanks: ["kamsahamnida", "gomawo"], opt_out: ["geuman"] },
  },
  Vietnamese: {
    affirmative: { exact: ["có", "vâng", "dạ", "đúng", "đúng rồi", "phải", "dạ phải", "vâng ạ", "dạ vâng", "có ạ", "đúng vậy", "phải rồi", "dạ đúng rồi"] },
    negative: { exact: ["không", "không phải", "hông", "không ạ"] },
    not_interested: { phrases: ["không bán", "khong ban", "không muốn bán", "khong muon ban", "không quan tâm", "khong quan tam"] },
    wrong_number: { phrases: ["nhầm số", "nham so", "sai số", "sai so", "không phải nhà tôi", "không phải của tôi", "khong phai cua toi", "tôi không phải chủ"] },
    sold: { phrases: ["đã bán rồi", "da ban roi", "bán rồi", "ban roi"] },
    who_is_this: { phrases: ["ai vậy", "ai vay", "ai đấy", "ai day", "bạn là ai", "ban la ai", "ai đó", "sao hỏi", "tại sao hỏi", "lấy số ở đâu"] },
    offer_request: { phrases: ["bao nhiêu", "bao nhieu", "giá bao nhiêu", "trả giá", "tra gia", "ra giá"] },
    thanks: { exact: ["cảm ơn", "cám ơn", "cam on", "cảm ơn bạn", "cám ơn bạn", "cảm ơn ạ"] },
    opt_out: { phrases: ["dừng lại", "dung lai", "đừng nhắn", "dung nhan", "ngừng nhắn", "ngung nhan", "đừng liên lạc", "dung lien lac", "không nhắn nữa", "xóa số", "xoa so", "đừng gửi", "dung gui"] },
    romanized: { affirmative: ["co", "vang", "da", "dung roi", "phai"], negative: ["khong", "khong phai", "ko"] },
  },
  Polish: {
    affirmative: { exact: ["tak", "tak jest", "zgadza się", "zgadza sie", "owszem", "to ja", "tak to ja", "tak, to ja", "oczywiście", "oczywiscie"] },
    negative: { exact: ["nie"] },
    not_interested: { phrases: ["nie sprzedaję", "nie sprzedaje", "nie na sprzedaż", "nie na sprzedaz", "nie jestem zainteresowany", "nie jestem zainteresowana", "nie interesuje mnie"] },
    wrong_number: { phrases: ["pomyłka", "pomylka", "zły numer", "zly numer", "to nie mój dom", "nie jestem właścicielem", "nie jestem wlascicielem", "nie jestem właścicielką"] },
    sold: { phrases: ["sprzedałem", "sprzedalem", "sprzedałam", "już sprzedane", "juz sprzedane"] },
    who_is_this: { phrases: ["kto to", "kim jesteś", "kim jestes", "kim pan jest", "kto pisze", "dlaczego pytasz", "skąd masz mój numer", "skad masz moj numer"] },
    offer_request: { phrases: ["jaka cena", "ile oferujesz", "ile pan oferuje", "jaka oferta", "ile dasz"] },
    thanks: { exact: ["dziękuję", "dziekuje", "dzięki", "dzieki", "dziękuję bardzo"] },
    opt_out: { phrases: ["przestań", "przestan", "przestańcie", "przestancie", "nie pisz", "nie piszcie", "nie kontaktuj", "usuń mój numer", "usun moj numer", "wypisz mnie"] },
  },
  Hebrew: {
    affirmative: { exact: ["כן", "כן זה אני", "נכון", "בטח", "כן אני", "זה אני"] },
    negative: { exact: ["לא"] },
    not_interested: { phrases: ["לא למכירה", "לא מעוניין", "לא מעוניינת", "לא מוכר", "לא מוכרת"] },
    wrong_number: { phrases: ["מספר שגוי", "טעות במספר", "זה לא אני", "לא הבית שלי", "אני לא הבעלים"] },
    sold: { phrases: ["מכרתי", "כבר נמכר"] },
    who_is_this: { phrases: ["מי זה", "מי אתה", "מי זאת", "למה אתה שואל", "מאיפה יש לך את המספר"], exact: ["למה"] },
    offer_request: { phrases: ["מה המחיר", "כמה אתה מציע", "מה ההצעה"], exact: ["כמה"] },
    thanks: { exact: ["תודה", "תודה רבה"] },
    opt_out: { phrases: ["תפסיק", "תפסיקו", "אל תשלח", "אל תכתוב", "תמחק את המספר", "תסיר אותי", "הסר אותי"], exact: ["די", "הסר"] },
  },
  Italian: {
    affirmative: { exact: ["sì", "certo", "esatto", "sì sono io", "sono io", "sì certo", "sì, sono io", "certamente"] },
    not_interested: { phrases: ["non vendo", "non è in vendita", "non e in vendita", "non mi interessa", "non sono interessato", "non sono interessata"] },
    wrong_number: { phrases: ["numero sbagliato", "non sono il proprietario", "non sono la proprietaria", "non è mia", "non e mia"] },
    sold: { phrases: ["l'ho venduta", "l'ho venduto", "già venduta", "gia venduta", "già venduto"] },
    who_is_this: { phrases: ["chi è", "chi e", "chi sei", "chi parla", "come hai il mio numero"], exact: ["perché", "perche", "perché?"] },
    offer_request: { phrases: ["quanto offri", "quanto mi dai", "qual è l'offerta", "fammi un'offerta", "quanto offrite"] },
    thanks: { exact: ["grazie", "grazie mille"] },
    opt_out: { phrases: ["smettila", "smetti di scrivere", "non scrivermi", "non mi scrivere", "non contattarmi", "cancella il mio numero", "non mi contattare"] },
  },
  Arabic: {
    affirmative: { exact: ["نعم", "أيوه", "ايوه", "ايوا", "أجل", "اجل", "صحيح", "نعم أنا", "نعم انا", "اي", "أي"] },
    negative: { exact: ["لا", "لأ"] },
    not_interested: { phrases: ["ليست للبيع", "ليس للبيع", "مش للبيع", "غير مهتم", "مش مهتم", "لا أريد البيع", "لا اريد البيع", "ما ابيع"] },
    wrong_number: { phrases: ["رقم خطأ", "رقم غلط", "لست المالك", "ليس لي", "مش انا"], exact: ["غلط"] },
    sold: { phrases: ["بعته", "بعتها", "تم البيع"] },
    who_is_this: { phrases: ["من أنت", "من انت", "مين انت", "من معي", "من وين جبت رقمي"], exact: ["مين", "لماذا", "ليش", "ليه"] },
    offer_request: { phrases: ["كم السعر", "ما هو عرضك", "كم تدفع"], exact: ["كم"] },
    thanks: { exact: ["شكرا", "شكراً", "شكرا لك", "شكراً لك"] },
    opt_out: { phrases: ["توقف", "توقفوا", "لا ترسل", "لا تراسلني", "لا تتصل", "احذف رقمي", "بس خلاص"], exact: ["كفى", "بس"] },
  },
  Russian: {
    affirmative: { exact: ["да", "да это я", "да, это я", "конечно", "верно", "ага", "да я"] },
    negative: { exact: ["нет", "неа"] },
    not_interested: { phrases: ["не продаю", "не продается", "не продаётся", "не интересует", "не интересно", "не продаем", "не продаём"] },
    wrong_number: { phrases: ["не тот номер", "ошиблись номером", "неправильный номер", "я не владелец", "не мой дом"] },
    sold: { phrases: ["я продал", "я продала", "мы продали", "уже продал", "уже продан", "уже продана"] },
    who_is_this: { phrases: ["кто это", "кто вы", "кто пишет", "почему спрашиваете", "откуда у вас мой номер"], exact: ["зачем", "почему"] },
    offer_request: { phrases: ["какая цена", "ваше предложение", "предложите цену", "сколько предложите"], exact: ["сколько"] },
    thanks: { exact: ["спасибо", "спс", "благодарю"] },
    opt_out: { phrases: ["стоп", "хватит", "не пишите", "не пиши", "перестаньте", "прекратите", "отпишите", "удалите мой номер", "не беспокойте"] },
    romanized: { affirmative: ["da"], negative: ["net"], thanks: ["spasibo"], opt_out: ["hvatit", "khvatit"] },
  },
  French: {
    affirmative: { exact: ["oui", "ouais", "oui c'est moi", "c'est moi", "tout à fait", "bien sûr", "oui, c'est moi"] },
    negative: { exact: ["non"] },
    not_interested: { phrases: ["pas à vendre", "pas a vendre", "je ne vends pas", "pas intéressé", "pas interesse", "ça ne m'intéresse pas", "ca ne m'interesse pas"] },
    wrong_number: { phrases: ["mauvais numéro", "mauvais numero", "ce n'est pas moi", "je ne suis pas le propriétaire", "je ne suis pas le proprietaire"] },
    sold: { phrases: ["déjà vendue", "deja vendue", "j'ai vendu", "déjà vendu"] },
    who_is_this: { phrases: ["qui est-ce", "qui est ce", "c'est qui", "qui êtes-vous", "qui etes-vous", "comment avez-vous mon numéro"], exact: ["pourquoi", "pourquoi?"] },
    offer_request: { phrases: ["quel prix", "votre offre", "faites une offre", "combien vous offrez"], exact: ["combien"] },
    thanks: { exact: ["merci", "merci beaucoup"] },
    opt_out: { phrases: ["arrête", "arrêtez", "arrete", "arretez", "ne m'écrivez plus", "ne m'ecrivez plus", "ne me contactez plus", "désinscrire", "desinscrire", "supprimez mon numéro"] },
  },
  German: {
    affirmative: { exact: ["ja", "jawohl", "genau", "richtig", "ja das bin ich", "ja bin ich", "ja, das bin ich"] },
    negative: { exact: ["nein", "nö"] },
    not_interested: { phrases: ["nicht zu verkaufen", "verkaufe nicht", "kein interesse", "nicht interessiert", "nicht verkaufen"] },
    wrong_number: { phrases: ["falsche nummer", "falsch verbunden", "nicht der eigentümer", "nicht der eigentuemer", "nicht mein haus", "gehört mir nicht"] },
    sold: { phrases: ["schon verkauft", "bereits verkauft", "habe verkauft"] },
    who_is_this: { phrases: ["wer ist das", "wer sind sie", "wer bist du", "woher haben sie meine nummer"], exact: ["warum", "wieso"] },
    offer_request: { phrases: ["wie viel bieten", "ihr angebot", "was bieten sie", "machen sie ein angebot"], exact: ["wie viel", "wieviel"] },
    thanks: { exact: ["danke", "danke schön", "danke schon", "vielen dank"] },
    opt_out: { phrases: ["stopp", "aufhören", "aufhoeren", "hören sie auf", "hör auf", "nicht mehr schreiben", "schreiben sie mir nicht", "keine nachrichten mehr", "nummer löschen", "abmelden"] },
  },
  Hindi: {
    affirmative: { exact: ["हाँ", "हां", "जी हाँ", "जी हां", "हाँ जी", "हां जी", "जी", "हाँ मैं हूँ", "हां मैं हूं"] },
    negative: { exact: ["नहीं", "नही", "ना", "जी नहीं"] },
    not_interested: { phrases: ["नहीं बेचना", "नहीं बेचूंगा", "बिक्री के लिए नहीं", "दिलचस्पी नहीं", "रुचि नहीं"] },
    wrong_number: { phrases: ["गलत नंबर", "ग़लत नंबर", "मैं मालिक नहीं", "मेरा नहीं"] },
    sold: { phrases: ["बेच दिया", "बिक गया"] },
    who_is_this: { phrases: ["आप कौन", "कौन है", "कौन हो", "मेरा नंबर कहाँ से"], exact: ["कौन", "क्यों"] },
    offer_request: { phrases: ["कितना दोगे", "कितने में", "कीमत क्या", "क्या कीमत", "ऑफर"], exact: ["कितना", "कितने"] },
    thanks: { exact: ["धन्यवाद", "शुक्रिया", "थैंक्स"] },
    opt_out: { phrases: ["बंद करो", "बंद करें", "मत भेजो", "मैसेज मत करो", "संपर्क मत करो", "नंबर हटाओ", "मत भेजिए"] },
    romanized: { affirmative: ["haan", "han", "ji haan", "haan ji"], negative: ["nahi", "nahin"], who_is_this: ["kaun", "aap kaun"], thanks: ["dhanyavad", "shukriya"], opt_out: ["band karo", "mat bhejo"] },
  },
  Greek: {
    affirmative: { exact: ["ναι", "ναι εγώ", "μάλιστα", "σωστά", "βεβαίως", "ναι, εγώ"] },
    negative: { exact: ["όχι", "οχι"] },
    not_interested: { phrases: ["δεν πουλάω", "δεν πουλαω", "δεν πωλείται", "δεν ενδιαφέρομαι", "δεν με ενδιαφέρει"] },
    wrong_number: { phrases: ["λάθος αριθμός", "λαθος αριθμος", "δεν είμαι ο ιδιοκτήτης", "δεν είναι δικό μου"] },
    sold: { phrases: ["το πούλησα", "πουλήθηκε"] },
    who_is_this: { phrases: ["ποιος είναι", "ποιος είσαι", "ποια είναι", "πού βρήκατε τον αριθμό μου"], exact: ["γιατί", "γιατι"] },
    offer_request: { phrases: ["ποια είναι η προσφορά", "τι προσφέρετε", "ποια τιμή"], exact: ["πόσο", "ποσο"] },
    thanks: { exact: ["ευχαριστώ", "ευχαριστω", "ευχαριστώ πολύ"] },
    opt_out: { phrases: ["σταμάτα", "σταματα", "σταματήστε", "σταματηστε", "μη μου στέλνετε", "μην στέλνετε", "μη στέλνεις", "διαγράψτε τον αριθμό μου"] },
  },
  Portuguese: {
    affirmative: { exact: ["sim", "sim sou eu", "sou eu", "certo", "isso", "é meu", "sim, sou eu", "sim é meu", "com certeza"] },
    negative: { exact: ["não", "nao"] },
    not_interested: { phrases: ["não está à venda", "nao esta a venda", "não vendo", "nao vendo", "não tenho interesse", "nao tenho interesse", "não estou interessado", "nao estou interessado"] },
    wrong_number: { phrases: ["número errado", "numero errado", "não sou o dono", "nao sou o dono", "não sou o proprietário", "nao sou o proprietario"], exact: ["engano"] },
    sold: { phrases: ["já vendi", "ja vendi", "já foi vendida", "foi vendida"] },
    who_is_this: { phrases: ["quem é", "quem e você", "quem fala", "quem é você", "como conseguiu meu número"] },
    offer_request: { phrases: ["qual a oferta", "quanto você oferece", "quanto voce oferece", "faça uma oferta", "faca uma oferta"] },
    thanks: { exact: ["obrigado", "obrigada", "valeu", "muito obrigado", "muito obrigada"] },
    opt_out: { phrases: ["pare de mandar", "não me mande", "nao me mande", "não mande mais", "nao mande mais", "me tire da lista", "remova meu número", "remova meu numero", "descadastrar", "pare de enviar"], exact: ["parar"] },
  },
};

// ─── normalisation ───────────────────────────────────────────────────────────

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const DIGIT_BLOCKS = [
  [0x0660, 0x0669], // Arabic-Indic
  [0x06f0, 0x06f9], // Extended Arabic-Indic
  [0x0966, 0x096f], // Devanagari
];

function asciiDigits(text) {
  return String(text).replace(/[٠-٩۰-۹०-९]/g, (ch) => {
    const code = ch.charCodeAt(0);
    for (const [start] of DIGIT_BLOCKS) {
      if (code >= start && code <= start + 9) return String(code - start);
    }
    return ch;
  });
}

/** NFKC (full-width -> ASCII), zero-width removed, digits to ASCII, lower case. */
export function normalizeMultilingual(value) {
  return asciiDigits(String(value ?? "").normalize("NFKC").replace(ZERO_WIDTH_RE, ""))
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Accent-insensitive form (Latin / Greek combining marks only). */
function fold(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .normalize("NFC");
}

/** The message as a whole answer: trailing / leading punctuation and emoji removed. */
function wholeForm(text) {
  return text
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️]/gu, " ")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .replace(/[\s,，、。]+/g, " ")
    .trim();
}

function containsPhrase(text, phrase) {
  if (!phrase) return false;
  if (NO_BOUNDARY_SCRIPT_RE.test(phrase)) return text.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
}

// ─── local number words ("50万", "3 triệu", "2 lakh") ───────────────────────

const NUMBER_UNITS = [
  [/(\d+(?:[.,]\d+)?)\s*(?:亿|億|억)/gu, 1e8],
  [/(\d+(?:[.,]\d+)?)\s*(?:万|萬|만)/gu, 1e4],
  [/(\d+(?:[.,]\d+)?)\s*(?:千|천)/gu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:tỷ|tỉ)(?![\p{L}])/giu, 1e9],
  [/(\d+(?:[.,]\d+)?)\s*(?:triệu|trieu)(?![\p{L}])/giu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:nghìn|ngàn|nghin|ngan)(?![\p{L}])/giu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:млн|миллион(?:а|ов)?)(?![\p{L}])/giu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:тыс\.?|тысяч[аи]?)(?![\p{L}])/giu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:mln|milion(?:y|ów|ow)?)(?![\p{L}])/giu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:tys\.?|tysięcy|tysiecy|tysiące|tysiace)(?![\p{L}])/giu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:crore|करोड़|करोड)(?![\p{L}])/giu, 1e7],
  [/(\d+(?:[.,]\d+)?)\s*(?:lakh|lac|लाख)(?![\p{L}])/giu, 1e5],
  [/(\d+(?:[.,]\d+)?)\s*(?:מיליון)/gu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:אלף)/gu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:مليون)/gu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:ألف|الف)/gu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:εκατομμύρια|εκατομμύριο|εκατ\.?)(?![\p{L}])/giu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:χιλιάδες|χιλ\.?)(?![\p{L}])/giu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:milioni|milione)(?![\p{L}])/giu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:mila)(?![\p{L}])/giu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:millionen|mio\.?)(?![\p{L}])/giu, 1e6],
  [/(\d+(?:[.,]\d+)?)\s*(?:tausend)(?![\p{L}])/giu, 1e3],
  [/(\d+(?:[.,]\d+)?)\s*(?:mille)(?![\p{L}])/giu, 1e3],
];

/** First amount written with a local multiplier word, as an integer, or null. */
export function parseLocalAmount(value) {
  const text = normalizeMultilingual(value);
  let best = null;
  for (const [re, factor] of NUMBER_UNITS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(String(m[1]).replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) continue;
    const amount = Math.round(n * factor);
    if (best == null || m.index < best.index) best = { amount, index: m.index, factor };
  }
  return best ? best.amount : null;
}

// ─── public API ──────────────────────────────────────────────────────────────

function matchLanguage(language, entry, text, whole, foldedWhole, { allowRomanized }) {
  const hits = new Set();
  const foldedText = fold(text);
  for (const category of PRECEDENCE) {
    const rule = entry[category];
    if (!rule) continue;
    const exact = rule.exact || [];
    const phrases = rule.phrases || [];
    // Exact answers compare as written: folding "nö" to "no" would relabel an
    // English "No" as German. Unaccented variants are listed explicitly.
    if (exact.some((w) => w === whole)) hits.add(category);
    if (phrases.some((p) => containsPhrase(text, p) || containsPhrase(foldedText, fold(p)))) hits.add(category);
  }
  if (allowRomanized && entry.romanized) {
    for (const [category, words] of Object.entries(entry.romanized)) {
      if (words.some((w) => w === whole || w === foldedWhole)) hits.add(category);
    }
  }
  return hits;
}

/**
 * Canonicalise ONE seller reply written in a templated non-English,
 * non-Spanish language.
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {string|null} [opts.thread_language]  language of OUR last outbound
 * @returns {null | { canonical_text, category, language, amount, version }}
 */
export function canonicalizeMultilingualReply(message, { thread_language = null } = {}) {
  const text = normalizeMultilingual(message);
  if (!text) return null;
  const whole = wholeForm(text);
  const foldedWhole = fold(whole);
  const thread = String(thread_language ?? "").trim();

  let best = null;
  for (const [language, entry] of Object.entries(LEXICON)) {
    const hits = matchLanguage(language, entry, text, whole, foldedWhole, {
      allowRomanized: thread && thread.toLowerCase() === language.toLowerCase(),
    });
    for (const category of hits) {
      const rank = PRECEDENCE.indexOf(category);
      if (!best || rank < best.rank) best = { category, language, rank };
    }
  }

  // A local-multiplier amount ("50万", "3 triệu", "2 lakh") is a price unless a
  // higher-precedence category (opt-out, wrong number, sold, decline, identity,
  // offer request) already explains the message.
  const amount = parseLocalAmount(text);
  const priceRank = PRECEDENCE.indexOf("affirmative");
  if (amount != null && (!best || best.rank >= priceRank)) {
    return {
      canonical_text: String(amount),
      category: "price",
      language: best?.language || null,
      amount,
      version: MULTILINGUAL_SHORT_REPLY_VERSION,
    };
  }
  if (!best) return null;
  return {
    canonical_text: CANONICAL[best.category],
    category: best.category,
    language: best.language,
    amount: null,
    version: MULTILINGUAL_SHORT_REPLY_VERSION,
  };
}

/** Opt-out phrase in any templated language, anywhere in the message. */
export function matchesMultilingualOptOut(message, opts = {}) {
  return canonicalizeMultilingualReply(message, opts)?.category === "opt_out";
}

export const MULTILINGUAL_LANGUAGES = Object.freeze(Object.keys(LEXICON));
