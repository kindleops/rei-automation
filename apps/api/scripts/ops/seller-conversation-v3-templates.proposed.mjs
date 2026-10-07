// PROPOSED sms_templates copy for SELLER CONVERSATION MACHINE v3 (owner brief
// 2026-10-06 late). NOT LIVE: this file only feeds
//   • supabase/migrations/PROPOSED_20261007030000_seller_conversation_v3_templates.sql
//     (every row INACTIVE, safe_for_auto_reply = false, needs owner copy approval),
//   • tmp/conversation-v3/TEMPLATE_MATRIX.csv and EN_ES_COPY_REVIEW.md,
//   • the offline replay (to show what approval would unlock).
//
// Voice: Alex, a local investor. First person, short, warm, plain. No
// corporate tone, no filler, no false claims. No {{seller_first_name}} or
// {{property_address}} so a row can never fail to render. The MF anchor's
// {{per_door_low}} / {{per_door_high}} are NOT yet renderer placeholders
// (render-template.js ALLOWED_TEMPLATE_PLACEHOLDERS) — that row fails closed
// until the renderer + quote log accept a per-door range (owner/lead follow-up).
// Every non-EN/ES row needs native review; non-Latin scripts are native script.

export const V3_LANGS = Object.freeze([
  ["English", "en"], ["Spanish", "es"], ["Portuguese", "pt"], ["French", "fr"], ["German", "de"],
  ["Italian", "it"], ["Polish", "pl"], ["Vietnamese", "vi"], ["Mandarin", "zh"], ["Korean", "ko"],
  ["Japanese", "ja"], ["Hebrew", "he"], ["Arabic", "ar"], ["Russian", "ru"], ["Greek", "el"],
  ["Indian (Hindi or Other)", "hi"],
]);

export const V3_NEW_USE_CASES = Object.freeze({
  v3_price_far_above_nurture: {
    short: "fan", stage_code: "S3", stage_label: "Stage 3 Price Far Above Value (nurture)",
    fires: "Asking price far above our value (> 1.5x or > value + $100K), or an implausible ask. No condition ask; thread goes to 30-day nurture.",
    copy: {
      English: "Thanks for being straight with me. That's a good bit above where the numbers work for me, so I won't waste your time. If you're ever seriously considering an offer, just let me know.",
      Spanish: "Gracias por ser directo conmigo. Eso está bastante por encima de donde me dan los números, así que no le quito su tiempo. Si en algún momento considera en serio una oferta, avíseme.",
      Portuguese: "Obrigado pela sinceridade. Isso está bem acima de onde os números funcionam para mim, então não vou tomar seu tempo. Se algum dia considerar uma oferta a sério, é só me avisar.",
      French: "Merci d'être franc. C'est nettement au-dessus de ce qui fonctionne pour moi, donc je ne vais pas vous faire perdre votre temps. Si un jour vous envisagez sérieusement une offre, faites-moi signe.",
      German: "Danke für die offene Antwort. Das liegt deutlich über dem, was für mich rechnerisch geht, also will ich Ihre Zeit nicht verschwenden. Wenn Sie ein Angebot einmal ernsthaft in Betracht ziehen, melden Sie sich einfach.",
      Italian: "Grazie della sincerità. È parecchio sopra a dove i numeri funzionano per me, quindi non le faccio perdere tempo. Se un giorno valuterà seriamente un'offerta, me lo faccia sapere.",
      Polish: "Dzięki za szczerość. To sporo powyżej tego, co mi się kalkuluje, więc nie będę zabierać Panu czasu. Jeśli kiedyś poważnie rozważy Pan ofertę, proszę dać znać.",
      Vietnamese: "Cảm ơn anh/chị đã nói thẳng. Mức đó cao hơn khá nhiều so với con số tôi có thể làm, nên tôi không muốn làm mất thời gian của anh/chị. Khi nào anh/chị thật sự cân nhắc một lời đề nghị, cứ báo tôi nhé.",
      Mandarin: "谢谢您直说。这个价格比我能做到的高出不少，所以我就不耽误您的时间了。如果您哪天认真考虑报价，随时告诉我。",
      Korean: "솔직하게 말씀해 주셔서 감사합니다. 제가 맞출 수 있는 금액보다 꽤 높아서 시간을 뺏지 않겠습니다. 나중에 제안을 진지하게 고려하시게 되면 언제든 알려 주세요.",
      Japanese: "率直に教えていただきありがとうございます。こちらで合わせられる金額よりかなり上なので、お時間を取らせないようにします。本気でオファーを検討される時が来たら、いつでもご連絡ください。",
      Hebrew: "תודה על הכנות. זה די הרבה מעל מה שהמספרים מאפשרים לי, אז לא אבזבז לך את הזמן. אם תשקול ברצינות הצעה בעתיד, פשוט תודיע לי.",
      Arabic: "شكراً لصراحتك. هذا أعلى بكثير مما تسمح به الأرقام بالنسبة لي، لذلك لن أضيع وقتك. إذا فكرت بجدية في عرض يوماً ما، فقط أخبرني.",
      Russian: "Спасибо за прямоту. Это заметно выше того, что у меня сходится по цифрам, так что не буду отнимать ваше время. Если когда-нибудь всерьёз захотите рассмотреть предложение, просто напишите.",
      Greek: "Ευχαριστώ για την ειλικρίνεια. Αυτό είναι αρκετά πάνω από εκεί που βγαίνουν τα νούμερα για μένα, οπότε δεν θα σας χάσω τον χρόνο. Αν ποτέ σκεφτείτε σοβαρά μια προσφορά, απλώς ενημερώστε με.",
      "Indian (Hindi or Other)": "साफ़ बताने के लिए धन्यवाद। यह मेरे हिसाब से काफ़ी ऊपर है, इसलिए मैं आपका समय बर्बाद नहीं करूँगा। अगर कभी आप किसी ऑफ़र पर गंभीरता से विचार करें, तो बस मुझे बता दीजिए।",
    },
  },
  v3_below_value_condition_occupancy: {
    short: "bvco", stage_code: "S4", stage_label: "Stage 4 Below-Value Condition + Occupancy",
    fires: "Asking price below our value (< 90% of value), condition AND occupancy both still unknown. Next: the offer path.",
    copy: {
      English: "Thanks, that could work. Two quick things: what shape is the place in, and is anyone living there right now?",
      Spanish: "Gracias, eso podría funcionar. Dos cositas rápidas: ¿en qué condición está la casa, y vive alguien ahí ahorita?",
      Portuguese: "Obrigado, isso pode funcionar. Duas perguntas rápidas: em que estado está o imóvel, e tem alguém morando lá agora?",
      French: "Merci, ça pourrait marcher. Deux petites questions : dans quel état est le bien, et est-ce que quelqu'un y habite en ce moment ?",
      German: "Danke, das könnte passen. Zwei kurze Fragen: In welchem Zustand ist das Haus, und wohnt gerade jemand dort?",
      Italian: "Grazie, potrebbe funzionare. Due domande veloci: in che condizioni è la casa, e ci abita qualcuno adesso?",
      Polish: "Dzięki, to może się udać. Dwa szybkie pytania: w jakim stanie jest nieruchomość i czy ktoś tam teraz mieszka?",
      Vietnamese: "Cảm ơn, mức đó có thể được. Cho tôi hỏi nhanh hai điều: nhà đang ở tình trạng thế nào, và hiện có ai đang ở không?",
      Mandarin: "谢谢，这个价格可能可以。快速问两件事：房子现在状况怎么样？现在有人住吗？",
      Korean: "감사합니다, 그 정도면 가능할 수도 있겠네요. 두 가지만 여쭤볼게요. 집 상태는 어떤가요? 지금 누가 살고 있나요?",
      Japanese: "ありがとうございます、その金額なら合うかもしれません。2点だけ教えてください。物件の状態はいかがですか？今どなたか住んでいますか？",
      Hebrew: "תודה, זה יכול להתאים. שתי שאלות קצרות: באיזה מצב הנכס, והאם מישהו גר שם כרגע?",
      Arabic: "شكراً، قد يكون ذلك مناسباً. سؤالان سريعان: ما حالة العقار، وهل يسكن فيه أحد حالياً؟",
      Russian: "Спасибо, это может подойти. Два коротких вопроса: в каком состоянии дом и живёт ли там сейчас кто-нибудь?",
      Greek: "Ευχαριστώ, αυτό μπορεί να λειτουργήσει. Δύο γρήγορες ερωτήσεις: σε τι κατάσταση είναι το ακίνητο και μένει κάποιος εκεί τώρα;",
      "Indian (Hindi or Other)": "धन्यवाद, यह चल सकता है। दो छोटे सवाल: प्रॉपर्टी की हालत कैसी है, और क्या अभी वहाँ कोई रह रहा है?",
    },
  },
  v3_occupancy_check: {
    short: "occ", stage_code: "S4", stage_label: "Stage 4 Occupancy",
    fires: "Condition known, occupancy unknown (any price branch except far-above).",
    copy: {
      English: "Got it, thanks. Is anyone living there right now, or is it vacant?",
      Spanish: "Entendido, gracias. ¿Vive alguien ahí ahorita, o está desocupada?",
      Portuguese: "Entendi, obrigado. Tem alguém morando lá agora, ou está vazio?",
      French: "Compris, merci. Est-ce que quelqu'un y habite en ce moment, ou c'est vide ?",
      German: "Verstanden, danke. Wohnt gerade jemand dort, oder steht es leer?",
      Italian: "Capito, grazie. Ci abita qualcuno adesso o è libera?",
      Polish: "Rozumiem, dzięki. Czy ktoś tam teraz mieszka, czy jest pusto?",
      Vietnamese: "Tôi hiểu rồi, cảm ơn. Hiện có ai đang ở đó không, hay nhà đang trống?",
      Mandarin: "明白了，谢谢。现在有人住吗，还是空着的？",
      Korean: "알겠습니다, 감사합니다. 지금 누가 살고 있나요, 아니면 비어 있나요?",
      Japanese: "わかりました、ありがとうございます。今どなたか住んでいますか？それとも空き家ですか？",
      Hebrew: "הבנתי, תודה. מישהו גר שם כרגע, או שהנכס ריק?",
      Arabic: "فهمت، شكراً. هل يسكن أحد هناك الآن، أم أنه فارغ؟",
      Russian: "Понял, спасибо. Сейчас там кто-то живёт или дом пустует?",
      Greek: "Κατάλαβα, ευχαριστώ. Μένει κάποιος εκεί τώρα ή είναι άδειο;",
      "Indian (Hindi or Other)": "समझ गया, धन्यवाद। क्या अभी वहाँ कोई रह रहा है, या खाली है?",
    },
  },
  v3_referral_best_contact: {
    short: "ref", stage_code: "S1", stage_label: "Stage 1 Referral — Best Contact",
    fires: "Non-owner / manager / family member, no phone number in the reply (with a number: the existing referral automation captures it). Asked once; a second non-answer archives the property pairing.",
    copy: {
      English: "Thanks for letting me know. Who's the best person to talk to about the property?",
      Spanish: "Gracias por avisarme. ¿Con quién sería mejor hablar sobre la propiedad?",
      Portuguese: "Obrigado por avisar. Com quem seria melhor falar sobre o imóvel?",
      French: "Merci de me le dire. Quelle est la meilleure personne à qui parler du bien ?",
      German: "Danke für den Hinweis. Wer wäre der beste Ansprechpartner für die Immobilie?",
      Italian: "Grazie per avermelo detto. Chi è la persona giusta con cui parlare dell'immobile?",
      Polish: "Dzięki za informację. Z kim najlepiej porozmawiać o tej nieruchomości?",
      Vietnamese: "Cảm ơn anh/chị đã cho biết. Tôi nên nói chuyện với ai về căn nhà này là tốt nhất?",
      Mandarin: "谢谢告诉我。关于这处房产，最好跟谁联系？",
      Korean: "알려 주셔서 감사합니다. 이 부동산에 대해서는 누구와 이야기하는 게 가장 좋을까요?",
      Japanese: "教えていただきありがとうございます。この物件については、どなたにお話しするのが一番よいでしょうか？",
      Hebrew: "תודה שעדכנת. מי האדם הכי מתאים לדבר איתו על הנכס?",
      Arabic: "شكراً لإخباري. من هو الشخص الأنسب للتحدث معه بخصوص العقار؟",
      Russian: "Спасибо, что сказали. С кем лучше всего поговорить об этой недвижимости?",
      Greek: "Ευχαριστώ που με ενημερώσατε. Με ποιον είναι καλύτερα να μιλήσω για το ακίνητο;",
      "Indian (Hindi or Other)": "बताने के लिए धन्यवाद। इस प्रॉपर्टी के बारे में किससे बात करना सबसे अच्छा रहेगा?",
    },
  },
  v3_reask_ownership: {
    short: "rao", stage_code: "S1", stage_label: "Stage 1 Re-ask Ownership (once)",
    fires: "Unreadable / off-topic reply to the ownership question. Sent once; a second miss archives.",
    copy: {
      English: "Sorry, just want to make sure I have the right person. Are you the owner of the property?",
      Spanish: "Disculpe, solo quiero asegurarme de que hablo con la persona correcta. ¿Es usted el dueño de la propiedad?",
      Portuguese: "Desculpe, só quero ter certeza de que estou falando com a pessoa certa. Você é o proprietário do imóvel?",
      French: "Désolé, je veux juste être sûr de parler à la bonne personne. Êtes-vous le propriétaire du bien ?",
      German: "Entschuldigung, ich will nur sichergehen, dass ich die richtige Person erreiche. Sind Sie der Eigentümer der Immobilie?",
      Italian: "Mi scusi, voglio solo essere sicuro di parlare con la persona giusta. È lei il proprietario dell'immobile?",
      Polish: "Przepraszam, chcę się tylko upewnić, że piszę do właściwej osoby. Czy jest Pan właścicielem tej nieruchomości?",
      Vietnamese: "Xin lỗi, tôi chỉ muốn chắc là mình đang nói chuyện đúng người. Anh/chị có phải là chủ căn nhà không?",
      Mandarin: "不好意思，我只是想确认一下没找错人。请问您是这处房产的业主吗？",
      Korean: "죄송합니다, 제가 맞는 분께 연락드린 건지 확인하고 싶어서요. 이 부동산의 소유주이신가요?",
      Japanese: "すみません、正しい方にご連絡できているか確認させてください。この物件のオーナー様でいらっしゃいますか？",
      Hebrew: "סליחה, רק רוצה לוודא שאני מדבר עם האדם הנכון. אתה הבעלים של הנכס?",
      Arabic: "عذراً، أريد فقط التأكد أنني أتحدث مع الشخص الصحيح. هل أنت مالك العقار؟",
      Russian: "Извините, хочу убедиться, что пишу нужному человеку. Вы владелец этой недвижимости?",
      Greek: "Συγγνώμη, θέλω απλώς να βεβαιωθώ ότι μιλάω με το σωστό άτομο. Είστε ο ιδιοκτήτης του ακινήτου;",
      "Indian (Hindi or Other)": "माफ़ कीजिए, बस यह पक्का करना चाहता हूँ कि मैं सही व्यक्ति से बात कर रहा हूँ। क्या आप इस प्रॉपर्टी के मालिक हैं?",
    },
  },
  v3_reask_interest: {
    short: "rai", stage_code: "S2", stage_label: "Stage 2 Re-ask Interest (once)",
    fires: "Unreadable / off-topic reply to the proposal question. Sent once; a second miss archives.",
    copy: {
      English: "No worries. Just to check, would you be open to an offer on the property if the numbers made sense?",
      Spanish: "No se preocupe. Solo para confirmar, ¿estaría abierto a una oferta por la propiedad si los números tienen sentido?",
      Portuguese: "Sem problema. Só para confirmar, você estaria aberto a uma oferta pelo imóvel se os números fizessem sentido?",
      French: "Pas de souci. Juste pour vérifier : seriez-vous ouvert à une offre sur le bien si les chiffres tenaient la route ?",
      German: "Kein Problem. Nur zur Sicherheit: Wären Sie offen für ein Angebot für die Immobilie, wenn die Zahlen stimmen?",
      Italian: "Nessun problema. Solo per capire: sarebbe aperto a un'offerta sull'immobile se i numeri avessero senso?",
      Polish: "Nie ma sprawy. Tak tylko pytam: czy byłby Pan otwarty na ofertę za nieruchomość, jeśli liczby by się zgadzały?",
      Vietnamese: "Không sao. Cho tôi hỏi lại, nếu con số hợp lý thì anh/chị có sẵn lòng nghe một lời đề nghị cho căn nhà không?",
      Mandarin: "没关系。想确认一下，如果价格合适，您愿意考虑这处房产的报价吗？",
      Korean: "괜찮습니다. 확인차 여쭤보면, 금액이 맞는다면 이 부동산에 대한 제안을 받아 보실 의향이 있으신가요?",
      Japanese: "大丈夫です。念のため確認ですが、金額が見合えば、この物件へのオファーを検討していただけますか？",
      Hebrew: "אין בעיה. רק לבדוק, היית פתוח להצעה על הנכס אם המספרים היו הגיוניים?",
      Arabic: "لا بأس. فقط للتأكد، هل أنت منفتح على عرض للعقار إذا كانت الأرقام منطقية؟",
      Russian: "Ничего страшного. Просто уточню: вы бы рассмотрели предложение по недвижимости, если цифры будут разумными?",
      Greek: "Κανένα πρόβλημα. Απλώς να ρωτήσω, θα ήσασταν ανοιχτός σε μια προσφορά για το ακίνητο αν τα νούμερα έβγαιναν;",
      "Indian (Hindi or Other)": "कोई बात नहीं। बस पूछ रहा हूँ, अगर आंकड़े ठीक बैठें तो क्या आप प्रॉपर्टी पर किसी ऑफ़र के लिए तैयार होंगे?",
    },
  },
  v3_who_is_this_variant: {
    short: "wisv", stage_code: "S2", stage_label: "Who Is This — second answer (variant)",
    fires: "Second who/why/how-did-you-get-my-number in a thread when info_source_explanation has no row in the language. A third ask is archived.",
    copy: {
      English: "Sure. I'm Alex, a local investor. I buy a few houses around here each year and came across yours in the public records. Would you be open to a proposal?",
      Spanish: "Claro. Soy Alex, un inversionista local. Compro algunas casas por aquí cada año y vi la suya en los registros públicos. ¿Estaría abierto a una propuesta?",
      Portuguese: "Claro. Sou o Alex, investidor local. Compro algumas casas por aqui todo ano e encontrei a sua nos registros públicos. Estaria aberto a uma proposta?",
      French: "Bien sûr. Je suis Alex, un investisseur du coin. J'achète quelques maisons par ici chaque année et je suis tombé sur la vôtre dans les registres publics. Seriez-vous ouvert à une proposition ?",
      German: "Klar. Ich bin Alex, ein lokaler Investor. Ich kaufe hier jedes Jahr ein paar Häuser und bin in den öffentlichen Registern auf Ihres gestoßen. Wären Sie offen für ein Angebot?",
      Italian: "Certo. Sono Alex, un investitore della zona. Compro qualche casa qui ogni anno e ho trovato la sua nei registri pubblici. Sarebbe aperto a una proposta?",
      Polish: "Jasne. Jestem Alex, lokalny inwestor. Co roku kupuję tu kilka domów i znalazłem Pana nieruchomość w rejestrach publicznych. Czy byłby Pan otwarty na propozycję?",
      Vietnamese: "Dạ vâng. Tôi là Alex, một nhà đầu tư ở địa phương. Mỗi năm tôi mua vài căn nhà quanh đây và thấy nhà của anh/chị trong hồ sơ công khai. Anh/chị có sẵn lòng nghe một đề nghị không?",
      Mandarin: "当然。我是Alex，本地的投资人。我每年在这一带买几套房子，在公开记录里看到了您的房子。您愿意听听报价吗？",
      Korean: "네. 저는 이 지역 투자자 Alex입니다. 매년 이 근처에서 집을 몇 채씩 사는데, 공공 기록에서 이 집을 보게 됐습니다. 제안을 들어 보실 의향이 있으신가요?",
      Japanese: "はい。地元の投資家のAlexです。毎年この辺りで何軒か家を購入していて、公開記録でお宅を拝見しました。ご提案を聞いていただけますか？",
      Hebrew: "בטח. אני אלכס, משקיע מקומי. אני קונה כמה בתים באזור כל שנה ונתקלתי בנכס שלך ברשומות הציבוריות. היית פתוח להצעה?",
      Arabic: "بالتأكيد. أنا أليكس، مستثمر محلي. أشتري بعض البيوت في هذه المنطقة كل عام ووجدت بيتك في السجلات العامة. هل أنت منفتح على عرض؟",
      Russian: "Конечно. Я Алекс, местный инвестор. Каждый год покупаю здесь несколько домов и увидел ваш в открытых реестрах. Вы бы рассмотрели предложение?",
      Greek: "Βεβαίως. Είμαι ο Alex, τοπικός επενδυτής. Αγοράζω μερικά σπίτια εδώ κάθε χρόνο και βρήκα το δικό σας στα δημόσια αρχεία. Θα ήσασταν ανοιχτός σε μια πρόταση;",
      "Indian (Hindi or Other)": "ज़रूर। मैं Alex हूँ, एक स्थानीय निवेशक। मैं हर साल यहाँ कुछ घर खरीदता हूँ और सार्वजनिक रिकॉर्ड में आपकी प्रॉपर्टी देखी। क्या आप एक प्रस्ताव सुनना चाहेंगे?",
    },
  },
  v3_numbers_pending: {
    short: "nump", stage_code: "S4", stage_label: "Stage 4 Checklist Complete — Numbers Pending",
    fires: "All five checklist facts collected but no offer-ready engine number yet. No number is quoted; the thread waits for the engine.",
    copy: {
      English: "Thanks, that helps a lot. Let me run the numbers and I'll get back to you shortly.",
      Spanish: "Gracias, eso me ayuda mucho. Déjeme sacar los números y le escribo en breve.",
      Portuguese: "Obrigado, isso ajuda bastante. Vou fazer as contas e te retorno em breve.",
      French: "Merci, ça m'aide beaucoup. Je fais les calculs et je reviens vers vous rapidement.",
      German: "Danke, das hilft sehr. Ich rechne das kurz durch und melde mich bald wieder.",
      Italian: "Grazie, mi è molto utile. Faccio due conti e le riscrivo a breve.",
      Polish: "Dzięki, to bardzo pomaga. Przeliczę wszystko i wkrótce się odezwę.",
      Vietnamese: "Cảm ơn, thông tin này rất hữu ích. Để tôi tính toán và sẽ báo lại anh/chị sớm.",
      Mandarin: "谢谢，这很有帮助。我算一下，很快回复您。",
      Korean: "감사합니다, 큰 도움이 됐어요. 계산해 보고 곧 다시 연락드릴게요.",
      Japanese: "ありがとうございます、とても助かります。計算してみて、すぐにまたご連絡します。",
      Hebrew: "תודה, זה עוזר מאוד. אעשה את החישובים ואחזור אליך בקרוב.",
      Arabic: "شكراً، هذا يساعد كثيراً. سأحسب الأرقام وأعود إليك قريباً.",
      Russian: "Спасибо, это очень помогает. Посчитаю цифры и скоро вернусь к вам.",
      Greek: "Ευχαριστώ, αυτό βοηθάει πολύ. Θα κάνω τους υπολογισμούς και θα επανέλθω σύντομα.",
      "Indian (Hindi or Other)": "धन्यवाद, इससे बहुत मदद मिली। मैं हिसाब लगाकर जल्द ही आपको बताता हूँ।",
    },
  },
  v3_update_year_follow_up: {
    short: "upy", stage_code: "S4", stage_label: "Stage 4 Update-Year Follow-up (once)",
    fires: "A generic condition answer (\"good shape\", \"it's updated\") with no update years and no major repairs. Asked once.",
    copy: {
      English: "Good to hear. Roughly when were the kitchen, baths and roof last updated?",
      Spanish: "Qué bueno. ¿Más o menos cuándo se actualizaron por última vez la cocina, los baños y el techo?",
      Portuguese: "Que bom. Mais ou menos quando a cozinha, os banheiros e o telhado foram reformados pela última vez?",
      French: "Bonne nouvelle. À peu près quand la cuisine, les salles de bain et le toit ont-ils été refaits pour la dernière fois ?",
      German: "Gut zu hören. Ungefähr wann wurden Küche, Bäder und Dach zuletzt erneuert?",
      Italian: "Bene. Più o meno quando sono stati rifatti l'ultima volta cucina, bagni e tetto?",
      Polish: "Dobrze słyszeć. Mniej więcej kiedy ostatnio remontowano kuchnię, łazienki i dach?",
      Vietnamese: "Tốt quá. Khoảng khi nào bếp, phòng tắm và mái nhà được sửa mới lần gần nhất?",
      Mandarin: "那挺好。厨房、卫生间和屋顶大概是什么时候最后翻新的？",
      Korean: "다행이네요. 주방, 욕실, 지붕은 대략 언제 마지막으로 수리하셨나요?",
      Japanese: "それは良かったです。キッチン、浴室、屋根は最後にいつ頃リフォームされましたか？",
      Hebrew: "טוב לשמוע. בערך מתי שופצו לאחרונה המטבח, חדרי הרחצה והגג?",
      Arabic: "جيد. تقريباً متى تم آخر تجديد للمطبخ والحمامات والسقف؟",
      Russian: "Хорошо. Примерно когда последний раз обновляли кухню, ванные и крышу?",
      Greek: "Χαίρομαι. Περίπου πότε ανακαινίστηκαν τελευταία φορά η κουζίνα, τα μπάνια και η στέγη;",
      "Indian (Hindi or Other)": "अच्छी बात है। किचन, बाथरूम और छत आख़िरी बार लगभग कब अपडेट हुए थे?",
    },
  },
  v3_mf_per_door_anchor: {
    short: "mfpd", stage_code: "S5", stage_label: "Stage 5 Multifamily Per-Door Anchor",
    fires: "Multifamily, checklist complete, >= 3 non-outlier MF door comps (<= 3 mi, <= 18 mo, off-market preferred) and an authoritative MAO; range capped at MAO per door. Needs renderer support for {{per_door_low}}/{{per_door_high}} before it can send.",
    copy: {
      English: "Thanks. Similar buildings nearby are trading around {{per_door_low}} to {{per_door_high}} a door, so I'd likely be somewhere in that range. Would that work for you?",
      Spanish: "Gracias. Edificios parecidos por la zona se están vendiendo entre {{per_door_low}} y {{per_door_high}} por unidad, así que yo estaría más o menos en ese rango. ¿Le funcionaría?",
      Portuguese: "Obrigado. Prédios parecidos por perto estão sendo vendidos entre {{per_door_low}} e {{per_door_high}} por unidade, então eu ficaria mais ou menos nessa faixa. Funcionaria para você?",
      French: "Merci. Des immeubles similaires dans le secteur se vendent autour de {{per_door_low}} à {{per_door_high}} par logement, donc je serais probablement dans cette fourchette. Est-ce que ça vous irait ?",
      German: "Danke. Ähnliche Gebäude in der Nähe werden für etwa {{per_door_low}} bis {{per_door_high}} pro Einheit verkauft, also läge ich wohl in diesem Bereich. Würde das für Sie passen?",
      Italian: "Grazie. Edifici simili in zona si vendono tra {{per_door_low}} e {{per_door_high}} a unità, quindi sarei più o meno in quella fascia. Le andrebbe bene?",
      Polish: "Dzięki. Podobne budynki w okolicy sprzedają się za około {{per_door_low}}–{{per_door_high}} za lokal, więc byłbym mniej więcej w tym przedziale. Czy to by Panu pasowało?",
      Vietnamese: "Cảm ơn. Các tòa nhà tương tự gần đây đang bán khoảng {{per_door_low}} đến {{per_door_high}} mỗi căn hộ, nên tôi có lẽ sẽ ở trong khoảng đó. Như vậy có được không?",
      Mandarin: "谢谢。附近类似的楼每个单元大约成交在{{per_door_low}}到{{per_door_high}}，所以我的报价大概会在这个范围。您觉得可以吗？",
      Korean: "감사합니다. 근처 비슷한 건물들이 세대당 {{per_door_low}}에서 {{per_door_high}} 정도에 거래되고 있어서, 저도 그 범위 안에서 생각하고 있습니다. 괜찮으실까요?",
      Japanese: "ありがとうございます。近くの似た建物は1戸あたり{{per_door_low}}から{{per_door_high}}ほどで取引されているので、私もその範囲になると思います。いかがでしょうか？",
      Hebrew: "תודה. בניינים דומים באזור נמכרים בערך ב-{{per_door_low}} עד {{per_door_high}} ליחידה, אז כנראה שאהיה בטווח הזה. זה יכול להתאים לך?",
      Arabic: "شكراً. المباني المشابهة القريبة تُباع بحوالي {{per_door_low}} إلى {{per_door_high}} للوحدة، لذلك سأكون على الأرجح ضمن هذا النطاق. هل يناسبك ذلك؟",
      Russian: "Спасибо. Похожие дома рядом продаются примерно по {{per_door_low}}–{{per_door_high}} за квартиру, так что я, скорее всего, буду в этом диапазоне. Вам это подходит?",
      Greek: "Ευχαριστώ. Παρόμοια κτίρια κοντά πωλούνται περίπου {{per_door_low}} έως {{per_door_high}} ανά διαμέρισμα, οπότε μάλλον θα είμαι σε αυτό το εύρος. Σας ταιριάζει;",
      "Indian (Hindi or Other)": "धन्यवाद। आस-पास की मिलती-जुलती बिल्डिंगें प्रति यूनिट लगभग {{per_door_low}} से {{per_door_high}} में बिक रही हैं, तो मैं शायद इसी दायरे में रहूँगा। क्या यह आपके लिए ठीक रहेगा?",
    },
  },
});

/**
 * EXISTING use cases the machine relies on with NO row at all in a language
 * (TEMPLATE_MATRIX status "missing"), drafted here so every language has a
 * path. Same voice; English is the prod active+safe text.
 */
export const V3_MISSING_LANGUAGE_ROWS = Object.freeze({
  ask_condition_clarifier: {
    short: "accl", stage_code: "S4", stage_label: "Stage 4 Condition Clarifier",
    en: "Thanks, could you tell me a little more about the condition? Anything major like roof, HVAC, or foundation?",
    copy: {
      Portuguese: "Obrigado, pode me contar um pouco mais sobre o estado do imóvel? Algo grande como telhado, ar-condicionado ou fundação?",
      French: "Merci, pouvez-vous m'en dire un peu plus sur l'état du bien ? Quelque chose d'important comme le toit, le chauffage/clim ou les fondations ?",
      German: "Danke, können Sie mir etwas mehr zum Zustand sagen? Irgendetwas Größeres wie Dach, Heizung/Klima oder Fundament?",
      Italian: "Grazie, può dirmi qualcosa in più sulle condizioni? Qualcosa di importante come tetto, impianto di climatizzazione o fondamenta?",
      Polish: "Dzięki, może Pan powiedzieć coś więcej o stanie? Coś poważnego, jak dach, ogrzewanie/klimatyzacja albo fundamenty?",
    },
  },
  seller_frustration_apology: {
    short: "sfa", stage_code: null, stage_label: "Frustration Apology",
    en: "Sorry about that, I'll note it. Thanks for letting me know.",
    copy: {
      Portuguese: "Desculpe por isso, vou anotar. Obrigado por avisar.",
      French: "Désolé pour ça, je le note. Merci de me l'avoir dit.",
      German: "Entschuldigung, ich notiere es mir. Danke für den Hinweis.",
      Italian: "Mi scusi, me lo segno. Grazie per avermelo detto.",
      Polish: "Przepraszam, zanotuję to. Dzięki, że dał Pan znać.",
    },
  },
  not_interested: {
    short: "ni", stage_code: "SP", stage_label: "Not Interested (30-day nurture)",
    en: "Understood, I'll leave it alone. If that ever changes, want me to check back down the road?",
    copy: {
      French: "Compris, je n'insiste pas. Si ça change un jour, voulez-vous que je reprenne contact plus tard ?",
      German: "Verstanden, dann lasse ich es. Falls sich das mal ändert, soll ich mich später noch einmal melden?",
      Italian: "Capito, non insisto. Se un giorno cambiasse idea, vuole che la ricontatti più avanti?",
      Polish: "Rozumiem, nie będę naciskać. Gdyby to się kiedyś zmieniło, czy mogę odezwać się później?",
    },
  },
  already_listed: {
    short: "al", stage_code: "SP", stage_label: "Already Listed (ack then nurture)",
    en: "Understood, I won't step on your listing. If it doesn't sell, would you want a cash offer then?",
    copy: {
      Portuguese: "Entendido, não quero atrapalhar o seu anúncio. Se não vender, gostaria de uma oferta em dinheiro?",
      French: "Compris, je ne veux pas gêner votre mise en vente. Si ça ne se vend pas, seriez-vous intéressé par une offre comptant ?",
      German: "Verstanden, ich will Ihrem Inserat nicht in die Quere kommen. Falls es nicht verkauft wird, wäre dann ein Barangebot interessant?",
      Italian: "Capito, non voglio intralciare il suo annuncio. Se non si vende, le interesserebbe un'offerta in contanti?",
      Polish: "Rozumiem, nie chcę wchodzić w drogę Pana ogłoszeniu. Jeśli się nie sprzeda, czy byłaby ciekawa oferta za gotówkę?",
      Vietnamese: "Tôi hiểu, tôi sẽ không làm ảnh hưởng đến việc rao bán của anh/chị. Nếu không bán được, anh/chị có muốn nhận một lời đề nghị trả tiền mặt không?",
      Mandarin: "明白，我不会打扰您挂牌出售。如果没卖出去，您会考虑现金报价吗？",
      Korean: "알겠습니다, 매물 진행에 방해되지 않게 하겠습니다. 혹시 팔리지 않으면 현금 제안을 받아 보시겠어요?",
      Japanese: "承知しました、売り出し中のお邪魔はしません。もし売れなかった場合、現金でのオファーはいかがですか？",
      Hebrew: "הבנתי, לא אפריע למכירה שלך. אם הנכס לא יימכר, תרצה הצעה במזומן?",
      Arabic: "فهمت، لن أتدخل في عرضك للبيع. إذا لم يُبع، هل تود عرضاً نقدياً حينها؟",
      Russian: "Понял, не буду мешать вашей продаже. Если не продастся, будет интересно предложение за наличные?",
      Greek: "Κατάλαβα, δεν θα μπω στη μέση της αγγελίας σας. Αν δεν πουληθεί, θα σας ενδιέφερε μια προσφορά τοις μετρητοίς;",
      "Indian (Hindi or Other)": "समझ गया, मैं आपकी लिस्टिंग में दखल नहीं दूँगा। अगर यह नहीं बिकती, तो क्या आप कैश ऑफ़र चाहेंगे?",
    },
  },
  text_only_redirect: {
    short: "tor", stage_code: "SP", stage_label: "Text-Only Redirect",
    en: "Sorry I missed you, texting is the fastest way to reach me. Did you have an asking price in mind for the property?",
    copy: {
      Portuguese: "Desculpe não ter atendido, por mensagem é o jeito mais rápido de falar comigo. Você tem um preço em mente para o imóvel?",
      French: "Désolé de vous avoir manqué, le texto est le moyen le plus rapide de me joindre. Aviez-vous un prix en tête pour le bien ?",
      German: "Entschuldigung, dass ich Sie verpasst habe, per SMS erreichen Sie mich am schnellsten. Haben Sie einen Preis für die Immobilie im Kopf?",
      Italian: "Mi scusi se non ho risposto, per messaggio sono più rapido. Ha in mente un prezzo per l'immobile?",
      Polish: "Przepraszam, że nie odebrałem, SMS to najszybszy sposób kontaktu ze mną. Czy ma Pan na myśli jakąś cenę za nieruchomość?",
      Vietnamese: "Xin lỗi vì đã lỡ cuộc gọi, nhắn tin là cách nhanh nhất để liên lạc với tôi. Anh/chị có nghĩ đến mức giá nào cho căn nhà không?",
      Mandarin: "抱歉没接到，发短信是联系我最快的方式。您心里对这处房产有个价格吗？",
      Korean: "전화를 못 받아 죄송합니다, 문자가 저와 연락하기 가장 빠른 방법이에요. 생각하시는 희망 가격이 있으신가요?",
      Japanese: "お電話に出られずすみません、メッセージが一番早く連絡がつきます。物件の希望価格はお考えですか？",
      Hebrew: "סליחה שפספסתי, הודעות זו הדרך הכי מהירה להשיג אותי. יש לך מחיר בראש לנכס?",
      Arabic: "آسف لأنني لم أرد، الرسائل هي أسرع طريقة للتواصل معي. هل لديك سعر في ذهنك للعقار؟",
      Russian: "Извините, что пропустил звонок, сообщения — самый быстрый способ со мной связаться. У вас есть цена на примете за недвижимость?",
      Greek: "Συγγνώμη που δεν απάντησα, τα μηνύματα είναι ο πιο γρήγορος τρόπος να με βρείτε. Έχετε κάποια τιμή στο μυαλό σας για το ακίνητο;",
      "Indian (Hindi or Other)": "माफ़ कीजिए, कॉल नहीं उठा पाया, मैसेज मुझसे संपर्क का सबसे तेज़ तरीका है। क्या आपके मन में प्रॉपर्टी की कोई कीमत है?",
    },
  },
  future_nurture: {
    short: "fn", stage_code: "S2F", stage_label: "Future Nurture",
    en: "No problem at all. Is it alright if I check back down the road?",
    copy: {
      Portuguese: "Sem problema nenhum. Tudo bem se eu voltar a falar com você mais para frente?",
      French: "Aucun problème. Ça vous va si je reprends contact plus tard ?",
      German: "Kein Problem. Ist es in Ordnung, wenn ich mich später noch einmal melde?",
      Italian: "Nessun problema. Va bene se la ricontatto più avanti?",
      Polish: "Żaden problem. Czy mogę odezwać się za jakiś czas?",
      Vietnamese: "Không sao cả. Tôi liên lạc lại với anh/chị sau được không?",
      Mandarin: "完全没问题。以后我再联系您可以吗？",
      Korean: "전혀 문제없습니다. 나중에 다시 연락드려도 괜찮을까요?",
      Japanese: "まったく問題ありません。また後日ご連絡してもよろしいですか？",
      Hebrew: "אין שום בעיה. זה בסדר אם אחזור אליך בהמשך?",
      Arabic: "لا مشكلة إطلاقاً. هل يناسبك أن أتواصل معك لاحقاً؟",
      Russian: "Без проблем. Ничего, если я напишу вам попозже?",
      Greek: "Κανένα πρόβλημα. Είναι εντάξει να επικοινωνήσω ξανά αργότερα;",
      "Indian (Hindi or Other)": "कोई बात नहीं। क्या मैं कुछ समय बाद फिर से संपर्क कर सकता हूँ?",
    },
  },
});

/** EN/ES alternatives for the owner's five priority groups (copy review only; not rows). */
export const V3_COPY_ALTERNATIVES = Object.freeze({
  connected_to_property_clarifier: [
    { English: "No problem. Do you have any connection to the property, or did I get the wrong number?", Spanish: "No hay problema. ¿Tiene alguna relación con la propiedad, o me equivoqué de número?" },
    { English: "Sorry about that. Are you connected to the house at all, or should I take your number off?", Spanish: "Disculpe. ¿Tiene algo que ver con la casa, o mejor quito su número?" },
  ],
  price_reality_check: [
    { English: "Appreciate you being upfront. That's well past what the numbers support for me. If you ever want a serious cash offer, just text me.", Spanish: "Gracias por ser claro. Eso está muy por encima de lo que me dan los números. Si algún día quiere una oferta seria en efectivo, mándeme un mensaje." },
    { English: "Got it. I can't get anywhere near that, so I'll leave you be. If things change and you want a real offer, I'm a text away.", Spanish: "Entendido. No puedo acercarme a ese número, así que no le molesto más. Si cambia de idea y quiere una oferta real, aquí estoy." },
  ],
  apology_frustration: [
    { English: "My mistake, sorry about that. I've made a note. Thanks for your patience.", Spanish: "Error mío, disculpe. Ya lo anoté. Gracias por su paciencia." },
    { English: "You're right, I misread that. Sorry! I've got it noted now.", Spanish: "Tiene razón, lo leí mal. ¡Disculpe! Ya quedó anotado." },
  ],
  identity_explanation: [
    { English: "I'm Alex, a local investor. I was just reaching out about the property. Would you be open to a proposal?", Spanish: "Soy Alex, un inversionista local. Solo le escribía por la propiedad. ¿Estaría abierto a una propuesta?" },
    { English: "Fair question! I'm Alex, I buy houses locally and found yours in the county records. Any chance you'd be open to an offer?", Spanish: "¡Buena pregunta! Soy Alex, compro casas aquí y encontré la suya en los registros del condado. ¿Estaría abierto a una oferta?" },
  ],
  condition_occupancy: [
    { English: "Thanks. How's the place holding up, any big repairs? And is anyone living there now?", Spanish: "Gracias. ¿Cómo está la casa, necesita reparaciones grandes? ¿Y vive alguien ahí ahora?" },
    { English: "Appreciate it. What kind of shape is it in, and is it rented, owner-occupied or empty?", Spanish: "Se lo agradezco. ¿En qué estado está, y está rentada, la habita usted o está vacía?" },
  ],
});

/** Flat rows in sms_templates shape (inactive, not safe). */
export function proposedV3TemplateRows() {
  const code = Object.fromEntries(V3_LANGS);
  const rows = [];
  for (const [use_case, spec] of Object.entries(V3_NEW_USE_CASES)) {
    for (const [language] of V3_LANGS) {
      const body = spec.copy[language];
      if (!body) continue;
      rows.push({
        template_id: `lc-v3-${spec.short}-${code[language]}-1`,
        use_case,
        language,
        template_body: body,
        english_translation: language === "English" ? null : spec.copy.English,
        stage_code: spec.stage_code,
        stage_label: spec.stage_label,
        fires: spec.fires,
        native_review: language !== "English" && language !== "Spanish",
        kind: "new_use_case",
      });
    }
  }
  for (const [use_case, spec] of Object.entries(V3_MISSING_LANGUAGE_ROWS)) {
    for (const [language, body] of Object.entries(spec.copy)) {
      rows.push({
        template_id: `lc-v3m-${spec.short}-${code[language]}-1`,
        use_case,
        language,
        template_body: body,
        english_translation: spec.en,
        stage_code: spec.stage_code,
        stage_label: spec.stage_label,
        fires: `existing use case, no row in ${language}`,
        native_review: true,
        kind: "missing_language",
      });
    }
  }
  return rows;
}
