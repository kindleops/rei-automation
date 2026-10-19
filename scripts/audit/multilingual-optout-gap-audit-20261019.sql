-- ─── multilingual-optout-gap-audit-20261019.sql ─────────────────────────────────────────────
-- READ-ONLY PRODUCTION AUDIT (P0 2026-10-19, multilingual opt-out hotfix). NOT RUN BY ITS AUTHOR:
-- no production credential was available. The owner runs it under an APPROVED, ROLE-ENFORCED
-- read-only credential (BEGIN READ ONLY alone is not the safety boundary — the role is).
--
-- Question: which historical INBOUND messages match the new detector's contact-revocation
-- families (stop / remove-from-list / don't-contact / unsubscribe / leave-me-alone /
-- stop-asking-about-the-property, in Spanish, Portuguese, Haitian Creole, French, Vietnamese,
-- Chinese, Korean, Tagalog, Arabic, Russian, Polish, Italian), have NO active suppression for
-- that phone today, and was anything SENT to that phone after the message?
--
-- The patterns are a recall-oriented SQL approximation of
-- apps/api/src/lib/domain/classification/multilingual-contact-revocation.js (POSIX ARE on a
-- lower-cased, accent-folded body). `strength` = explicit (a confident family) | possible (the
-- fail-safe family token — operator review). Every row is a CANDIDATE for a person to read; the
-- carves (channel preference, "pare de llorar", past tense, why-questions) are NOT replicated.
-- Insults are not in the patterns (they never suppress).
--
-- Load: one pass over inbound message_events since :since (default 2026-08-01), regex on the body
-- only; output capped at 500 rows. statement_timeout 60s. Run off-hours, serially (the 10-10 outage
-- rule: small prod reads only).
--
-- Columns read (all used by production code today): message_events(id, direction, message_body,
-- thread_key, from_phone_number, created_at, event_timestamp); sms_suppression_list(phone_e164,
-- phone_number, is_active); automation_suppressions(phone_e164, status, suppression_type,
-- expires_at, created_at); send_queue(to_phone_number, sent_at); information_schema.columns.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH params AS (
  SELECT timestamptz '2026-08-01 00:00:00+00' AS since
),
patterns(language, family, strength, view, pattern) AS (
  VALUES
  -- Spanish
  ('es','remove_from_list','explicit','f', '\m(quit|saqu|sac|borr|elimin|remuev|remov|retir)[a-z]*\M[^.!?;]{0,40}\m(de|del)\s+((su|tu|la|sus|tus|las|esta|esa)\s+)?(lista|listas|listado|base de datos|registros?|contactos)\M'),
  ('es','remove_from_list','explicit','f', '\m(quit|saqu|sac|borr|elimin)[a-z]*\s+([^.!?;]{0,20}\s)?(mi|este)\s+(numero|telefono|cel|celular)\M'),
  ('es','remove_from_list','explicit','f', '\m(quit|saqu|sac|borr|elimin|remuev)[a-z]*(ame|eme|enme|anme)\M\s*(por favor|porfa|ya)?\s*([.,!;]|$)'),
  ('es','unsubscribe','explicit','f',      '\m(dar(me)?|dame|deme|denme)\s+de\s+baja\M|\mdesuscrib'),
  ('es','no_contact','explicit','f',       '\m(no|nunca|ya no|ni)\s+(me|nos)\s+(vuelv[a-z]*\s+a\s+)?(escrib|contact|llam|molest|busqu|mand|envi|textee|texte|mensaje)[a-z]*\M'),
  ('es','no_contact','explicit','f',       '\mno\s+vuelv[a-z]*\s+a\s+(escribir|contactar|llamar|mandar|enviar)(me|nos)\M|\mno\s+(quiero|deseo)\s+(que\s+me|recibir|mas\s+mensajes|ser\s+contactad)|\m(no\s+mas|basta\s+de)\s+(mensajes|textos|llamadas)\M'),
  ('es','stop_sending','explicit','f',     '\m(dej|par)(a|e|en|an|ar)\s+(ya\s+)?de\s+((me|nos)\s+)?(estar\s+)?(escrib|mand|envi|text|contact|llam|molest|mensaje)[a-z]*\M'),
  ('es','leave_alone','explicit','f',      '\mdej(a|e|en|ar)(me|nos)\s+(en\s+paz|tranquil)'),
  ('es','stop_asking_property','explicit','f', '\m(dej|par)[a-z]*\s+de\s+preguntar[a-z]*\s+(por|sobre)\s+'),
  ('es','possible_opt_out','possible','f', '\m(quit|saqu|borr|elimin|remuev)[a-z]*(me|nme|nos)\M|\mbloque(ar|o|e|en)[a-z]*\M|\macoso\M'),
  -- Portuguese
  ('pt','stop_sending','explicit','f',     '\m(par|deix)(e|a|em|ar)\s+de\s+(me\s+)?(mandar|enviar|escrever|ligar|contatar|incomodar|perturbar)\M|\m(chega|basta)\s+de\s+(mensage|sms|ligac)'),
  ('pt','no_contact','explicit','f',       '\m(nao|nunca|n|nem)\s+(me\s+)?(mande|mandem|envie|enviem|escreva|escrevam|ligue|liguem|contate|contatem|procure|procurem|incomode|incomodem)\M|\mnao\s+quero\s+(mais\s+)?(receber|mensage|ser\s+contatad|que\s+me)|\mnao\s+entre(m)?\s+(mais\s+)?em\s+contato'),
  ('pt','remove_from_list','explicit','f', '\m(tir|retir|remov|exclu|apag)[a-z]*(-me)?\s+([^.!?;]{0,40}\s)?(da|do|dessa|desta|de)\s+((sua|essa)\s+)?(lista|cadastro|base de dados)\M|\m(tir|remov|apag|exclu)[a-z]*\s+(o\s+)?meu\s+(numero|telefone|contato)\M'),
  ('pt','unsubscribe','explicit','f',      '\mdescadastr|\msair\s+da\s+lista'),
  ('pt','leave_alone','explicit','f',      '\mdeix(e|a|em)(-me)?\s+em\s+paz'),
  -- French
  ('fr','stop_sending','explicit','f',     '\m(arret|cess)[a-z]*\s+(de|d'')\s*(me\s+|m''|m\s)?(ecrire|envoyer|contacter|appeler|harceler|texter|deranger|relancer)\M|\m(marre|assez)\s+de\s+(vos\s+|ces\s+)?(messages|sms|textos|appels)'),
  ('fr','no_contact','explicit','f',       '\mn(e\s+|'')(me\s+|m''|nous\s+)?(ecri|envoy|contact|appel|text|derang|relanc|recontact)[a-z]*\s+([a-z'']+\s+){0,3}plus\M|\mne\s+(plus|pas)\s+(me\s+|m'')(contacter|ecrire|appeler|recontacter|envoyer)|\mje\s+ne\s+(veux|souhaite)\s+(plus|pas)\s+(recevoir|etre\s+contact|de\s+messages)'),
  ('fr','remove_from_list','explicit','f', '\m(retir|enlev|supprim|effac|ray|sort)[a-z]*([- ]moi)?\s+([^.!?;]{0,40}\s)?(de|du|des)\s+((votre|vos|la|ta)\s+)?(liste|fichier|base)\M|\m(supprim|effac|retir|enlev)[a-z]*\s+mon\s+numero'),
  ('fr','unsubscribe','explicit','f',      '\m(desabonn|desinscri)'),
  ('fr','leave_alone','explicit','f',      '\m(laiss|fich|fout)[a-z]*[- ]moi\s+(tranquille|en\s+paix|la\s+paix)'),
  -- Haitian Creole
  ('ht','stop_sending','explicit','f',     '\m(sispann|sispan|sipann|kanpe)\s+((tanpri|souple)\s+)?(voye|ekri|rele|kontakte|deranje|tekste|mesaj)\M|^\s*(tanpri\s+)?(sispann|sispan|kanpe)\s*(tanpri)?\s*[.!]*\s*$'),
  ('ht','no_contact','explicit','f',       '\mpa\s+(janm\s+)?(voye|ekri|rele|kontakte|deranje|tekste)\M[^.!?;]{0,30}\m(anko|ban\s*m|ba\s*m|m|mwen)\M|\m(m|mwen)\s+pa\s+vle\s+(resevwa|ou\s+ekri|ou\s+rele|mesaj)'),
  ('ht','remove_from_list','explicit','f', '\m(retire|wete|efase)\s+(m|mwen|nimewo\s+(m|mwen))\s+[^.!?;]{0,20}\m(nan|sou)\s+lis\M|\m(efase|retire|wete)\s+nimewo\s+(m|mwen)\M'),
  ('ht','leave_alone','explicit','f',      '\mkite\s+(m|mwen)\s+(an\s*pe|trankil)|\mdezabone'),
  ('ht','possible_opt_out','possible','f', '\m(sispann|sispan|sipann)\M|\m(efase|retire|wete)\s+(m|mwen)\M'),
  -- Italian
  ('it','stop_sending','explicit','f',     '\msmett[a-z]*\s+di\s+(mi\s+)?(scriv|mand|invi|contatt|chiam|messagg|disturb)|\mbasta\s+(con\s+)?(i\s+|questi\s+)?(messaggi|sms|chiamate)'),
  ('it','no_contact','explicit','f',       '\mnon\s+(mi\s+|ci\s+)?(scriv|chiam|contatt|mand|cerc|disturb|messagg)[a-z]*\s+([a-z'']+\s+){0,2}(piu|mai)\M|\mnon\s+(scrivermi|chiamarmi|contattarmi|mandarmi|disturbarmi)\M|\mnon\s+voglio\s+(piu\s+)?(essere\s+contattat|ricevere)'),
  ('it','remove_from_list','explicit','f', '\m(cancell|togli|rimuov|lev|elimin)[a-z]*\s+([^.!?;]{0,40}\s)?(dalla|dal|da)\s+((vostra|tua|sua|questa)\s+)?(lista|elenco|database)\M|\m(cancell|rimuov|togli)[a-z]*\s+il\s+mio\s+numero|\mdisiscriv'),
  ('it','leave_alone','explicit','f',      '\mlasci[a-z]*\s+in\s+pace'),
  -- Polish (folded)
  ('pl','stop_sending','explicit','f',     '\m(przestan|przestac)[a-z]*\s+([a-z]+\s+){0,3}(pisac|dzwonic|wysylac|smsowac|kontaktowac)\M'),
  ('pl','no_contact','explicit','f',       '\mnie\s+(pisz|piszcie|dzwon|dzwoncie|kontaktuj|kontaktujcie|wysylaj)\M|\mnie\s+(chce|zycze\s+sobie)\s+([a-z]+\s+){0,2}(wiadomosci|sms|kontaktu)|\mprosze\s+nie\s+(pisac|dzwonic)'),
  ('pl','remove_from_list','explicit','f', '\m(usun|usuncie|usunac|wykresl|wypisz|skasuj)[a-z]*\s+(mnie|moj\s+numer|z\s+(listy|bazy))'),
  ('pl','leave_alone','explicit','f',      '\mzostaw[a-z]*\s+mnie\s+w\s+spokoju|\mdaj[a-z]*\s+mi\s+spokoj'),
  -- Tagalog
  ('tl','no_contact','explicit','f',       '\m(huwag|wag)\s+([a-z'']+\s+){0,4}(i-?text|mag-?text|text|tawag[a-z]*|i-?message|kontak[a-z]*|kulitin)\M|\mayoko\s+na\s+(ng\s+)?(text|message|tawag)'),
  ('tl','stop_sending','explicit','f',     '\m(tigil[a-z]*|itigil|tumigil)\s+([a-z]+\s+){0,4}(pag-?text|pagtetext|pag-?message|pagtawag|text)\M|^\s*(tigil|itigil)[^a-z]*$'),
  ('tl','remove_from_list','explicit','f', '\m(paki-?)?(tanggal[a-z]*|alisin|burahin|bura)\s+([a-z]+\s+){0,4}(sa\s+(listahan|list)|number\s+ko|numero\s+ko)\M'),
  ('tl','leave_alone','explicit','f',      '\m(lubayan|tantanan|pabayaan)\s+([a-z]+\s+){0,3}ako\M'),
  ('tl','possible_opt_out','possible','f', '\m(tigil[a-z]*|itigil|tanggal[a-z]*|pakitanggal|alisin|burahin|lubayan|tantanan|makulit|nangungulit)\M'),
  -- Vietnamese (with diacritics, on the lower-cased body; and the no-diacritic texting style, folded)
  ('vi','no_contact','explicit','l',       '(đừng|xin đừng|không được)\s+(nhắn|gửi|liên\s+(lạc|hệ)|gọi|làm\s+phiền|quấy)|không\s+(muốn\s+)?(nhắn|liên\s+lạc|gọi)[^.!?]{0,20}nữa|không\s+muốn\s+(nhận|bị)'),
  ('vi','stop_sending','explicit','l',     '(ngừng|dừng|thôi|ngưng)\s+(lại\s+)?(nhắn|gửi|liên\s+lạc|gọi|làm\s+phiền)'),
  ('vi','remove_from_list','explicit','l', '(xóa|xoá|gỡ|bỏ)\s+(bỏ\s+)?(số|tôi|tên\s+tôi)|khỏi\s+danh\s+sách|h[ủu]y\s+đăng\s+k|để\s+(cho\s+)?tôi\s+yên'),
  ('vi','no_contact','explicit','f',       '\m(dung|ngung)\s+(nhan|gui|lien lac|goi|lam phien)\M|\mxoa\s+(so|toi)\M|\mhuy\s+dang\s+k|\m(khong|ko)\s+(nhan|lien lac|goi)[^.!?]{0,20}\mnua\M'),
  -- Chinese (simplified + traditional)
  ('zh','no_contact','explicit','l',       '(不要|别|別|勿|請勿|请勿|請不要|请不要|停止)(再)?(给我|給我)?(发|發|传|傳|联系|聯繫|聯絡|打扰|打擾|骚扰|騷擾|烦我|煩我|打电话|打電話|打来|打來)'),
  ('zh','remove_from_list','explicit','l', '(把我|將我|将我).{0,12}(删除|刪除|删掉|刪掉|移除|去掉)|(删除|刪除|删掉|刪掉|移除)\s*我的|(退订|退訂|取消订阅|取消訂閱)'),
  ('zh','possible_opt_out','possible','l', '(停止|删除|刪除|移除|骚扰|騷擾|名单|名單)'),
  -- Korean
  ('ko','no_contact','explicit','l',       '(문자|연락|전화|메시지|메세지|카톡)\s*(을|를|는|은|좀)?\s*(그만|하지\s*마|보내지\s*마|주지\s*마)|(더\s*이상|다시는)\s*[^.!?]{0,10}(하지|보내지)\s*마|수신\s*(거부|차단)|연락\s*사절'),
  ('ko','remove_from_list','explicit','l', '(번호|연락처|명단|목록|리스트)\s*(에서|를|을)?\s*[^.!?]{0,10}(삭제|지워|빼)'),
  ('ko','possible_opt_out','possible','l', '(그만|중지|중단|삭제|지워|거부|차단|귀찮)'),
  -- Arabic (alef / ta-marbuta / ya folded in the `a` view)
  ('ar','stop_sending','explicit','a',     '(توقف|توقفوا|كف|كفوا|بطل|بطلوا)\s+(عن\s+)?(مراسل|ارسال|الارسال|الاتصال|التواصل|ازعاج|الرسايل|رسايل|ترسل)'),
  ('ar','no_contact','explicit','a',       '(^|[^[:alpha:]])(لا|ما)\s+(ترسل|تراسل|تتصل|تتواصل|تبعت|تكتب|تزعج)|عدم\s+(الاتصال|مراسلتي|الارسال|التواصل)|لا\s+(اريد|ابغي|بدي)\s+(اي\s+)?(رسايل|اتصال|تواصل)'),
  ('ar','remove_from_list','explicit','a', '(احذف|امسح|شيل|ازل)[^[:space:]]*\s*(رقمي|من\s+ال)|(احذفني|احذفوني|امسحني|شيلني|شيلوني)|الغاء\s+الاشتراك|(اتركني|اتركوني)\s+(وشاني|في\s+حالي)'),
  -- Russian
  ('ru','stop_sending','explicit','r',     '(перестаньте|перестань|прекратите|прекрати|хватит)\s+([[:alpha:]]+\s+){0,3}(писать|звонить|присылать|отправлять|слать|беспокоить|названивать|смс|сообщ)'),
  ('ru','no_contact','explicit','r',       '(^|[^[:alpha:]])(не|больше\s+не|прошу\s+не)\s+(пишите|пиши|звоните|звони|беспокойте|беспокоить|присылайте|шлите|надо\s+мне\s+писать)|не\s+хочу\s+[^.!?]{0,20}(сообщ|смс|звонк)'),
  ('ru','remove_from_list','explicit','r', '(удалите|уберите|исключите|вычеркните)\s+(меня|мой\s+номер|номер)|отпис|оставьте\s+меня\s+в\s+покое|отстаньте'),
  -- English gap closed by the hotfix: a stop on our questions about a property named by address
  ('en','stop_asking_property','explicit','f', '\m(stop|quit|cease)\s+(asking|inquiring)\s+(me\s+)?(about|regarding|on)\s+([0-9]{1,6}\s+[a-z]|(my|the|that|this)\s+(house|home|property|land|lot|place))')
),
inb AS (
  SELECT me.id AS message_event_id,
         coalesce(nullif(me.from_phone_number, ''), me.thread_key) AS phone,
         me.thread_key,
         coalesce(me.event_timestamp, me.created_at) AS received_at,
         me.message_body,
         lower(me.message_body) AS l,
         translate(lower(me.message_body),
           'áàâäãåéèêëíìîïóòôöõúùûüñçłđśćńźżąę’‘`´',
           'aaaaaaeeeeiiiiooooouuuuncldscnzzae''''''''') AS f,
         translate(lower(me.message_body), 'أإآٱىةئؤ', 'ااااياهيو') AS a,
         replace(lower(me.message_body), 'ё', 'е') AS r
  FROM public.message_events me, params p
  WHERE me.direction = 'inbound'
    AND coalesce(me.event_timestamp, me.created_at) >= p.since
    AND me.message_body IS NOT NULL
    AND length(me.message_body) BETWEEN 2 AND 1200
),
hits AS (
  SELECT i.message_event_id, i.phone, i.thread_key, i.received_at, i.message_body,
         array_agg(DISTINCT pt.language || ':' || pt.family ORDER BY pt.language || ':' || pt.family) AS families,
         CASE WHEN bool_or(pt.strength = 'explicit') THEN 'explicit' ELSE 'possible' END AS strength
  FROM inb i
  JOIN patterns pt
    ON (CASE pt.view WHEN 'f' THEN i.f WHEN 'a' THEN i.a WHEN 'r' THEN i.r ELSE i.l END) ~ pt.pattern
  GROUP BY 1, 2, 3, 4, 5
),
flagged AS (
  SELECT h.*,
         regexp_replace(h.phone, '^\+1', '') AS phone10,
         EXISTS (
           SELECT 1 FROM public.sms_suppression_list s
            WHERE (s.phone_e164 = h.phone OR s.phone_number IN (h.phone, regexp_replace(h.phone, '^\+1', '')))
              AND coalesce(s.is_active, true)
         ) AS on_suppression_list,
         EXISTS (
           SELECT 1 FROM public.automation_suppressions a
            WHERE a.phone_e164 = h.phone
              AND lower(coalesce(a.status, 'active')) = 'active'
              AND (a.expires_at IS NULL OR a.expires_at > now())
         ) AS automation_suppressed
  FROM hits h
)
SELECT f.received_at,
       f.phone,
       f.thread_key,
       f.strength,
       f.families,
       left(f.message_body, 300) AS message_body,
       sends.sent_after_count,
       sends.first_sent_after,
       sends.last_sent_after,
       ob.outbound_events_after
FROM flagged f
LEFT JOIN LATERAL (
  SELECT count(*) AS sent_after_count, min(q.sent_at) AS first_sent_after, max(q.sent_at) AS last_sent_after
    FROM public.send_queue q
   WHERE q.to_phone_number IN (f.phone, f.phone10)
     AND q.sent_at > f.received_at
) sends ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS outbound_events_after
    FROM public.message_events o
   WHERE o.thread_key = f.thread_key
     AND o.direction = 'outbound'
     AND coalesce(o.event_timestamp, o.created_at) > f.received_at
) ob ON true
WHERE NOT f.on_suppression_list
  AND NOT f.automation_suppressed
ORDER BY (sends.sent_after_count > 0 OR ob.outbound_events_after > 0) DESC, f.strength, f.received_at DESC
LIMIT 500;

-- PRE-DEPLOY CHECK for the fail-safe writer (record-precautionary-hold.js): every column it inserts
-- must exist in production (an unknown column fails the whole insert — the writer then fails closed
-- and alerts, but the hold would not be durable). Expect 9 rows, missing = 0.
SELECT c.col, (i.column_name IS NOT NULL) AS present
  FROM unnest(array['action_type','status','suppression_type','suppression_reason','dedupe_key',
                    'conversation_thread_id','phone_e164','expires_at','payload']) AS c(col)
  LEFT JOIN information_schema.columns i
    ON i.table_schema = 'public' AND i.table_name = 'automation_suppressions' AND i.column_name = c.col
 ORDER BY 2, 1;

-- How many precautionary holds exist today (context for the operator review lane).
SELECT suppression_type, status, count(*) AS n, max(created_at) AS latest
  FROM public.automation_suppressions
 WHERE suppression_type = 'precautionary_no_contact'
 GROUP BY 1, 2;

ROLLBACK;
