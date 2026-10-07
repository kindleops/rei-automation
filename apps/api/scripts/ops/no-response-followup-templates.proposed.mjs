// PROPOSED sms_templates copy for NO-RESPONSE FOLLOW-UPS (owner 2026-10-06):
//   S2 silence (our "open to a proposal / interested in selling?" got no reply)
//   OFFER silence (we sent a number — automated or typed in the Inbox — no reply)
// NOT LIVE. This file feeds
//   • supabase/migrations/PROPOSED_20261007040000_no_response_followup_templates.sql
//     (every row INACTIVE, safe_for_auto_reply = false, owner copy approval needed),
//   • the copy review section appended to tmp/conversation-v3/EN_ES_COPY_REVIEW.md,
//   • tests/critical/no-response-followup.test.mjs (every row renders).
//
// Per use case × language: alternatives A and B (with the seller's first name —
// used only when the thread has a confident PERSON name) and N (no name; the
// dispatcher falls back to it, so a row can never fail for a missing name).
// Voice: Alex, local investor; short, plain, no pressure. {{offer_price}} renders
// as "$132,000" and is ALWAYS the number we already sent (never a new one).
//
//   node apps/api/scripts/ops/no-response-followup-templates.proposed.mjs --write-sql

import { writeFileSync } from "node:fs";

export const NO_RESPONSE_AUTHORED_BY = "no_response_followup_2026_10_06";
const RESIDENTIAL = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];

export const NO_RESPONSE_TEMPLATE_SPECS = Object.freeze({
  s2_no_response_fu1: {
    short: "s2fu1", stage_code: "S2F", stage_label: "Stage 2 No-Response Follow-Up",
    fires: "24h after our S2 interest question (templated or typed) with no reply.",
    copy: {
      English: {
        A: "Hey {{seller_first_name}}, are you still interested in selling the property?",
        B: "Hey {{seller_first_name}}, just checking back. Would you be open to an offer on the property?",
        N: "Hey, are you still interested in selling the property?",
      },
      Spanish: {
        A: "Hola {{seller_first_name}}, ¿todavía le interesa vender la propiedad?",
        B: "Hola {{seller_first_name}}, solo para darle seguimiento. ¿Estaría abierto a una oferta por la propiedad?",
        N: "Hola, ¿todavía le interesa vender la propiedad?",
      },
    },
  },
  s2_no_response_fu2: {
    short: "s2fu2", stage_code: "S2F", stage_label: "Stage 2 No-Response Follow-Up",
    fires: "72h after FU1 with no reply. Different wording from FU1.",
    copy: {
      English: {
        A: "{{seller_first_name}}, following up one more time. If the price made sense, would you consider selling?",
        B: "Hi {{seller_first_name}}, I'm still interested in the property. Is selling something you'd consider?",
        N: "Following up one more time. If the price made sense, would you consider selling the property?",
      },
      Spanish: {
        A: "{{seller_first_name}}, le escribo una vez más. Si el precio tuviera sentido, ¿consideraría vender?",
        B: "Hola {{seller_first_name}}, sigo interesado en la propiedad. ¿Es algo que consideraría vender?",
        N: "Le escribo una vez más. Si el precio tuviera sentido, ¿consideraría vender la propiedad?",
      },
    },
  },
  s2_no_response_nurture: {
    short: "s2nur", stage_code: "S2F", stage_label: "Stage 2 No-Response Nurture",
    fires: "30 days after FU2 with no reply. Last touch of the chain.",
    copy: {
      English: {
        A: "Hi {{seller_first_name}}, this is {{agent_name}} again. Any chance you'd consider selling the property now?",
        B: "Hey {{seller_first_name}}, checking back in. If the timing is better now, would you be open to an offer on the property?",
        N: "Checking back in on the property. If the timing is better now, would you be open to an offer?",
      },
      Spanish: {
        A: "Hola {{seller_first_name}}, soy {{agent_name}} otra vez. ¿Consideraría vender la propiedad ahora?",
        B: "Hola {{seller_first_name}}, le escribo de nuevo. Si ahora es mejor momento, ¿estaría abierto a una oferta por la propiedad?",
        N: "Le escribo de nuevo sobre la propiedad. Si ahora es mejor momento, ¿estaría abierto a una oferta?",
      },
    },
  },
  offer_no_response_fu1: {
    short: "offu1", stage_code: "S5", stage_label: "Offer No-Response Follow-Up",
    fires: "24h after an offer we sent (automated or typed) with no reply. Quotes exactly the number we sent; never above the engine max.",
    copy: {
      English: {
        A: "Hey {{seller_first_name}}, does {{offer_price}} work for you to move forward, or did you have a different price in mind?",
        B: "Hi {{seller_first_name}}, just following up. Would {{offer_price}} work for you, or is there a number you had in mind?",
        N: "Hey, does {{offer_price}} work for you to move forward, or did you have a different price in mind?",
      },
      Spanish: {
        A: "Hola {{seller_first_name}}, ¿le funciona {{offer_price}} para seguir adelante, o tenía otro precio en mente?",
        B: "Hola {{seller_first_name}}, solo para darle seguimiento. ¿Le sirve {{offer_price}}, o hay alguna cifra que tenga en mente?",
        N: "Hola, ¿le funciona {{offer_price}} para seguir adelante, o tenía otro precio en mente?",
      },
    },
  },
  offer_no_response_fu2: {
    short: "offu2", stage_code: "S5", stage_label: "Offer No-Response Follow-Up",
    fires: "72h after the offer FU1 with no reply. Same number, different wording.",
    copy: {
      English: {
        A: "{{seller_first_name}}, checking back on my {{offer_price}} offer. Is that workable, or where would you need to be?",
        B: "Hi {{seller_first_name}}, I'm still at {{offer_price}}. Would that work, or what number would get it done for you?",
        N: "Checking back on my {{offer_price}} offer. Is that workable, or where would you need to be?",
      },
      Spanish: {
        A: "{{seller_first_name}}, le doy seguimiento a mi oferta de {{offer_price}}. ¿Le funciona, o en qué cifra tendría que estar?",
        B: "Hola {{seller_first_name}}, sigo en {{offer_price}}. ¿Le funcionaría, o qué cifra le haría cerrar el trato?",
        N: "Le doy seguimiento a mi oferta de {{offer_price}}. ¿Le funciona, o en qué cifra tendría que estar?",
      },
    },
  },
  offer_no_response_nurture: {
    short: "ofnur", stage_code: "S5", stage_label: "Offer No-Response Nurture",
    fires: "30 days after the offer FU2. NEVER re-quotes a 30-day-old number.",
    copy: {
      English: {
        A: "Hi {{seller_first_name}}, this is {{agent_name}} again. Are you still open to selling the property? Happy to take another look at the numbers.",
        B: "Hey {{seller_first_name}}, checking back on the property. If you're still thinking about selling, I'd be glad to revisit my offer.",
        N: "Checking back on the property. If you're still thinking about selling, I'd be glad to revisit my offer.",
      },
      Spanish: {
        A: "Hola {{seller_first_name}}, soy {{agent_name}} otra vez. ¿Todavía estaría abierto a vender la propiedad? Con gusto reviso los números de nuevo.",
        B: "Hola {{seller_first_name}}, le escribo sobre la propiedad. Si todavía piensa vender, con gusto reviso mi oferta.",
        N: "Le escribo de nuevo sobre la propiedad. Si todavía piensa vender, con gusto reviso mi oferta.",
      },
    },
  },
  offer_no_response_no_number: {
    short: "ofnn", stage_code: "S5", stage_label: "Offer No-Response Follow-Up (no number)",
    fires: "Offer FU1/FU2 when the sent offer had several numbers / a range / no clean amount, or the amount is above the engine max. Quotes no number.",
    copy: {
      English: {
        A: "Hey {{seller_first_name}}, does the offer work for you to move forward, or did you have a different price in mind?",
        B: "Hi {{seller_first_name}}, just following up on my offer. Would it work for you, or is there a number you had in mind?",
        N: "Hey, does the offer work for you to move forward, or did you have a different price in mind?",
      },
      Spanish: {
        A: "Hola {{seller_first_name}}, ¿le funciona la oferta para seguir adelante, o tenía otro precio en mente?",
        B: "Hola {{seller_first_name}}, solo para darle seguimiento a mi oferta. ¿Le funciona, o hay alguna cifra que tenga en mente?",
        N: "Hola, ¿le funciona la oferta para seguir adelante, o tenía otro precio en mente?",
      },
    },
  },
});

const LANG_CODE = { English: "en", Spanish: "es" };

/** Every proposed row (pure). */
export function proposedNoResponseTemplateRows() {
  const rows = [];
  for (const [use_case, spec] of Object.entries(NO_RESPONSE_TEMPLATE_SPECS)) {
    for (const [language, variants] of Object.entries(spec.copy)) {
      for (const [variant, body] of Object.entries(variants)) {
        const english = NO_RESPONSE_TEMPLATE_SPECS[use_case].copy.English[variant];
        rows.push({
          use_case,
          template_id: `lc-nr-${spec.short}-${LANG_CODE[language]}-${variant.toLowerCase()}`,
          template_name: `${use_case} — ${language} ${variant} (no-response follow-up)`,
          language,
          agent_persona: "Alex",
          template_body: body,
          english_translation: language === "English" ? null : english,
          stage_code: spec.stage_code,
          stage_label: spec.stage_label,
          is_active: false,
          safe_for_auto_reply: false,
          reply_mode: "auto",
          is_follow_up: true,
          is_first_touch: false,
          property_type_scope: "Any Residential",
          allowed_property_groups: RESIDENTIAL,
          minimal_fallback: variant === "N",
          fallback_rank: variant === "N" ? 9 : 1,
          quarantine_state: "active",
          metadata: {
            authored_by: NO_RESPONSE_AUTHORED_BY,
            approval_status: "proposed_pending_owner_approval",
            variant,
            fires: spec.fires,
            gate: "system_control.followup_no_response_mode",
          },
        });
      }
    }
  }
  return rows;
}

const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

export function buildNoResponseTemplatesSql(rows = proposedNoResponseTemplateRows()) {
  const values = rows
    .map((r) =>
      `  (${[q(r.use_case), q(r.template_id), q(r.template_name), q(r.language), q(r.template_body), q(r.english_translation), q(r.stage_code), q(r.stage_label), r.minimal_fallback, r.fallback_rank, q(r.metadata.variant), q(r.metadata.fires)].join(", ")})`
    )
    .join(",\n");
  return `-- PROPOSED — NOT APPLIED. REQUIRES OWNER APPROVAL OF THE WORDING
-- (tmp/conversation-v3/EN_ES_COPY_REVIEW.md, section "No-response follow-ups").
--
-- NO-RESPONSE FOLLOW-UPS (owner 2026-10-06): ${rows.length} sms_templates rows, EN + ES,
-- 7 use cases × 2 languages × 3 variants (A/B with the seller's first name, N without).
--   s2_no_response_fu1 / _fu2 / _nurture       S2 interest question unanswered (+24h / +72h / +30d)
--   offer_no_response_fu1 / _fu2 / _nurture    offer unanswered (+24h / +72h / +30d; nurture quotes no number)
--   offer_no_response_no_number                ambiguous or above-max offer: no number quoted
--
-- SAFE TO APPLY EARLY: every row is INACTIVE and safe_for_auto_reply = false.
-- Only no-response-followup.js names these use cases, and it runs only when
-- system_control.followup_no_response_mode = 'live'. Nothing can send from this file.
--
-- Activate per row after approval:
--   update public.sms_templates set is_active = true, safe_for_auto_reply = true, updated_at = now()
--    where template_id in (...approved ids...);
-- Idempotent: inserts only template_ids that do not exist yet.

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, allowed_property_groups, stage_code, stage_label,
  is_first_touch, is_follow_up, minimal_fallback, fallback_rank, quarantine_state, metadata
)
select v.use_case, v.template_id, v.template_name, v.language, 'Alex', v.template_body,
       v.english_translation, '{}'::jsonb, false, false, 'auto',
       'neutral', 'Any Residential', array['${RESIDENTIAL.join("','")}']::text[], v.stage_code, v.stage_label,
       false, true, v.minimal_fallback, v.fallback_rank, 'active',
       jsonb_build_object(
         'authored_by', '${NO_RESPONSE_AUTHORED_BY}',
         'approval_status', 'proposed_pending_owner_approval',
         'variant', v.variant,
         'fires', v.fires,
         'gate', 'system_control.followup_no_response_mode'
       )
from (values
${values}
) as v(use_case, template_id, template_name, language, template_body, english_translation, stage_code, stage_label, minimal_fallback, fallback_rank, variant, fires)
where not exists (select 1 from public.sms_templates t where t.template_id = v.template_id);

commit;

-- POSTCHECK (read-only):
--   select use_case, language, count(*) from public.sms_templates
--    where metadata->>'authored_by' = '${NO_RESPONSE_AUTHORED_BY}' group by 1, 2 order by 1, 2;   -- 14 groups × 3
`;
}

export function buildNoResponseTemplatesRollbackSql() {
  return `-- ROLLBACK for PROPOSED_20261007040000_no_response_followup_templates.sql
-- Deletes ONLY the rows that migration inserted, and only while still inactive.
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where metadata->>'authored_by' = '${NO_RESPONSE_AUTHORED_BY}'
   and is_active = false;
commit;
`;
}

/** Markdown section for the owner copy review. */
export function buildNoResponseCopyReviewMarkdown(rows = proposedNoResponseTemplateRows()) {
  const out = [
    "",
    "---",
    "",
    "# No-response follow-ups (S2 silence + offer silence) — added 2026-10-06 by the follow-up agent",
    "",
    "Separate from the v3 sections above. Owner rule: if a seller goes quiet after our S2 interest question or after an offer, the system follows up on its own: FU1 at +24h, FU2 at +72h after FU1 (different wording), then one 30-day nurture. Sends only 8am–9pm recipient-local, through the normal send path. Any inbound cancels the chain at once.",
    "",
    "- A/B: two wording alternatives, used when the thread has a confident person first name. N: the same message with no name (the fallback; never an LLC/entity name).",
    "- `{{offer_price}}` is always the number we already sent, e.g. `$132,000`. It is never a new number and never above the engine max. If our offer had several numbers or a range, the no-number copy is used.",
    "- Every row is PROPOSED and inactive (`supabase/migrations/PROPOSED_20261007040000_no_response_followup_templates.sql`). Gate: `system_control.followup_no_response_mode` (default disabled).",
    "",
  ];
  for (const [use_case, spec] of Object.entries(NO_RESPONSE_TEMPLATE_SPECS)) {
    out.push(`### \`${use_case}\``, "", `When it fires: ${spec.fires}`, "", "| Lang | Variant | template_id | Text |", "|---|---|---|---|");
    for (const r of rows.filter((x) => x.use_case === use_case)) {
      out.push(`| ${LANG_CODE[r.language].toUpperCase()} | ${r.metadata.variant} | \`${r.template_id}\` | ${r.template_body} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

if (process.argv.includes("--write-sql")) {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  writeFileSync(new URL("PROPOSED_20261007040000_no_response_followup_templates.sql", dir), buildNoResponseTemplatesSql());
  writeFileSync(new URL("PROPOSED_20261007040000_no_response_followup_templates_rollback.sql", dir), buildNoResponseTemplatesRollbackSql());
  console.log(`wrote ${proposedNoResponseTemplateRows().length} rows`);
}
if (process.argv.includes("--print-review")) {
  process.stdout.write(buildNoResponseCopyReviewMarkdown());
}
