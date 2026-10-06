// PROPOSED sms_templates copy for Seller Autopilot S1–S4 v2 (owner brief
// 2026-10-06). NOT LIVE: this file only feeds
//   • the generated migration supabase/migrations/PROPOSED_20261006090000_seller_autopilot_v2_templates.sql
//     (every row INACTIVE, safe_for_auto_reply = false), and
//   • the offline audit replay / tests (to show what approval would unlock).
// Nothing here is ever sent from code: the live path selects only active,
// safe sms_templates rows (owner rule 2026-10-01).
//
// Copy rules: persona "Alex" voice (first person, no name placeholder so the
// row can never fail to render), short, no false claims, no tax/legal advice
// beyond a hedged "can sometimes help", {{offer_price}} is the ONLY money
// placeholder and renders only from the authoritative, MAO-capped amount.
// Non-Latin scripts are native script and need NATIVE REVIEW before approval.

export const V2_LANGS = Object.freeze([
  ["English", "en"], ["Spanish", "es"], ["Portuguese", "pt"], ["French", "fr"], ["German", "de"],
  ["Italian", "it"], ["Polish", "pl"], ["Vietnamese", "vi"], ["Mandarin", "zh"], ["Korean", "ko"],
  ["Japanese", "ja"], ["Hebrew", "he"], ["Arabic", "ar"], ["Russian", "ru"], ["Greek", "el"],
  ["Indian (Hindi or Other)", "hi"],
]);

export const NATIVE_REVIEW_LANGUAGES = Object.freeze(new Set([
  "Mandarin", "Korean", "Japanese", "Hebrew", "Arabic", "Russian", "Greek", "Indian (Hindi or Other)",
]));

/** New use cases: every language. */
export const V2_NEW_USE_CASES = Object.freeze({
  no_price_condition_probe: {
    stage_code: "S4", stage_label: "Stage 4 No-Price Condition",
    en: "No worries, I can run the numbers. What's the condition of the property right now?",
    copy: {
      English: "No worries, I can run the numbers. What's the condition of the property right now?",
      Spanish: "No hay problema, yo puedo sacar los números. ¿En qué condición está la propiedad ahora?",
      Portuguese: "Sem problema, eu posso fazer as contas. Em que condição está o imóvel agora?",
      French: "Pas de souci, je peux faire les calculs. Dans quel état est la propriété en ce moment ?",
      German: "Kein Problem, ich kann die Zahlen durchrechnen. In welchem Zustand ist die Immobilie gerade?",
      Italian: "Nessun problema, posso fare io i conti. In che condizioni è l'immobile adesso?",
      Polish: "Nie ma problemu, mogę to policzyć. W jakim stanie jest teraz nieruchomość?",
      Vietnamese: "Không sao, tôi có thể tính toán. Hiện tại tình trạng căn nhà thế nào?",
      Mandarin: "没问题，我可以先算一下。房子现在的状况怎么样？",
      Korean: "괜찮습니다, 제가 계산해 볼게요. 지금 집 상태는 어떤가요?",
      Japanese: "大丈夫です、こちらで計算してみます。物件の今の状態はいかがですか？",
      Hebrew: "אין בעיה, אני יכול לעשות את החישוב. מה המצב של הנכס כרגע?",
      Arabic: "لا مشكلة، أستطيع حساب الأرقام. ما هي حالة العقار الآن؟",
      Russian: "Не проблема, я могу сам всё посчитать. В каком состоянии сейчас недвижимость?",
      Greek: "Κανένα πρόβλημα, μπορώ να κάνω τους υπολογισμούς. Σε τι κατάσταση είναι το ακίνητο τώρα;",
      "Indian (Hindi or Other)": "कोई बात नहीं, मैं हिसाब लगा सकता हूँ। अभी प्रॉपर्टी की हालत कैसी है?",
    },
  },
  as_is_comp_anchor: {
    stage_code: "S5", stage_label: "Stage 5 As-Is Comp Anchor",
    en: "Thanks for confirming. Looking at the numbers, as-is sales nearby are going for around {{offer_price}}. Would you consider something in that ballpark?",
    copy: {
      English: "Thanks for confirming. Looking at the numbers, as-is sales nearby are going for around {{offer_price}}. Would you consider something in that ballpark?",
      Spanish: "Gracias por confirmar. Viendo los números, las ventas cercanas en su estado actual andan por {{offer_price}}. ¿Consideraría algo en ese rango?",
      Portuguese: "Obrigado por confirmar. Pelos números, as vendas próximas no estado atual estão em torno de {{offer_price}}. Você consideraria algo nessa faixa?",
      French: "Merci de confirmer. D'après les chiffres, les ventes en l'état dans le secteur tournent autour de {{offer_price}}. Envisageriez-vous quelque chose dans cet ordre ?",
      German: "Danke für die Bestätigung. Laut den Zahlen liegen Verkäufe im aktuellen Zustand in der Nähe bei etwa {{offer_price}}. Wäre etwas in dieser Größenordnung denkbar?",
      Italian: "Grazie della conferma. Guardando i numeri, le vendite vicine nello stato attuale sono intorno a {{offer_price}}. Considererebbe qualcosa in quella fascia?",
      Polish: "Dzięki za potwierdzenie. Z liczb wynika, że sprzedaże w obecnym stanie w okolicy są w granicach {{offer_price}}. Czy rozważyłbyś coś w tym przedziale?",
      Vietnamese: "Cảm ơn đã xác nhận. Theo số liệu, nhà bán nguyên trạng gần đó khoảng {{offer_price}}. Bạn có cân nhắc mức đó không?",
      Mandarin: "谢谢确认。从数据看，附近按现状出售的房子大约在{{offer_price}}左右。您会考虑这个范围吗？",
      Korean: "확인 감사합니다. 수치를 보면 근처에서 현재 상태 그대로 팔린 집들이 {{offer_price}} 정도입니다. 그 정도 선이면 고려해 보시겠어요?",
      Japanese: "ご確認ありがとうございます。数字を見ると、近くの現状渡しの売買は{{offer_price}}前後です。そのくらいの金額でご検討いただけますか？",
      Hebrew: "תודה על האישור. לפי המספרים, נכסים במצבם הנוכחי באזור נמכרים בסביבות {{offer_price}}. היית שוקל משהו בטווח הזה?",
      Arabic: "شكراً للتأكيد. حسب الأرقام، العقارات القريبة تُباع بحالتها الحالية بحوالي {{offer_price}}. هل تفكر في شيء ضمن هذا النطاق؟",
      Russian: "Спасибо, что подтвердили. По цифрам, объекты рядом в текущем состоянии продаются примерно за {{offer_price}}. Рассмотрели бы вы что-то в этом диапазоне?",
      Greek: "Ευχαριστώ για την επιβεβαίωση. Με βάση τα νούμερα, οι πωλήσεις στην περιοχή στην τρέχουσα κατάσταση είναι γύρω στα {{offer_price}}. Θα το σκεφτόσασταν;",
      "Indian (Hindi or Other)": "पुष्टि के लिए धन्यवाद। आंकड़ों के हिसाब से, आसपास की प्रॉपर्टी मौजूदा हालत में लगभग {{offer_price}} में बिक रही हैं। क्या आप इस रेंज में कुछ सोचेंगे?",
    },
  },
  price_anchor_above_max: {
    // Comps above our max: NO comp language (owner 2026-10-06). X = the
    // engine's opening offer per the negotiation rule, never above MAO.
    stage_code: "S5", stage_label: "Stage 5 Anchor (comps above max — no comp claim)",
    en: "Based on the property and the numbers, we'd need to be around {{offer_price}} to make it work. Would you consider something in that range?",
    copy: {
      English: "Based on the property and the numbers, we'd need to be around {{offer_price}} to make it work. Would you consider something in that range?",
      Spanish: "Según la propiedad y los números, tendríamos que estar alrededor de {{offer_price}} para que funcione. ¿Consideraría algo en ese rango?",
      Portuguese: "Pelo imóvel e pelos números, precisaríamos ficar em torno de {{offer_price}} para dar certo. Você consideraria algo nessa faixa?",
      French: "D'après la propriété et les chiffres, il faudrait être autour de {{offer_price}} pour que ça fonctionne. Envisageriez-vous quelque chose dans cet ordre ?",
      German: "Nach der Immobilie und den Zahlen müssten wir bei etwa {{offer_price}} liegen, damit es passt. Wäre etwas in dieser Größenordnung denkbar?",
      Italian: "In base all'immobile e ai numeri, dovremmo essere intorno a {{offer_price}} per farlo funzionare. Considererebbe qualcosa in quella fascia?",
      Polish: "Biorąc pod uwagę nieruchomość i liczby, musielibyśmy być w okolicach {{offer_price}}, żeby to miało sens. Czy rozważyłbyś coś w tym przedziale?",
      Vietnamese: "Dựa trên căn nhà và các con số, chúng tôi cần ở mức khoảng {{offer_price}} để thực hiện được. Bạn có cân nhắc mức đó không?",
      Mandarin: "根据房子的情况和数字，我们需要在{{offer_price}}左右才能做成。您会考虑这个范围吗？",
      Korean: "집 상태와 수치를 보면 저희는 {{offer_price}} 정도여야 진행이 가능합니다. 그 정도 선이면 고려해 보시겠어요?",
      Japanese: "物件と数字から見て、成立させるには{{offer_price}}前後になります。そのくらいの金額でご検討いただけますか？",
      Hebrew: "לפי הנכס והמספרים, נצטרך להיות בסביבות {{offer_price}} כדי שזה יעבוד. היית שוקל משהו בטווח הזה?",
      Arabic: "بناءً على العقار والأرقام، سنحتاج أن نكون في حدود {{offer_price}} لكي ينجح الأمر. هل تفكر في شيء ضمن هذا النطاق؟",
      Russian: "Исходя из объекта и цифр, нам нужно быть в районе {{offer_price}}, чтобы сделка получилась. Рассмотрели бы вы такой вариант?",
      Greek: "Με βάση το ακίνητο και τα νούμερα, θα πρέπει να είμαστε γύρω στα {{offer_price}} για να βγει. Θα το σκεφτόσασταν;",
      "Indian (Hindi or Other)": "प्रॉपर्टी और आंकड़ों के हिसाब से, बात बनने के लिए हमें लगभग {{offer_price}} के आसपास रहना होगा। क्या आप इस रेंज में कुछ सोचेंगे?",
    },
  },
  ownership_connection_clarifier: {
    // ONE time, after a bare "No" to "do you own …?" (owner 2026-10-06).
    stage_code: "S1", stage_label: "Stage 1 Ownership Connection Clarifier",
    en: "Got it. Are you connected to the property, or do I have the wrong number?",
    copy: {
      English: "Got it. Are you connected to the property, or do I have the wrong number?",
      Spanish: "Entendido. ¿Tiene alguna relación con la propiedad, o tengo el número equivocado?",
      Portuguese: "Entendi. Você tem alguma ligação com o imóvel, ou estou com o número errado?",
      French: "Compris. Êtes-vous lié à la propriété, ou ai-je le mauvais numéro ?",
      German: "Verstanden. Haben Sie einen Bezug zu der Immobilie, oder habe ich die falsche Nummer?",
      Italian: "Capito. Ha un legame con l'immobile, o ho il numero sbagliato?",
      Polish: "Rozumiem. Czy masz jakiś związek z tą nieruchomością, czy mam zły numer?",
      Vietnamese: "Tôi hiểu. Bạn có liên quan đến bất động sản này không, hay tôi nhầm số?",
      Mandarin: "明白了。您和这处房产有关系吗，还是我打错号码了？",
      Korean: "알겠습니다. 이 부동산과 관련이 있으신가요, 아니면 제가 번호를 잘못 알고 있나요?",
      Japanese: "承知しました。この物件と関係はおありですか、それとも番号違いでしょうか？",
      Hebrew: "הבנתי. יש לך קשר לנכס, או שיש לי מספר שגוי?",
      Arabic: "فهمت. هل لك علاقة بالعقار، أم أن الرقم خاطئ؟",
      Russian: "Понял. Вы как-то связаны с этой недвижимостью, или у меня неверный номер?",
      Greek: "Κατάλαβα. Έχετε κάποια σχέση με το ακίνητο ή έχω λάθος αριθμό;",
      "Indian (Hindi or Other)": "समझ गया। क्या आपका इस प्रॉपर्टी से कोई संबंध है, या मेरे पास गलत नंबर है?",
    },
  },
  capital_gains_creative_probe: {
    stage_code: "S4C", stage_label: "Stage 4C Capital Gains Creative Probe",
    en: "Totally understand. Would you be open to something like seller financing or a lease option? That can sometimes help with capital gains.",
    copy: {
      English: "Totally understand. Would you be open to something like seller financing or a lease option? That can sometimes help with capital gains.",
      Spanish: "Lo entiendo. ¿Estaría abierto a algo como financiamiento del dueño o un arrendamiento con opción a compra? A veces eso ayuda con los impuestos sobre la ganancia.",
      Portuguese: "Entendo. Você estaria aberto a algo como financiamento pelo proprietário ou aluguel com opção de compra? Às vezes isso ajuda com o imposto sobre ganho de capital.",
      French: "Je comprends. Seriez-vous ouvert à un financement par le vendeur ou une location avec option d'achat ? Cela peut parfois aider pour l'impôt sur la plus-value.",
      German: "Verstehe. Wären Sie offen für eine Verkäuferfinanzierung oder Miete mit Kaufoption? Das kann manchmal bei der Steuer auf den Gewinn helfen.",
      Italian: "Capisco. Sarebbe aperto a un finanziamento da parte del venditore o a un affitto con riscatto? A volte aiuta con le tasse sulla plusvalenza.",
      Polish: "Rozumiem. Czy byłbyś otwarty na finansowanie przez sprzedającego albo najem z opcją kupna? Czasem to pomaga z podatkiem od zysku.",
      Vietnamese: "Tôi hiểu. Bạn có cân nhắc hình thức người bán cho trả góp hoặc thuê có quyền mua không? Đôi khi cách đó giúp giảm thuế lãi vốn.",
      Mandarin: "理解。您愿意考虑卖方融资或带购买选择权的租赁吗？有时这样对资本利得税有帮助。",
      Korean: "이해합니다. 매도인 금융이나 매입 옵션부 임대 같은 방식도 고려해 보시겠어요? 경우에 따라 양도소득세에 도움이 될 수 있습니다.",
      Japanese: "よく分かります。売主ファイナンスやリースオプションのような形はご検討いただけますか？場合によっては譲渡益の税金に役立ちます。",
      Hebrew: "מבין. היית פתוח למשהו כמו מימון מצד המוכר או שכירות עם אופציה לרכישה? לפעמים זה עוזר עם מס שבח.",
      Arabic: "أتفهم ذلك. هل أنت منفتح على شيء مثل تمويل البائع أو الإيجار مع خيار الشراء؟ أحياناً يساعد ذلك في ضريبة الأرباح الرأسمالية.",
      Russian: "Понимаю. Вы бы рассмотрели рассрочку от продавца или аренду с правом выкупа? Иногда это помогает с налогом на прирост капитала.",
      Greek: "Καταλαβαίνω. Θα ήσασταν ανοιχτός σε χρηματοδότηση από τον πωλητή ή μίσθωση με δικαίωμα αγοράς; Μερικές φορές βοηθά με τον φόρο υπεραξίας.",
      "Indian (Hindi or Other)": "समझ सकता हूँ। क्या आप सेलर फाइनेंसिंग या लीज़ ऑप्शन जैसी व्यवस्था पर विचार करेंगे? कभी-कभी इससे कैपिटल गेन्स टैक्स में मदद मिलती है।",
    },
  },
  who_is_this_resume_ownership: {
    stage_code: "SP", stage_label: "Identity Response (resume S1)",
    en: "I'm a local real estate investor. I reached out about your property. Are you the owner?",
    copy: {
      English: "I'm a local real estate investor. I reached out about your property. Are you the owner?",
      Spanish: "Soy un inversionista de bienes raíces local. Le escribí por su propiedad. ¿Usted es el dueño?",
      Portuguese: "Sou um investidor imobiliário local. Entrei em contato sobre o seu imóvel. Você é o proprietário?",
      French: "Je suis un investisseur immobilier local. Je vous ai contacté au sujet de votre propriété. Êtes-vous le propriétaire ?",
      German: "Ich bin ein lokaler Immobilieninvestor. Ich habe mich wegen Ihrer Immobilie gemeldet. Sind Sie der Eigentümer?",
      Italian: "Sono un investitore immobiliare della zona. L'ho contattata per il suo immobile. È lei il proprietario?",
      Polish: "Jestem lokalnym inwestorem w nieruchomości. Piszę w sprawie Twojej nieruchomości. Czy jesteś właścicielem?",
      Vietnamese: "Tôi là nhà đầu tư bất động sản ở địa phương. Tôi liên hệ về bất động sản của bạn. Bạn có phải là chủ sở hữu không?",
      Mandarin: "我是本地的房地产投资人，联系您是关于您的房产。请问您是业主吗？",
      Korean: "저는 지역 부동산 투자자입니다. 귀하의 부동산 때문에 연락드렸어요. 소유주이신가요?",
      Japanese: "地元の不動産投資家です。ご所有の物件についてご連絡しました。所有者の方でしょうか？",
      Hebrew: "אני משקיע נדל״ן מקומי. פניתי בקשר לנכס שלך. אתה הבעלים?",
      Arabic: "أنا مستثمر عقاري محلي. تواصلت معك بخصوص عقارك. هل أنت المالك؟",
      Russian: "Я местный инвестор в недвижимость. Пишу насчёт вашей недвижимости. Вы владелец?",
      Greek: "Είμαι τοπικός επενδυτής ακινήτων. Επικοινώνησα για το ακίνητό σας. Είστε ο ιδιοκτήτης;",
      "Indian (Hindi or Other)": "मैं एक स्थानीय रियल एस्टेट निवेशक हूँ। मैंने आपकी प्रॉपर्टी के बारे में संपर्क किया था। क्या आप इसके मालिक हैं?",
    },
  },
  who_is_this_resume_price: {
    stage_code: "SP", stage_label: "Identity Response (resume S3)",
    en: "I'm a local real estate investor reaching out about your property. Do you have a price in mind for it?",
    copy: {
      English: "I'm a local real estate investor reaching out about your property. Do you have a price in mind for it?",
      Spanish: "Soy un inversionista de bienes raíces local y le escribí por su propiedad. ¿Tiene un precio en mente?",
      Portuguese: "Sou um investidor imobiliário local e entrei em contato sobre o seu imóvel. Você tem um preço em mente?",
      French: "Je suis un investisseur immobilier local et je vous contacte au sujet de votre propriété. Avez-vous un prix en tête ?",
      German: "Ich bin ein lokaler Immobilieninvestor und melde mich wegen Ihrer Immobilie. Haben Sie einen Preis im Kopf?",
      Italian: "Sono un investitore immobiliare della zona e la contatto per il suo immobile. Ha un prezzo in mente?",
      Polish: "Jestem lokalnym inwestorem w nieruchomości i piszę w sprawie Twojej nieruchomości. Masz na myśli jakąś cenę?",
      Vietnamese: "Tôi là nhà đầu tư bất động sản ở địa phương, liên hệ về bất động sản của bạn. Bạn có giá nào trong đầu không?",
      Mandarin: "我是本地的房地产投资人，联系您是关于您的房产。您心里有价位吗？",
      Korean: "저는 지역 부동산 투자자이고 귀하의 부동산 때문에 연락드렸어요. 생각하시는 가격이 있으신가요?",
      Japanese: "地元の不動産投資家で、ご所有の物件についてご連絡しました。ご希望の価格はありますか？",
      Hebrew: "אני משקיע נדל״ן מקומי ופניתי בקשר לנכס שלך. יש לך מחיר בראש?",
      Arabic: "أنا مستثمر عقاري محلي وتواصلت معك بخصوص عقارك. هل لديك سعر في ذهنك؟",
      Russian: "Я местный инвестор в недвижимость и пишу насчёт вашей недвижимости. У вас есть цена на примете?",
      Greek: "Είμαι τοπικός επενδυτής ακινήτων και επικοινωνώ για το ακίνητό σας. Έχετε κάποια τιμή στο μυαλό σας;",
      "Indian (Hindi or Other)": "मैं एक स्थानीय रियल एस्टेट निवेशक हूँ और आपकी प्रॉपर्टी के बारे में संपर्क कर रहा हूँ। क्या आपके मन में कोई कीमत है?",
    },
  },
  who_is_this_resume_condition: {
    stage_code: "SP", stage_label: "Identity Response (resume S4)",
    en: "I'm a local real estate investor reaching out about your property. What's the condition of it right now?",
    copy: {
      English: "I'm a local real estate investor reaching out about your property. What's the condition of it right now?",
      Spanish: "Soy un inversionista de bienes raíces local y le escribí por su propiedad. ¿En qué condición está ahora?",
      Portuguese: "Sou um investidor imobiliário local e entrei em contato sobre o seu imóvel. Em que condição ele está agora?",
      French: "Je suis un investisseur immobilier local et je vous contacte au sujet de votre propriété. Dans quel état est-elle en ce moment ?",
      German: "Ich bin ein lokaler Immobilieninvestor und melde mich wegen Ihrer Immobilie. In welchem Zustand ist sie gerade?",
      Italian: "Sono un investitore immobiliare della zona e la contatto per il suo immobile. In che condizioni è adesso?",
      Polish: "Jestem lokalnym inwestorem w nieruchomości i piszę w sprawie Twojej nieruchomości. W jakim jest teraz stanie?",
      Vietnamese: "Tôi là nhà đầu tư bất động sản ở địa phương, liên hệ về bất động sản của bạn. Hiện tại tình trạng của nó thế nào?",
      Mandarin: "我是本地的房地产投资人，联系您是关于您的房产。房子现在的状况怎么样？",
      Korean: "저는 지역 부동산 투자자이고 귀하의 부동산 때문에 연락드렸어요. 지금 집 상태는 어떤가요?",
      Japanese: "地元の不動産投資家で、ご所有の物件についてご連絡しました。物件の今の状態はいかがですか？",
      Hebrew: "אני משקיע נדל״ן מקומי ופניתי בקשר לנכס שלך. מה המצב שלו כרגע?",
      Arabic: "أنا مستثمر عقاري محلي وتواصلت معك بخصوص عقارك. ما هي حالته الآن؟",
      Russian: "Я местный инвестор в недвижимость и пишу насчёт вашей недвижимости. В каком она сейчас состоянии?",
      Greek: "Είμαι τοπικός επενδυτής ακινήτων και επικοινωνώ για το ακίνητό σας. Σε τι κατάσταση είναι τώρα;",
      "Indian (Hindi or Other)": "मैं एक स्थानीय रियल एस्टेट निवेशक हूँ और आपकी प्रॉपर्टी के बारे में संपर्क कर रहा हूँ। अभी उसकी हालत कैसी है?",
    },
  },
});

/** Existing use cases that have no row at all in these 7 languages. */
export const V2_MISSING_LANGUAGE_ROWS = Object.freeze({
  price_works_confirm_basics: {
    stage_code: "S4A", stage_label: "Stage 4A Confirm Basics",
    en: "That price should work for us. Just to confirm, is the property vacant or occupied right now?",
    copy: {
      French: "Ce prix devrait nous convenir. Juste pour confirmer, la propriété est-elle vacante ou occupée en ce moment ?",
      German: "Der Preis sollte für uns passen. Nur zur Bestätigung: Steht die Immobilie gerade leer oder ist sie bewohnt?",
      Russian: "Эта цена должна нам подойти. Просто уточню: сейчас объект пустует или в нём кто-то живёт?",
      Japanese: "その価格なら対応できそうです。念のため、物件は今空き家ですか、それとも誰か住んでいますか？",
      Arabic: "هذا السعر يناسبنا على الأرجح. فقط للتأكيد، هل العقار شاغر أم مسكون حالياً؟",
      Greek: "Αυτή η τιμή μάλλον μας κάνει. Απλώς για επιβεβαίωση, το ακίνητο είναι άδειο ή κατοικείται τώρα;",
      "Indian (Hindi or Other)": "यह कीमत हमारे लिए ठीक रहनी चाहिए। बस पुष्टि के लिए, क्या प्रॉपर्टी अभी खाली है या उसमें कोई रहता है?",
    },
  },
  price_high_condition_probe: {
    stage_code: "S4B", stage_label: "Stage 4B Price High Condition Probe",
    en: "Got it. Is the property updated, or does it need work?",
    copy: {
      French: "Compris. La propriété est-elle rénovée, ou a-t-elle besoin de travaux ?",
      German: "Verstanden. Ist die Immobilie renoviert, oder braucht sie Arbeit?",
      Russian: "Понял. Объект в хорошем состоянии или требует ремонта?",
      Japanese: "承知しました。物件はリフォーム済みですか、それとも手直しが必要ですか？",
      Arabic: "فهمت. هل العقار مُجدَّد أم يحتاج إلى إصلاحات؟",
      Greek: "Κατάλαβα. Το ακίνητο είναι ανακαινισμένο ή χρειάζεται δουλειά;",
      "Indian (Hindi or Other)": "समझ गया। क्या प्रॉपर्टी अपडेटेड है, या उसमें काम की ज़रूरत है?",
    },
  },
  who_is_this: {
    stage_code: "SP", stage_label: "Identity Response",
    en: "I'm a local investor here in the area. I reached out about your property. Would you be open to a proposal on it?",
    copy: {
      French: "Je suis un investisseur de la région. Je vous ai contacté au sujet de votre propriété. Seriez-vous ouvert à une proposition ?",
      German: "Ich bin ein Investor hier aus der Gegend. Ich habe mich wegen Ihrer Immobilie gemeldet. Wären Sie offen für ein Angebot?",
      Russian: "Я местный инвестор. Я написал насчёт вашей недвижимости. Вы были бы открыты к предложению?",
      Japanese: "この地域の投資家です。ご所有の物件についてご連絡しました。ご提案をお聞きいただけますか？",
      Arabic: "أنا مستثمر محلي في المنطقة. تواصلت معك بخصوص عقارك. هل أنت منفتح على عرض؟",
      Greek: "Είμαι επενδυτής από την περιοχή. Επικοινώνησα για το ακίνητό σας. Θα ήσασταν ανοιχτός σε μια πρόταση;",
      "Indian (Hindi or Other)": "मैं इसी इलाके का एक स्थानीय निवेशक हूँ। मैंने आपकी प्रॉपर्टी के बारे में संपर्क किया था। क्या आप किसी प्रस्ताव के लिए तैयार होंगे?",
      // The 7 languages below HAVE who_is_this rows, but every one is a
      // statement with no question, needs {{property_address}}, is
      // reply_mode=manual, and its english_translation describes a different
      // message (catalog defect) — so a resume-the-stage row is proposed.
      Portuguese: "Sou um investidor da região. Entrei em contato sobre o seu imóvel. Você estaria aberto a uma proposta?",
      Italian: "Sono un investitore della zona. L'ho contattata per il suo immobile. Sarebbe aperto a una proposta?",
      Polish: "Jestem inwestorem z okolicy. Piszę w sprawie Twojej nieruchomości. Czy byłbyś otwarty na propozycję?",
      Vietnamese: "Tôi là nhà đầu tư ở khu vực này. Tôi liên hệ về bất động sản của bạn. Bạn có sẵn sàng nghe một đề xuất không?",
      Mandarin: "我是本地的投资人，联系您是关于您的房产。您愿意听听我们的报价吗？",
      Korean: "저는 이 지역 투자자입니다. 귀하의 부동산 때문에 연락드렸어요. 제안을 한번 들어보시겠어요?",
      Hebrew: "אני משקיע מהאזור. פניתי בקשר לנכס שלך. היית פתוח להצעה?",
    },
  },
});

const SHORT = {
  no_price_condition_probe: "npcp", as_is_comp_anchor: "acanc", price_anchor_above_max: "pama",
  ownership_connection_clarifier: "ocl",
  capital_gains_creative_probe: "cgcp", who_is_this_resume_ownership: "wis1", who_is_this_resume_price: "wis3",
  who_is_this_resume_condition: "wis4", price_works_confirm_basics: "pwcb", price_high_condition_probe: "phcp",
  who_is_this: "wis2",
};

/** Flat rows in sms_templates shape (inactive, not safe). */
export function proposedTemplateRows() {
  const code = Object.fromEntries(V2_LANGS);
  const rows = [];
  const push = (use_case, spec, language, body, kind) => {
    rows.push({
      template_id: `lc-ap2-${SHORT[use_case]}-${code[language]}-1`,
      use_case,
      language,
      template_body: body,
      english_translation: language === "English" ? null : spec.en,
      stage_code: spec.stage_code,
      stage_label: spec.stage_label,
      kind,
      native_review: NATIVE_REVIEW_LANGUAGES.has(language),
    });
  };
  for (const [use_case, spec] of Object.entries(V2_NEW_USE_CASES)) {
    for (const [language] of V2_LANGS) push(use_case, spec, language, spec.copy[language], "new_use_case");
  }
  for (const [use_case, spec] of Object.entries(V2_MISSING_LANGUAGE_ROWS)) {
    for (const [language, body] of Object.entries(spec.copy)) push(use_case, spec, language, body, "missing_language");
  }
  return rows;
}
