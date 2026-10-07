// PROPOSED sms_templates copy for the Acquisition OS v1 additions to SELLER
// CONVERSATION MACHINE v3 (owner brief 2026-10-07, §21 §23 §26–27 §38).
// NOT LIVE: this file only feeds
//   • supabase/migrations/PROPOSED_20261007050000_seller_conversation_v3_acq_os_templates.sql
//     (every row INACTIVE, safe_for_auto_reply = false, metadata.review_status = 'unreviewed'),
//   • the language coverage matrix (LANGUAGE_COVERAGE.csv) and the EN/ES copy review,
//   • the offline replay (to show what approval would unlock).
//
// Same voice as the v3 rows: Alex, a local investor, short, warm, plain; no
// placeholders (a row can never fail to render); usted / Pan / anh-chị register
// as in the existing rows. Every non-EN/ES row is native script and needs a
// native reviewer before activation (§36). Nothing here names a number.

export const ACQ_OS_LANGS = Object.freeze([
  ["English", "en"], ["Spanish", "es"], ["Portuguese", "pt"], ["French", "fr"], ["German", "de"],
  ["Italian", "it"], ["Polish", "pl"], ["Vietnamese", "vi"], ["Mandarin", "zh"], ["Korean", "ko"],
  ["Japanese", "ja"], ["Hebrew", "he"], ["Arabic", "ar"], ["Russian", "ru"], ["Greek", "el"],
  ["Indian (Hindi or Other)", "hi"],
]);

export const ACQ_OS_USE_CASES = Object.freeze({
  v3_ask_price_number: {
    short: "apn", stage_code: "S3", stage_label: "Stage 3 Asking Price (yes, I have a number)",
    fires: "§38 S3: a plain \"Yes\" / \"I do\" to \"do you have an asking price?\". Continue price discovery; no ownership or interest implication.",
    copy: {
      English: "Great. What number did you have in mind for it?",
      Spanish: "Perfecto. ¿Qué número tiene en mente?",
      Portuguese: "Ótimo. Qual valor você tem em mente?",
      French: "Parfait. Quel montant avez-vous en tête ?",
      German: "Super. An welchen Betrag haben Sie gedacht?",
      Italian: "Perfetto. Che cifra ha in mente?",
      Polish: "Świetnie. Jaką kwotę ma Pan na myśli?",
      Vietnamese: "Tốt quá. Anh/chị đang nghĩ đến con số bao nhiêu?",
      Mandarin: "好的。您心里的价格是多少？",
      Korean: "좋습니다. 생각하시는 금액이 얼마인가요?",
      Japanese: "ありがとうございます。ご希望の金額はおいくらくらいですか？",
      Hebrew: "מעולה. איזה מספר יש לך בראש?",
      Arabic: "رائع. ما الرقم الذي تفكر فيه؟",
      Russian: "Отлично. Какую сумму вы имеете в виду?",
      Greek: "Τέλεια. Τι ποσό έχετε στο μυαλό σας;",
      "Indian (Hindi or Other)": "बढ़िया। आपके मन में कितनी कीमत है?",
    },
  },
  v3_price_clarify: {
    short: "pcl", stage_code: "S3", stage_label: "Stage 3 Asking Price Clarify (not a price)",
    fires: "§26–27 S3: a number that is never a price on its own (a bare year \"2020\", a rent-shaped \"1,500\"). Clarify once; a second miss → \"I can run the numbers\" (condition).",
    copy: {
      English: "Sorry, just want to make sure I read that right. What price would you want for the property?",
      Spanish: "Disculpe, solo quiero asegurarme de que entendí bien. ¿Qué precio quisiera por la propiedad?",
      Portuguese: "Desculpe, só quero ter certeza de que entendi bem. Qual preço você quer pelo imóvel?",
      French: "Pardon, je veux juste être sûr d'avoir bien compris. Quel prix souhaitez-vous pour le bien ?",
      German: "Entschuldigung, ich möchte nur sichergehen, dass ich das richtig verstanden habe. Welchen Preis möchten Sie für die Immobilie?",
      Italian: "Mi scusi, voglio solo essere sicuro di aver capito bene. Che prezzo vorrebbe per l'immobile?",
      Polish: "Przepraszam, chcę się tylko upewnić, że dobrze zrozumiałem. Jaką cenę chciałby Pan za nieruchomość?",
      Vietnamese: "Xin lỗi, tôi chỉ muốn chắc là mình hiểu đúng. Anh/chị muốn bán căn nhà với giá bao nhiêu?",
      Mandarin: "不好意思，我想确认一下我没理解错。您希望这处房产卖多少钱？",
      Korean: "죄송합니다, 제가 제대로 이해했는지 확인하고 싶어서요. 이 부동산의 희망 가격이 얼마인가요?",
      Japanese: "すみません、念のため確認させてください。物件のご希望価格はおいくらですか？",
      Hebrew: "סליחה, רק רוצה לוודא שהבנתי נכון. איזה מחיר היית רוצה על הנכס?",
      Arabic: "عذراً، أريد فقط التأكد من أنني فهمت بشكل صحيح. ما السعر الذي تريده مقابل العقار؟",
      Russian: "Извините, хочу убедиться, что правильно понял. Какую цену вы хотели бы за недвижимость?",
      Greek: "Συγγνώμη, θέλω απλώς να βεβαιωθώ ότι κατάλαβα σωστά. Τι τιμή θα θέλατε για το ακίνητο;",
      "Indian (Hindi or Other)": "माफ़ कीजिए, बस पक्का करना चाहता हूँ कि मैंने सही समझा। आप प्रॉपर्टी के लिए कितनी कीमत चाहेंगे?",
    },
  },
  v3_connected_person_check: {
    short: "cpc", stage_code: "S1", stage_label: "Stage 1 Connected Person (can you speak for the owner?)",
    fires: "§21 S1: \"my wife owns it\" / \"it's my dad's\" / \"I manage it\" (or an LLC claim from a person tagged Resident/Likely Renting). Asked once; yes → interest; a number → referral capture; no → archive the pairing.",
    copy: {
      English: "Thanks for letting me know. Are you able to speak for the owner on it, or is there a better way to reach them?",
      Spanish: "Gracias por avisarme. ¿Usted puede hablar por el dueño sobre la propiedad, o hay una mejor manera de contactarlo?",
      Portuguese: "Obrigado por avisar. Você pode falar pelo proprietário sobre o imóvel, ou existe uma forma melhor de falar com ele?",
      French: "Merci de me le dire. Pouvez-vous parler au nom du propriétaire, ou y a-t-il un meilleur moyen de le joindre ?",
      German: "Danke für die Info. Können Sie für den Eigentümer sprechen, oder wie erreiche ich ihn am besten?",
      Italian: "Grazie per avermelo detto. Può parlare a nome del proprietario, o c'è un modo migliore per contattarlo?",
      Polish: "Dzięki za informację. Czy może Pan rozmawiać w imieniu właściciela, czy jest lepszy sposób, żeby się z nim skontaktować?",
      Vietnamese: "Cảm ơn anh/chị đã cho biết. Anh/chị có thể thay mặt chủ nhà trao đổi không, hay có cách nào tốt hơn để liên lạc với họ?",
      Mandarin: "谢谢告诉我。您可以代表房主谈这件事吗？还是有更好的方式联系到房主？",
      Korean: "알려 주셔서 감사합니다. 소유주를 대신해서 이야기해 주실 수 있나요, 아니면 소유주께 연락할 더 좋은 방법이 있을까요?",
      Japanese: "教えていただきありがとうございます。所有者の方の代わりにお話しいただけますか？それとも、所有者の方に直接連絡できる方法はありますか？",
      Hebrew: "תודה שעדכנת. אתה יכול לדבר בשם הבעלים לגבי הנכס, או שיש דרך טובה יותר להשיג אותם?",
      Arabic: "شكراً لإخباري. هل يمكنك التحدث نيابة عن المالك بخصوص العقار، أم هناك طريقة أفضل للتواصل معه؟",
      Russian: "Спасибо, что сказали. Можете ли вы говорить от имени владельца, или как лучше с ним связаться?",
      Greek: "Ευχαριστώ που με ενημερώσατε. Μπορείτε να μιλήσετε εκ μέρους του ιδιοκτήτη ή υπάρχει καλύτερος τρόπος να επικοινωνήσω μαζί του;",
      "Indian (Hindi or Other)": "बताने के लिए धन्यवाद। क्या आप मालिक की ओर से इस बारे में बात कर सकते हैं, या उनसे संपर्क करने का कोई बेहतर तरीका है?",
    },
  },
  v3_conditional_ask_price: {
    short: "cap", stage_code: "S3", stage_label: "Stage 3 Conditional Interest → Asking Price",
    fires: "§23 S1/S2: \"depends on the price\" / \"for the right price\" / \"if it's a good offer\" (also inside a soft \"no, but…\"). Conditional interest → price discovery.",
    copy: {
      English: "Fair enough. What number would make it worth it for you?",
      Spanish: "Me parece justo. ¿Qué número haría que valiera la pena para usted?",
      Portuguese: "Faz sentido. Qual valor faria valer a pena para você?",
      French: "C'est normal. Quel montant en vaudrait la peine pour vous ?",
      German: "Verständlich. Welcher Betrag würde sich für Sie lohnen?",
      Italian: "Giusto. Quale cifra varrebbe la pena per lei?",
      Polish: "Rozumiem. Jaka kwota byłaby dla Pana warta rozważenia?",
      Vietnamese: "Hợp lý. Con số nào thì anh/chị thấy đáng để bán?",
      Mandarin: "可以理解。多少钱您会觉得值得考虑？",
      Korean: "그럴 수 있죠. 어느 정도 금액이면 고려해 보실 만할까요?",
      Japanese: "ごもっともです。いくらなら検討する価値があるとお考えですか？",
      Hebrew: "הוגן. איזה מספר יהיה שווה את זה מבחינתך?",
      Arabic: "معك حق. ما الرقم الذي يجعل الأمر يستحق بالنسبة لك؟",
      Russian: "Справедливо. Какая сумма была бы для вас интересной?",
      Greek: "Λογικό. Ποιο ποσό θα άξιζε για εσάς;",
      "Indian (Hindi or Other)": "ठीक है। कितनी कीमत आपके लिए सही रहेगी?",
    },
  },
});

/**
 * EXISTING use cases the machine names with NO row in a language (from
 * LANGUAGE_COVERAGE.csv, status missing / active-not-safe), drafted so every
 * registry language has a path. consider_selling_follow_up is drafted WITHOUT
 * the {{seller_first_name}} / {{property_address}} placeholders of the EN/ES rows.
 */
export const ACQ_OS_MISSING_LANGUAGE_ROWS = Object.freeze({
  consider_selling: {
    short: "cs", stage_code: "S2", stage_label: "Stage 2 Consider Selling",
    en: "Thanks for confirming. Would you consider a proposal for the property?",
    copy: {
      Portuguese: "Obrigado por confirmar. Você consideraria uma proposta pelo imóvel?",
      French: "Merci de confirmer. Seriez-vous ouvert à une proposition pour le bien ?",
      German: "Danke für die Bestätigung. Wären Sie offen für ein Angebot für die Immobilie?",
      Italian: "Grazie della conferma. Prenderebbe in considerazione una proposta per l'immobile?",
      Polish: "Dzięki za potwierdzenie. Czy rozważyłby Pan propozycję kupna nieruchomości?",
    },
  },
  consider_selling_follow_up: {
    short: "csf", stage_code: "S2", stage_label: "Stage 2 Consider Selling Follow-Up",
    en: "Just checking in: if the numbers made sense, would you look at a proposal?",
    copy: {
      Portuguese: "Só para confirmar: se os números fizessem sentido, você consideraria uma proposta?",
      French: "Juste pour savoir : si les chiffres tenaient la route, regarderiez-vous une proposition ?",
      German: "Nur kurz nachgefragt: Wenn die Zahlen passen, würden Sie sich ein Angebot ansehen?",
      Italian: "Solo per chiedere: se i numeri tornassero, valuterebbe una proposta?",
      Polish: "Pytam tylko: jeśli liczby by się zgadzały, czy rzuciłby Pan okiem na propozycję?",
      Vietnamese: "Tôi hỏi lại chút: nếu con số hợp lý, anh/chị có muốn xem thử một đề nghị không?",
      Mandarin: "想再确认一下：如果价格合适，您愿意看看报价吗？",
      Korean: "다시 여쭤봐요. 조건이 맞으면 제안을 한번 보시겠어요?",
      Japanese: "念のための確認です。条件が合えば、ご提案を見ていただけますか？",
      Hebrew: "רק בודק: אם המספרים יסתדרו, תהיה מוכן להסתכל על הצעה?",
      Arabic: "أردت فقط أن أتأكد: إذا كانت الأرقام مناسبة، هل تود الاطلاع على عرض؟",
      Russian: "Просто уточню: если цифры вас устроят, рассмотрите предложение?",
      Greek: "Απλώς ρωτάω: αν τα νούμερα βγαίνουν, θα κοιτάζατε μια πρόταση;",
      "Indian (Hindi or Other)": "बस पूछ रहा हूँ: अगर आँकड़े सही बैठें, तो क्या आप एक ऑफ़र देखना चाहेंगे?",
    },
  },
  price_high_condition_probe: {
    short: "phc", stage_code: "S4", stage_label: "Stage 4 Condition (near value)",
    en: "Got it. Is the property updated, or does it need work?",
    copy: {
      Portuguese: "Entendi. O imóvel está reformado ou precisa de obras?",
      Italian: "Capito. L'immobile è ristrutturato o ha bisogno di lavori?",
      Polish: "Rozumiem. Nieruchomość jest odnowiona, czy wymaga remontu?",
      Vietnamese: "Tôi hiểu rồi. Căn nhà đã được sửa sang chưa, hay còn cần sửa chữa?",
      Mandarin: "明白了。房子是翻新过的，还是需要修整？",
      Korean: "알겠습니다. 집이 수리가 된 상태인가요, 아니면 손볼 곳이 있나요?",
      Hebrew: "הבנתי. הנכס משופץ, או שהוא צריך עבודה?",
    },
  },
  repair_clarification: {
    short: "rc", stage_code: "S4", stage_label: "Stage 4 Major Repairs",
    en: "Understood. When you say it needs work, is that mostly cosmetic like paint and flooring, or bigger items like roof, HVAC, or foundation?",
    copy: {
      Portuguese: "Entendi. Quando diz que precisa de obras, é mais coisa estética, como pintura e piso, ou itens maiores como telhado, ar-condicionado ou fundação?",
      French: "Compris. Quand vous dites qu'il y a des travaux, c'est surtout esthétique comme la peinture et les sols, ou de gros postes comme le toit, le chauffage/la clim ou les fondations ?",
      German: "Verstanden. Wenn Sie sagen, es muss etwas gemacht werden: eher optisch wie Farbe und Böden, oder größere Dinge wie Dach, Heizung/Klima oder Fundament?",
      Italian: "Capito. Quando dice che servono lavori, si tratta più di cose estetiche come pittura e pavimenti, o di interventi grossi come tetto, climatizzazione o fondamenta?",
      Polish: "Rozumiem. Gdy mówi Pan, że wymaga pracy, to bardziej kosmetyka, jak malowanie i podłogi, czy większe rzeczy, jak dach, ogrzewanie/klimatyzacja albo fundamenty?",
      Vietnamese: "Tôi hiểu. Khi anh/chị nói nhà cần sửa, đó chủ yếu là sơn sửa, sàn nhà, hay là những hạng mục lớn như mái, điều hòa hoặc móng?",
      Mandarin: "明白。您说需要修整，主要是刷漆、地板这类表面工作，还是屋顶、空调暖气或地基这样的大项目？",
      Korean: "알겠습니다. 손볼 곳이 있다고 하셨는데, 페인트나 바닥 같은 외관 위주인가요, 아니면 지붕, 냉난방, 기초 같은 큰 공사인가요?",
      Japanese: "承知しました。手直しが必要とのことですが、塗装や床など見た目の部分が中心ですか？それとも屋根、空調、基礎などの大きな工事ですか？",
      Hebrew: "הבנתי. כשאתה אומר שהוא צריך עבודה, זה בעיקר קוסמטי כמו צבע וריצוף, או דברים גדולים כמו גג, מיזוג או יסודות?",
      Arabic: "فهمت. عندما تقول إنه يحتاج إلى عمل، هل هو في الغالب تجميلي مثل الدهان والأرضيات، أم أمور أكبر مثل السقف أو التكييف أو الأساسات؟",
      Russian: "Понял. Когда вы говорите, что нужен ремонт, это в основном косметика, вроде покраски и полов, или что-то крупное, например крыша, отопление/кондиционер или фундамент?",
      Greek: "Κατάλαβα. Όταν λέτε ότι θέλει δουλειά, είναι κυρίως αισθητικά, όπως βάψιμο και δάπεδα, ή μεγαλύτερα, όπως στέγη, κλιματισμός ή θεμέλια;",
      "Indian (Hindi or Other)": "समझ गया। जब आप कहते हैं कि काम चाहिए, तो क्या यह ज़्यादातर पेंट और फ़र्श जैसा ऊपरी काम है, या छत, एसी/हीटिंग या नींव जैसे बड़े काम?",
    },
  },
  seller_asking_price: {
    short: "sap", stage_code: "S3", stage_label: "Stage 3 Asking Price",
    en: "Got it. What price would you have in mind for the property?",
    copy: {
      Portuguese: "Entendi. Que preço você tem em mente para o imóvel?",
      French: "Compris. Quel prix auriez-vous en tête pour le bien ?",
      German: "Verstanden. Welchen Preis hätten Sie für die Immobilie im Kopf?",
      Italian: "Capito. Che prezzo avrebbe in mente per l'immobile?",
      Polish: "Rozumiem. Jaką cenę ma Pan na myśli za nieruchomość?",
    },
  },
});

/** EN/ES alternatives for owner copy review (not rows). */
export const ACQ_OS_COPY_ALTERNATIVES = Object.freeze({
  v3_ask_price_number: [
    { English: "Perfect. What were you thinking price-wise?", Spanish: "Perfecto. ¿Qué precio estaba pensando?" },
    { English: "Good to hear. What's the number?", Spanish: "Qué bien. ¿Cuál es el número?" },
  ],
  v3_price_clarify: [
    { English: "Just to be sure I've got it right, what would you want to sell it for?", Spanish: "Solo para estar seguro, ¿en cuánto la quisiera vender?" },
  ],
  v3_connected_person_check: [
    { English: "Got it, thanks. Can you make decisions on the property for them, or should I reach out to them directly?", Spanish: "Entendido, gracias. ¿Puede decidir sobre la propiedad por ellos, o mejor me comunico directamente?" },
  ],
  v3_conditional_ask_price: [
    { English: "Makes sense. What would the right price be for you?", Spanish: "Tiene sentido. ¿Cuál sería el precio correcto para usted?" },
  ],
});

/** Flat rows in sms_templates shape (inactive, not safe, unreviewed). */
export function proposedAcqOsTemplateRows() {
  const code = Object.fromEntries(ACQ_OS_LANGS);
  const rows = [];
  for (const [use_case, spec] of Object.entries(ACQ_OS_USE_CASES)) {
    for (const [language] of ACQ_OS_LANGS) {
      const body = spec.copy[language];
      if (!body) continue;
      rows.push({
        template_id: `lc-v3a-${spec.short}-${code[language]}-1`,
        use_case,
        language,
        template_body: body,
        english_translation: language === "English" ? null : spec.copy.English,
        stage_code: spec.stage_code,
        stage_label: spec.stage_label,
        fires: spec.fires,
        native_review: language !== "English" && language !== "Spanish",
        review_status: "unreviewed",
        kind: "new_use_case",
      });
    }
  }
  for (const [use_case, spec] of Object.entries(ACQ_OS_MISSING_LANGUAGE_ROWS)) {
    for (const [language, body] of Object.entries(spec.copy)) {
      rows.push({
        template_id: `lc-v3am-${spec.short}-${code[language]}-1`,
        use_case,
        language,
        template_body: body,
        english_translation: spec.en,
        stage_code: spec.stage_code,
        stage_label: spec.stage_label,
        fires: `existing use case, no approved row in ${language}`,
        native_review: true,
        review_status: "unreviewed",
        kind: "missing_language",
      });
    }
  }
  return rows;
}
