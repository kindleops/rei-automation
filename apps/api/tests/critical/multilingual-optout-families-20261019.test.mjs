/**
 * P0 2026-10-19 — MULTILINGUAL OPT-OUT FAMILIES (table-driven, the live classify()).
 *
 * Written from linguistic knowledge of each language (imperative / subjunctive
 * forms, clitics, accent-less and informal spellings, negation, mixed English),
 * NOT from any evaluation case file. Labels:
 *   OPT   explicit opt-out            → primary opt_out + stop_texting + suppression_action opt_out
 *   WRONG phone-identity wrong number → primary wrong_number (existing wrong-number route), never opt_out
 *   HOLD  possible opt-out (family token, no confident family, non-English)
 *         → precautionary hold: suppression_candidate + precautionary_hold, no reply, never opt_out
 *   NEG   not an opt-out (plain disinterest, other-action stop, channel / language
 *         preference, why-question, past tense, insult) → never opt_out, never a hold
 * Precision / recall are printed for the suite (OPT as the positive class, and
 * "contact blocked" = OPT ∪ HOLD).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { analyzeContactRevocation } from "@/lib/domain/classification/multilingual-contact-revocation.js";
import { matchMultilingualOptOut } from "@/lib/domain/classification/multilingual-opt-out.js";
import { deterministicPrecheck } from "@/lib/domain/conversation-ai/precheck.js";

export const SUITE = {
  Spanish: {
    OPT: [
      "Quíteme de su lista", "Quítenme de su lista por favor", "quitame de tu lista", "quiteme de su lista",
      "SAQUEME DE SU LISTA", "Sáquenme de su lista de contactos", "Por favor sáqueme de esta lista",
      "Bórrenme de su base de datos", "borrame de tu lista ya", "Elimíneme de su lista",
      "Elimínenme de sus listas, gracias", "Remuévanme de la lista", "Me pueden quitar de la lista por favor",
      "Favor de quitar mi número", "Borre mi número por favor", "Quiero que me quiten de su lista",
      "No me interesa, quíteme de la lista", "Bórrenme por favor", "Denme de baja", "Quiero darme de baja",
      "No me vuelvan a contactar", "No me vuelva a escribir", "Nunca me vuelvan a llamar", "No vuelvan a escribirme",
      "No me escriban más", "No me escriba por favor", "Ya no me manden mensajes", "No me mande más textos",
      "Dejen de escribirme", "Deje de mandarme mensajes", "Deja de molestarme", "Paren de enviarme mensajes",
      "Ya dejen de estar mandando mensajes", "No quiero recibir más mensajes", "No quiero que me sigan escribiendo",
      "No deseo ser contactada", "Déjenme en paz", "Déjame en paz por favor", "Basta de mensajes",
      "No más mensajes por favor", "No me interesa que me contacten", "Dejen de preguntarme por la casa",
      "No me pregunten más por la propiedad", "Ya no me textees", "No me estén molestando", "no me llames ni me escribas",
    ],
    WRONG: ["Número equivocado", "Se equivocó de número", "Tienen el número equivocado", "No conozco a esa persona", "Este no es el número de Juan"],
    HOLD: ["Quítame eso de encima", "Ya bloquéenme"],
    NEG: [
      "No me interesa", "No gracias, no vendo", "No estoy interesado por ahora", "¿Cuánto ofrecen por la casa?",
      "Pare de llorar", "El teléfono no para de sonar", "Dejé de llamar al agente", "Quité la casa de la lista del agente",
      "No me llames tan temprano", "No me llames, mejor escríbeme", "No me escriba en inglés, en español por favor",
      "¿Por qué no me llaman?", "Mándeme la oferta por mensaje", "La casa está rentada", "Ya no me interesa vender",
      "Basta de ofertas bajas", "No me quite el tiempo con ofertas bajas", "Quiero sacar mi nombre del título",
      "Eres un idiota", "Déjeme pensarlo",
    ],
  },
  Portuguese: {
    OPT: [
      "Pare de me mandar mensagens", "Parem de me enviar mensagem", "Para de me ligar", "Deixe de me mandar mensagens",
      "Não me mande mais mensagens", "Não me mandem mais nada", "Nunca mais me mande mensagem", "Não me ligue mais",
      "Não me contate", "Não me procurem mais", "Não quero mais receber mensagens", "Não quero que me liguem",
      "Não quero ser contatado", "Não entre mais em contato", "Me tire da sua lista", "Tire meu número da lista",
      "Remova meu número", "Me remove da lista por favor", "Exclua meu número do cadastro", "Apaguem meu número da lista",
      "Quero sair da lista", "Descadastrar", "Me deixe em paz", "Chega de mensagens", "Pare de perguntar sobre a casa",
      "n me mande mais msg", "Não tenho interesse, parem",
    ],
    WRONG: ["Número errado", "Foi engano", "Não conheço essa pessoa"],
    HOLD: ["Remova-me"],
    NEG: [
      "Não tenho interesse", "Não quero vender agora", "Pare de brincadeira", "Quanto vocês pagam?", "Por que não me liga?",
      "Tirei a casa da lista do corretor", "Me liga amanhã", "A casa está alugada", "Não me interessa mais", "Não ligue mais tarde, estou dormindo",
    ],
  },
  French: {
    OPT: [
      "Arrêtez de m'écrire", "Arrête de m'envoyer des messages", "Cessez de me contacter", "Arrêtez de me harceler",
      "arretez de m ecrire", "Ne m'écrivez plus", "Ne me contactez plus jamais", "Ne m'envoyez plus de messages",
      "N'envoyez plus de messages", "Merci de ne plus me contacter", "Ne pas me recontacter",
      "Je ne veux plus recevoir de messages", "Je ne souhaite pas être contacté", "Plus de messages svp",
      "Retirez-moi de votre liste", "Supprimez mon numéro", "Enlevez mon numéro de votre liste",
      "Supprimez-moi de votre fichier", "Désabonnez-moi", "Je veux me désinscrire", "Laissez-moi tranquille",
      "Fichez-moi la paix", "J'en ai marre de vos messages", "Arrêtez de me demander pour la maison",
      "Pas intéressé, arrêtez.", "me contactez plus",
    ],
    WRONG: ["Mauvais numéro", "Vous vous êtes trompé de numéro", "Je ne connais pas cette personne"],
    HOLD: [],
    NEG: [
      "Pas intéressé", "Je ne veux pas vendre", "Arrêtez de rêver, c'est trop bas", "Appelez-moi plus tard",
      "Pouvez-vous m'envoyer plus d'informations?", "J'ai arrêté de contacter l'agence", "J'ai retiré la maison de la liste",
      "Ne m'appelez pas, écrivez-moi", "Combien vous offrez?", "La maison est louée",
    ],
  },
  "Haitian Creole": {
    OPT: [
      "Tanpri sispann voye mesaj ban mwen", "sispann ekri m", "Sispann rele m", "Sispann voye tèks ban m",
      "Kanpe voye mesaj ban mwen", "Pa ekri m ankò", "Pa voye mesaj ban mwen ankò", "Tanpri pa rele m ankò",
      "Pa janm kontakte m ankò", "Mwen pa vle resevwa mesaj ankò", "M pa vle ou ekri m", "Retire m nan lis ou",
      "Wete m nan lis la tanpri", "Efase nimewo m", "Retire nimewo mwen nan lis la", "Kite m anpè",
      "Kite m an pè tanpri", "Sispann", "M pa enterese, sispann", "Sispann mande m pou kay la",
      "Pa bezwen ekri m ankò", "Mwen pa enterese, pa voye mesaj ban mwen ankò", "Dezabone m",
      "Tanpri sispann deranje m", "pa deranje m anko", "Kanpe",
    ],
    WRONG: ["Move nimewo", "Ou pran move nimewo", "Nimewo a pa bon", "M pa konnen moun sa"],
    HOLD: ["M pa vle, efase m"],
    NEG: [
      "Mwen pa enterese", "M pa vle vann kay la", "Konbyen ou ofri?", "Poukisa ou pa rele m?", "Rele m demen",
      "Wi se kay mwen", "Kay la lwe", "M ap panse a sa", "Ekri m pita", "Mesi, m ap kontakte w", "Ou se yon vòlè",
    ],
  },
  Italian: {
    OPT: [
      "Smetta di scrivermi", "Smettetela di chiamarmi", "Smettila di mandarmi messaggi", "Non mi scriva più",
      "Non contattatemi più", "Non scrivermi", "Non chiamarmi più", "Non voglio essere contattato",
      "Non voglio più ricevere messaggi", "Cancellatemi dalla vostra lista", "Toglimi dalla lista",
      "Rimuovete il mio numero", "Cancelli il mio numero per favore", "Lasciatemi in pace", "Basta con questi messaggi",
      "Disiscrivimi", "Smettete di chiedere della casa", "Non mandatemi più messaggi",
    ],
    WRONG: ["Numero sbagliato", "Ha sbagliato numero"],
    HOLD: [],
    NEG: [
      "Non mi interessa", "Non voglio vendere", "Non mi mandi un'offerta bassa", "Quanto offrite?", "Mi chiami domani",
      "Ho cancellato l'annuncio dalla lista", "Lascia perdere", "Non mi chiami, mi scriva", "La casa è affittata", "Ci penso",
    ],
  },
  Polish: {
    OPT: [
      "Proszę przestać do mnie pisać", "Przestańcie dzwonić", "Przestań mi wysyłać wiadomości", "Nie piszcie do mnie więcej",
      "Nie dzwońcie do mnie", "Nie pisz do mnie", "Nie chcę więcej wiadomości", "Nie życzę sobie kontaktu", "Proszę nie dzwonić",
      "Usuń mój numer", "Usuńcie mnie z listy", "Proszę usunąć mój numer z bazy", "Wykreślcie mnie z bazy", "Wypisz mnie",
      "Zostawcie mnie w spokoju", "Dajcie mi spokój", "Nie kontaktujcie się ze mną", "Przestańcie mnie pytać o dom",
      "Rezygnuję z wiadomości",
    ],
    WRONG: ["Zły numer", "Pomyłka", "To nie mój numer"],
    HOLD: ["Usuńcie to"],
    NEG: [
      "Nie", "Nie jestem zainteresowany", "Nie sprzedaję", "Przestań żartować", "Ile oferujecie?", "Proszę zadzwonić jutro",
      "Usunąłem ogłoszenie", "Dom jest wynajęty", "Zastanowię się", "Nie dzwoń, napisz SMS",
    ],
  },
  Vietnamese: {
    OPT: [
      "Đừng nhắn tin cho tôi nữa", "Đừng gọi cho tôi", "Xin đừng liên lạc với tôi nữa", "Làm ơn đừng làm phiền tôi",
      "Ngừng nhắn tin", "Ngừng gửi tin nhắn cho tôi", "Thôi nhắn tin đi", "Không liên lạc nữa",
      "Tôi không muốn nhận tin nhắn nữa", "Xóa số của tôi", "Xóa tôi khỏi danh sách", "Bỏ số tôi ra khỏi danh sách",
      "Hủy đăng ký", "Để tôi yên", "Đừng hỏi về căn nhà nữa", "dung nhan tin cho toi nua", "xoa so cua toi",
      "ko nhan tin nua", "ngung nhan tin", "huy dang ky", "Vui lòng không nhắn tin cho tôi",
    ],
    WRONG: ["Sai số rồi", "Nhầm số", "Nhầm người rồi"],
    HOLD: ["Xóa đi"],
    NEG: [
      "Không quan tâm", "Tôi không muốn bán", "Đúng, nhắn tin cho tôi", "Dừng lại một chút để tôi nghĩ", "Bao nhiêu tiền?",
      "Gọi cho tôi ngày mai", "Nhà đang cho thuê", "Đừng lo, tôi sẽ suy nghĩ", "Tôi không gọi được cho anh",
      "Tôi đã xóa tin nhắn của anh",
    ],
  },
  Mandarin: {
    OPT: [
      "不要再给我发短信了", "别再发了", "请不要再联系我", "請不要再聯絡我", "不要打电话给我", "別再打來了", "停止发送信息",
      "請停止傳訊息給我", "把我从名单上删除", "把我的号码删掉", "請把我從名單中移除", "删除我的电话", "退订", "取消訂閱",
      "别烦我", "別煩我了", "不要再问那个房子了", "請勿再發簡訊", "不要骚扰我", "我不卖，别再联系我了",
    ],
    WRONG: ["你打错了", "發錯人了", "号码错了"],
    HOLD: ["删除"],
    NEG: [
      "不卖", "没兴趣", "你们出多少钱？", "不要烦恼，我考虑一下", "麻烦你发一下报价", "不用了，谢谢", "我不想卖",
      "房子已经租出去了", "可以给我打电话", "打扰一下，请问你是谁？", "你是骗子",
    ],
  },
  Korean: {
    OPT: [
      "문자 보내지 마세요", "연락하지 마세요", "더 이상 연락하지 마세요", "다시는 문자 보내지 마", "전화하지 마세요",
      "문자 그만 보내세요", "연락 그만 하세요", "그만 보내세요", "목록에서 삭제해주세요", "제 번호를 삭제해 주세요",
      "명단에서 빼주세요", "수신거부", "수신 거부합니다", "귀찮게 하지 마세요", "연락 원하지 않습니다",
      "집에 대해 그만 물어보세요", "카톡 하지 마세요", "번호 지워주세요", "연락 사절", "관심 없으니 연락하지 마세요",
    ],
    WRONG: ["잘못된 번호입니다", "번호 잘못 아셨어요", "저 그 사람 아닌데요"],
    HOLD: ["삭제"],
    NEG: [
      "관심 없어요", "안 팔아요", "얼마 주실 건데요?", "걱정하지 마세요", "나중에 전화 주세요", "그만큼은 안 돼요",
      "그만 좀 웃기세요 가격이 너무 낮아요", "연락 주셔서 감사합니다", "전화하지 마시고 문자 주세요", "세입자가 살고 있어요",
    ],
  },
  Tagalog: {
    OPT: [
      "Wag nyo na akong i-text", "Huwag mo akong tawagan", "Huwag na po kayong mag-text", "Wag mo na ako i-text ulit",
      "Tigilan nyo na ang pag-text", "Itigil nyo na po ang pagtext", "Tumigil na kayo sa pag-text", "Stop na po kayo sa pagtext",
      "Tanggalin nyo na ako sa listahan", "Pakitanggal ako sa list nyo", "Alisin nyo ako sa listahan", "Pakibura ang number ko",
      "Burahin nyo ang number ko", "Lubayan nyo na ako", "Tantanan mo na ako", "Pabayaan nyo na ako", "Ayoko na ng text",
      "Hindi ko kailangan ng mga text nyo", "Mag-unsubscribe", "Wag nyo na akong tanungin tungkol sa bahay", "Tigil",
      "Wag nyo na ako kulitin",
    ],
    WRONG: ["Maling numero po", "Hindi ko po kilala yan"],
    HOLD: ["Makulit kayo ah"],
    NEG: [
      "Hindi po interesado", "Hindi ko ibebenta", "Magkano po ang alok nyo?", "Wag na po, salamat", "Huwag muna ngayon",
      "Tawagan nyo ako bukas", "Text nyo na lang ako", "Huwag mo akong tawagan, text na lang", "May nakatira pong tenant",
      "Pag-iisipan ko po",
    ],
  },
  Arabic: {
    OPT: [
      "توقف عن مراسلتي", "توقفوا عن ارسال الرسائل", "كفوا عن ازعاجي", "لا ترسل لي رسائل", "لا تتصل بي مرة أخرى", "لا تراسلني",
      "من فضلك لا ترسلوا لي أي رسائل", "يرجى عدم الاتصال بي", "أرجو عدم مراسلتي", "لا أريد أي رسائل", "احذف رقمي",
      "احذفوني من القائمة", "امسح رقمي من قائمتكم", "إلغاء الاشتراك", "اتركني وشأني", "خلاص بطلوا ترسلوا",
      "توقف عن السؤال عن البيت", "شيلني من اللستة", "لا تبعتلي رسايل", "ما بدي رسايل",
    ],
    WRONG: ["الرقم خطأ", "رقم غلط", "ليس رقمي"],
    HOLD: ["امسح"],
    NEG: [
      "لست مهتماً", "لا أريد البيع", "كم تدفع؟", "أنت محتال", "اتصل بي غدا", "لا تتصل قبل الساعة العاشرة",
      "ليش ما تتصل؟", "البيت مؤجر", "دعني أفكر", "لا شكرا",
    ],
  },
  Russian: {
    OPT: [
      "Перестаньте мне писать", "Прекратите звонить", "Хватит мне писать", "Не пишите мне больше", "Больше не звоните",
      "Не беспокойте меня", "Прошу не беспокоить", "Не надо мне писать", "Удалите мой номер", "Удалите меня из списка",
      "Уберите мой номер из базы", "Исключите меня из рассылки", "Отпишите меня", "Отписаться", "Оставьте меня в покое",
      "Отстаньте от меня", "Не хочу получать сообщения", "Перестаньте спрашивать про дом", "больше не пишите сюда",
      "Прекратите присылать сообщения",
    ],
    WRONG: ["Вы ошиблись номером", "Не тот номер", "Это не я"],
    HOLD: ["Удалите это"],
    NEG: [
      "Нет", "Не интересно", "Не продаю", "Хватит", "Позвоните мне завтра", "Сколько вы предлагаете?", "Почему не звоните?",
      "Не звоните мне, пишите", "Дом сдан в аренду", "Я подумаю", "Ты идиот",
    ],
  },
  "Mixed English": {
    OPT: [
      "Please sispann voye mesaj", "Stop texting me por favor", "remove me de la lista", "No more mensajes",
      "Please quíteme de su lista", "wag nyo na ako i-text please", "Pls ne m'écrivez plus", "STOP! no me escriban",
      "stop asking about 123 Main St", "Quit asking me about the house on Elm",
    ],
    WRONG: [],
    HOLD: [],
    NEG: ["stop by anytime", "We can stop by the property tomorrow", "Ok gracias, let me think", "Llámame later, I'm at work", "Yes I own it, quanto?"],
  },
};

// HELD-OUT v1: written after the detector was frozen and measured once BEFORE any fix
// (OPT precision 1.000, recall 0.955 — 64/67, 0 false positives on 132 rows); the 3 misses were then
// fixed and the set kept here as regression coverage.
export const HELDOUT_V1 = {
  OPT: [
    // es
    "Por favor ya no me envíen nada", "Sáquenme de sus registros de una vez", "Ya les dije que no me escriban", "Quiten mi teléfono de su lista",
    "No sigan mandando mensajes", "Les pido que no me contacten", "dejen de mandarme ofertas", "Elimina mi número de tu base de datos",
    "bórrame de la lista porfa", "Nunca más me escriban", "no me estén escribiendo", "Ya no quiero mensajes de ustedes",
    // pt
    "Por favor parem de me mandar mensagem", "Não quero receber mais nada de vocês", "Me tirem dessa lista", "Não me mandem mais SMS",
    "Parem de me ligar por favor", "Apague meu contato", "Remova meu telefone da sua lista",
    // fr
    "Merci de ne plus m'envoyer de SMS", "Cessez de m'appeler", "Retirez mon numéro de votre fichier", "Ne me relancez plus",
    "Je ne veux plus être contacté", "Arrête de me texter",
    // ht
    "Pa voye mesaj ankò", "Tanpri pa ekri m ankò", "Mwen pa vle okenn mesaj", "Sispann tekste m", "Retire non mwen nan lis la",
    "Kite m trankil", "Pa janm rele m ankò",
    // it
    "Non scrivetemi più", "Smettete di mandarmi SMS", "Cancellate il mio numero", "Non voglio più essere disturbato", "Toglietemi dalla lista",
    // pl
    "Przestańcie wysyłać mi SMS-y", "Nie piszcie już do mnie", "Usuńcie mój numer z listy", "Proszę mnie wykreślić z bazy",
    // vi
    "Đừng nhắn cho tôi nữa", "Làm ơn ngừng gọi cho tôi", "Xóa số điện thoại của tôi đi", "dung goi cho toi nua", "Không cần liên lạc với tôi nữa",
    // zh
    "别再给我打电话了", "不要再发信息给我", "请把我的号码从你们的名单删除", "請勿再聯繫我", "停止发短信给我",
    // ko
    "더 이상 문자 하지 마세요", "연락 그만 주세요", "번호 삭제해 주세요", "다시는 연락하지 마세요",
    // tl
    "Huwag nyo na akong i-message", "Tigilan nyo na po ang pagtetext", "Pakitanggal po ang number ko", "Wag na kayong tumawag ulit",
    // ar
    "لا تراسلوني مرة أخرى", "توقف عن الاتصال بي", "احذفوا رقمي من فضلكم", "لا ترسلوا رسائل",
    // ru
    "Не присылайте мне больше сообщений", "Перестаньте звонить мне", "Удалите мой номер из вашей базы", "Хватит присылать смс",
  ],
  WRONG: ["Tiene el número incorrecto", "Número errado", "Faux numéro", "Ou gen move nimewo", "Numero errato", "Błędny numer", "Nhầm số rồi anh ơi", "打错电话了", "번호 잘못 거셨어요", "Maling number po", "رقم خطأ", "Неправильный номер"],
  NEG: [
    "No, gracias. No está a la venta", "¿Qué precio ofrecen?", "Ahorita no puedo hablar", "Mi hermano quiere vender, llámenlo", "La casa necesita reparaciones",
    "Escríbame mañana", "¿Quién es usted?", "Lo voy a pensar", "Ya la vendí", "Dejé de rentarla el mes pasado",
    "Não estou vendendo", "Quanto vale pra vocês?", "Me mande a proposta por mensagem", "Já vendi", "Ligue amanhã",
    "Ce n'est pas à vendre", "Envoyez-moi votre offre", "Je vais réfléchir", "Appelez-moi demain matin",
    "Kay la pa pou vann", "Voye ofri a ban mwen", "M ap reflechi", "Ki moun ou ye?",
    "Non è in vendita", "Mandatemi l'offerta", "Ci devo pensare",
    "Nie jest na sprzedaż", "Proszę wysłać ofertę", "Muszę się zastanowić",
    "Nhà không bán", "Gửi giá cho tôi", "Để tôi suy nghĩ đã", "Ai vậy?",
    "房子不卖", "你出个价吧", "让我想一想", "你是谁？",
    "집 안 팔아요", "가격 보내주세요", "생각해 볼게요", "누구세요?",
    "Hindi po for sale", "Ano po ang offer nyo?", "Pag-isipan ko muna", "Sino po ito?",
    "البيت ليس للبيع", "أرسل لي العرض", "سأفكر في الأمر", "من أنت؟",
    "Дом не продается", "Пришлите предложение", "Я подумаю над этим", "Кто это?",
  ],
};

// PRE-EXISTING conservative behaviour (production 6ecbae6b classifies each of these as an
// opt-out through the classifier's own phrase lists, before this change): accepted — fail
// toward compliance — and COUNTED AS FALSE POSITIVES in the precision figure. This change
// adds none; the list must not grow.
export const ACCEPTED_CONSERVATIVE = new Set([
  "No me llames tan temprano",
  "No me llames, mejor escríbeme",
  "No me escriba en inglés, en español por favor",
  "J'ai arrêté de contacter l'agence",
  "لا تتصل قبل الساعة العاشرة",
  "Не звоните мне, пишите",
]);

function labelOf(c) {
  if (c.primary_intent === "opt_out" || c.compliance_flag === "stop_texting") return "OPT";
  if (c.automation_decision?.precautionary_hold === true) return "HOLD";
  if (c.primary_intent === "wrong_number") return "WRONG";
  return "NEG";
}

const rows = [];
for (const [language, buckets] of Object.entries(SUITE)) {
  for (const [expected, list] of Object.entries(buckets)) for (const text of list) rows.push({ language, expected, text });
}
for (const [expected, list] of Object.entries(HELDOUT_V1)) for (const text of list) rows.push({ language: "held-out v1", expected, text });

test(`suite size: ≥300 phrasings, ≥100 negatives, all 12 languages + mixed (${rows.length} rows)`, () => {
  assert.ok(rows.length >= 300, `rows ${rows.length}`);
  assert.ok(rows.filter((r) => r.expected === "NEG").length >= 100, "negatives");
  for (const lang of ["Spanish", "Portuguese", "Haitian Creole", "French", "Vietnamese", "Mandarin", "Korean", "Tagalog", "Arabic", "Russian", "Polish", "Italian"]) {
    assert.ok(SUITE[lang], lang);
    assert.ok(SUITE[lang].OPT.length >= 15 && SUITE[lang].NEG.length >= 8, `${lang} coverage`);
  }
});

test("live classify(): every phrasing gets its family's outcome (precision / recall reported)", async (t) => {
  const misses = [];
  const tally = { OPT: { tp: 0, fp: 0, fn: 0 }, BLOCK: { tp: 0, fp: 0, fn: 0 } };
  for (const r of rows) {
    const c = await classify(r.text, null, { heuristicOnly: true });
    const got = labelOf(c);
    r.got = got;
    const conservative = r.expected === "NEG" && got === "OPT" && ACCEPTED_CONSERVATIVE.has(r.text);
    if (got !== r.expected && !conservative) misses.push(`${r.language} [${r.expected}→${got}] ${r.text}`);
    const wantOpt = r.expected === "OPT", gotOpt = got === "OPT";
    if (wantOpt && gotOpt) tally.OPT.tp += 1; else if (!wantOpt && gotOpt) tally.OPT.fp += 1; else if (wantOpt && !gotOpt) tally.OPT.fn += 1;
    const wantB = ["OPT", "HOLD"].includes(r.expected), gotB = ["OPT", "HOLD"].includes(got);
    if (wantB && gotB) tally.BLOCK.tp += 1; else if (!wantB && gotB) tally.BLOCK.fp += 1; else if (wantB && !gotB) tally.BLOCK.fn += 1;
    // compliance invariants that hold for every row regardless of label
    if (got === "OPT") assert.equal(c.automation_decision?.suppression_action, "opt_out", r.text);
    if (got === "HOLD") {
      assert.equal(c.automation_decision?.suppression_candidate, true, r.text);
      assert.equal(c.automation_decision?.auto_reply_allowed, false, r.text);
      assert.notEqual(c.primary_intent, "opt_out", r.text);
    }
    if (got === "WRONG") assert.notEqual(c.compliance_flag, "stop_texting", r.text);
  }
  const pr = ({ tp, fp, fn }) => ({ precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn) });
  const opt = pr(tally.OPT), block = pr(tally.BLOCK);
  const line = `rows=${rows.length} OPT precision=${opt.precision.toFixed(3)} recall=${opt.recall.toFixed(3)} (tp ${tally.OPT.tp} fp ${tally.OPT.fp} fn ${tally.OPT.fn}); contact-blocked precision=${block.precision.toFixed(3)} recall=${block.recall.toFixed(3)}`;
  t.diagnostic(line);
  console.log(`[multilingual-optout-suite] ${line}`);
  assert.deepEqual(misses, [], `${misses.length} misclassified:\n${misses.join("\n")}`);
});

test("module: matchMultilingualOptOut is an opt-out matcher only (never wrong-number, never a possible opt-out)", () => {
  for (const r of rows) {
    const hit = matchMultilingualOptOut(r.text);
    if (r.expected === "WRONG" || r.expected === "HOLD") assert.equal(hit, null, `${r.language}: ${r.text}`);
  }
  assert.equal(analyzeContactRevocation("Quíteme de su lista").opt_out.family, "remove_from_list");
  assert.equal(analyzeContactRevocation("Tanpri sispann voye mesaj ban mwen").opt_out.family, "stop_sending");
  assert.equal(analyzeContactRevocation("no me vuelvan a contactar").opt_out.family, "no_contact");
  assert.equal(analyzeContactRevocation("no me llames, mejor escríbeme").carved, "channel_preference");
});

test("full classify() (non-heuristic path, AI assist unavailable): opt-outs and holds survive", async () => {
  for (const r of rows.filter((x) => x.expected === "OPT" || x.expected === "HOLD").filter((_, i) => i % 3 === 0)) {
    const c = await classify(r.text, null, {});
    assert.equal(labelOf(c), r.expected, `${r.language}: ${r.text}`);
  }
});

test("conversation-AI pre-check: OPT → SUPPRESS, HOLD → NEEDS_REVIEW (no model call), NEG never SUPPRESS for an opt-out reason", async () => {
  for (const r of rows) {
    const c = await classify(r.text, null, { heuristicOnly: true });
    const p = deterministicPrecheck({ text: r.text, inboundId: "in-1", deterministic: { intent: c.primary_intent, compliance_flag: c.compliance_flag } });
    if (r.expected === "OPT") {
      assert.equal(p.decided, true, r.text);
      assert.equal(p.decision.outcome, "SUPPRESS", `${r.language}: ${r.text}`);
    }
    if (r.expected === "HOLD") {
      assert.equal(p.decided, true, r.text);
      assert.equal(p.decision.outcome, "NEEDS_REVIEW", `${r.language}: ${r.text} → ${p.reason}`);
    }
    if (r.expected === "NEG" && !ACCEPTED_CONSERVATIVE.has(r.text) && p.decided && p.decision.outcome === "SUPPRESS") {
      assert.ok(!/stop_or_opt_out|classifier_stop_texting|classifier_opt_out/.test(p.reason), `${r.language}: ${r.text} → ${p.reason}`);
    }
  }
});

test("the locked owner rules: insults never suppress; plain disinterest is nurture; STOP is absolute; a property denial is never global", async () => {
  for (const m of ["Eres un idiota", "Ou se yon vòlè", "Ты идиот", "你是骗子"]) {
    const c = await classify(m, null, { heuristicOnly: true });
    assert.notEqual(c.automation_decision?.suppression_action, "opt_out", m);
    assert.notEqual(c.automation_decision?.precautionary_hold, true, m);
  }
  for (const m of ["No me interesa", "Mwen pa enterese", "Não tenho interesse", "Không quan tâm"]) {
    const c = await classify(m, null, { heuristicOnly: true });
    assert.notEqual(c.primary_intent, "opt_out", m);
    assert.notEqual(c.automation_decision?.precautionary_hold, true, m);
  }
  for (const m of ["STOP", "Stop", "Sispann", "PARE"]) assert.equal((await classify(m, null, { heuristicOnly: true })).primary_intent, "opt_out", m);
  const denial = await classify("No soy el dueño de esa casa", null, { heuristicOnly: true });
  assert.notEqual(denial.compliance_flag, "stop_texting");
  assert.notEqual(denial.automation_decision?.precautionary_hold, true);
});
