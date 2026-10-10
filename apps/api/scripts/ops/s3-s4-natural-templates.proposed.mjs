// PROPOSED sms_templates copy (owner P0 2026-10-10) — NOT LIVE, every row
// INACTIVE and safe_for_auto_reply = false until the owner approves the wording.
//
//   S3 silence  — our "do you have an asking price in mind?" got no reply:
//                 s3_no_response_fu1 (+24h) / _fu2 (+72h) / _nurture (+30d),
//                 dispatched by no-response-followup.js (kind s3_asking_price).
//   S4 natural  — the condition question AFTER we hold the seller's price
//                 (use case condition_probe, stage S4), replacing the robotic
//                 "Thanks for the details on … move-in ready" registry copy and
//                 the deactivated lc-ask-condition-clarifier-en/es-1. Separate
//                 residential and commercial sets: commercial copy never says
//                 move-in / roof / HVAC / house.
//
// No money, no pressure, no persona name hard-coded. A/B use the seller's first
// name (only when the thread has a confident PERSON name); N has no name.
//
//   node apps/api/scripts/ops/s3-s4-natural-templates.proposed.mjs --write-sql

import { writeFileSync } from "node:fs";

export const S3S4_AUTHORED_BY = "seller_flow_followups_2026_10_10";
const RESIDENTIAL = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];
const COMMERCIAL = ["self_storage", "retail", "office", "industrial", "hotel_motel", "mobile_home_park", "other_commercial"];

const SCOPES = {
  residential: { property_type_scope: "Any Residential", allowed_property_groups: RESIDENTIAL, prohibited_property_groups: null },
  commercial: { property_type_scope: "Commercial (Other)", allowed_property_groups: COMMERCIAL, prohibited_property_groups: [...RESIDENTIAL, "land"] },
};

export const S3S4_TEMPLATE_SPECS = Object.freeze({
  s3_no_response_fu1: {
    short: "s3fu1", stage_code: "S3F", stage_label: "Stage 3 No-Response Follow-Up", scope: "residential",
    fires: "24h after our S3 asking-price question (templated or typed) with no reply.",
    copy: {
      English: {
        A: "Hey {{seller_first_name}}, just checking back. Do you have an asking price in mind for the property?",
        B: "Hi {{seller_first_name}}, no rush at all. What price would you need to sell the property?",
        N: "Just checking back. Do you have an asking price in mind for the property?",
      },
      Spanish: {
        A: "Hola {{seller_first_name}}, solo para darle seguimiento. ¿Tiene un precio en mente para la propiedad?",
        B: "Hola {{seller_first_name}}, sin prisa. ¿Qué precio necesitaría para vender la propiedad?",
        N: "Solo para darle seguimiento. ¿Tiene un precio en mente para la propiedad?",
      },
    },
  },
  s3_no_response_fu2: {
    short: "s3fu2", stage_code: "S3F", stage_label: "Stage 3 No-Response Follow-Up", scope: "residential",
    fires: "72h after the S3 FU1 with no reply. Different wording from FU1.",
    copy: {
      English: {
        A: "{{seller_first_name}}, following up one more time. Even a ballpark number helps. What would you want for the property?",
        B: "Hi {{seller_first_name}}, if you share a rough price you'd sell for, I can tell you quickly if I can make it work.",
        N: "Following up one more time. Even a ballpark number helps. What would you want for the property?",
      },
      Spanish: {
        A: "{{seller_first_name}}, le escribo una vez más. Aunque sea un número aproximado me ayuda. ¿Cuánto quisiera por la propiedad?",
        B: "Hola {{seller_first_name}}, si me comparte un precio aproximado, le digo rápido si lo puedo hacer funcionar.",
        N: "Le escribo una vez más. Aunque sea un número aproximado me ayuda. ¿Cuánto quisiera por la propiedad?",
      },
    },
  },
  s3_no_response_nurture: {
    short: "s3nur", stage_code: "S3F", stage_label: "Stage 3 No-Response Nurture", scope: "residential",
    fires: "30 days after the S3 FU2. Last touch of the chain.",
    copy: {
      English: {
        A: "Hi {{seller_first_name}}, checking back in on the property. If you're still open to selling, what price would you have in mind?",
        B: "Hey {{seller_first_name}}, circling back. If the timing is better now, do you have a number in mind for the property?",
        N: "Checking back in on the property. If you're still open to selling, what price would you have in mind?",
      },
      Spanish: {
        A: "Hola {{seller_first_name}}, le escribo de nuevo sobre la propiedad. Si todavía piensa vender, ¿qué precio tendría en mente?",
        B: "Hola {{seller_first_name}}, le doy seguimiento. Si ahora es mejor momento, ¿tiene un número en mente para la propiedad?",
        N: "Le escribo de nuevo sobre la propiedad. Si todavía piensa vender, ¿qué precio tendría en mente?",
      },
    },
  },
  // S4 — only ever selected AFTER the seller's price is held (Stage 3 rule).
  condition_probe_residential: {
    use_case: "condition_probe", short: "s4-cond-res", stage_code: "S4", stage_label: "Stage 4 Condition", scope: "residential",
    fires: "Seller gave their price (S3 answered); we ask condition before any offer. Residential assets only.",
    copy: {
      English: {
        1: "Got it, thanks. What kind of shape is the property in? Any repairs it needs?",
        2: "Appreciate that. Has the place been updated, or does it need some work?",
        3: "Thanks. Is the property in good shape, or are there repairs you know about?",
      },
      Spanish: {
        1: "Entendido, gracias. ¿En qué estado está la propiedad? ¿Necesita alguna reparación?",
        2: "Gracias. ¿La propiedad está actualizada o necesita algo de trabajo?",
        3: "Gracias. ¿La propiedad está en buen estado o sabe de alguna reparación que necesite?",
      },
    },
  },
  condition_probe_commercial: {
    use_case: "condition_probe", short: "s4-cond-com", stage_code: "S4", stage_label: "Stage 4 Condition (Commercial)", scope: "commercial",
    fires: "Seller gave their price (S3 answered); commercial assets (retail, office, industrial, storage, hotel, MHP, other commercial).",
    copy: {
      English: {
        1: "Got it, thanks. How is the building holding up overall? Any deferred maintenance I should know about?",
        2: "Appreciate it. What does occupancy look like right now, and is there any major work the property needs?",
        3: "Thanks. Is the property leased up and in decent shape, or does it need some work?",
      },
      Spanish: {
        1: "Entendido, gracias. ¿Cómo está el edificio en general? ¿Hay mantenimiento pendiente que deba saber?",
        2: "Gracias. ¿Cómo está la ocupación ahora y la propiedad necesita algún trabajo importante?",
        3: "Gracias. ¿La propiedad está rentada y en buen estado, o necesita trabajo?",
      },
    },
  },
});

const LANG_CODE = { English: "en", Spanish: "es" };

/** Every proposed row (pure). */
export function proposedS3S4TemplateRows() {
  const rows = [];
  for (const [key, spec] of Object.entries(S3S4_TEMPLATE_SPECS)) {
    const use_case = spec.use_case || key;
    const scope = SCOPES[spec.scope];
    for (const [language, variants] of Object.entries(spec.copy)) {
      for (const [variant, body] of Object.entries(variants)) {
        const named = /seller_first_name/.test(body);
        rows.push({
          use_case,
          template_id: `lc-${spec.short}-${LANG_CODE[language]}-${String(variant).toLowerCase()}`,
          template_name: `${use_case} — ${language} ${variant} (${spec.stage_label})`,
          language,
          template_body: body,
          english_translation: language === "English" ? null : spec.copy.English[variant],
          stage_code: spec.stage_code,
          stage_label: spec.stage_label,
          is_active: false,
          safe_for_auto_reply: false,
          reply_mode: "auto",
          is_follow_up: use_case !== "condition_probe",
          is_first_touch: false,
          ...scope,
          minimal_fallback: !named && use_case !== "condition_probe",
          fallback_rank: named ? 1 : 9,
          quarantine_state: "active",
          metadata: {
            authored_by: S3S4_AUTHORED_BY,
            approval_status: "proposed_pending_owner_approval",
            variant: String(variant),
            fires: spec.fires,
            asset_scope: spec.scope,
          },
        });
      }
    }
  }
  return rows;
}

const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const arr = (a) => (a ? `array[${a.map(q).join(",")}]::text[]` : "null::text[]");

export function buildS3S4TemplatesSql(rows = proposedS3S4TemplateRows()) {
  const values = rows
    .map((r) =>
      `  (${[q(r.use_case), q(r.template_id), q(r.template_name), q(r.language), q(r.template_body), q(r.english_translation), q(r.stage_code), q(r.stage_label), q(r.property_type_scope), arr(r.allowed_property_groups), arr(r.prohibited_property_groups), r.is_follow_up, r.minimal_fallback, r.fallback_rank, q(r.metadata.variant), q(r.metadata.fires), q(r.metadata.asset_scope)].join(", ")})`
    )
    .join(",\n");
  return `-- PROPOSED — NOT APPLIED. REQUIRES OWNER APPROVAL OF THE WORDING.
-- ${rows.length} sms_templates rows (EN + ES), every one INACTIVE and safe_for_auto_reply = false:
--   s3_no_response_fu1 / _fu2 / _nurture   S3 asking-price question unanswered (+24h / +72h / +30d)
--   condition_probe (S4) residential x3    natural condition question after the seller's price
--   condition_probe (S4) commercial  x3    commercial wording only (never move-in / roof / HVAC)
-- Activate per row after approval:
--   update public.sms_templates set is_active = true, safe_for_auto_reply = true, updated_at = now()
--    where template_id in (...approved ids...);
-- Idempotent: inserts only template_ids that do not exist yet.

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, allowed_property_groups, prohibited_property_groups,
  stage_code, stage_label, is_first_touch, is_follow_up, minimal_fallback, fallback_rank, quarantine_state, metadata
)
select v.use_case, v.template_id, v.template_name, v.language, v.template_body,
       v.english_translation, '{}'::jsonb, false, false, 'auto',
       'neutral', v.property_type_scope, v.allowed_property_groups, v.prohibited_property_groups,
       v.stage_code, v.stage_label, false, v.is_follow_up, v.minimal_fallback, v.fallback_rank, 'active',
       jsonb_build_object(
         'authored_by', '${S3S4_AUTHORED_BY}',
         'approval_status', 'proposed_pending_owner_approval',
         'variant', v.variant,
         'fires', v.fires,
         'asset_scope', v.asset_scope
       )
from (values
${values}
) as v(use_case, template_id, template_name, language, template_body, english_translation, stage_code, stage_label,
       property_type_scope, allowed_property_groups, prohibited_property_groups, is_follow_up, minimal_fallback, fallback_rank,
       variant, fires, asset_scope)
where not exists (select 1 from public.sms_templates t where t.template_id = v.template_id);

commit;

-- POSTCHECK (read-only):
--   select use_case, language, property_type_scope, count(*) from public.sms_templates
--    where metadata->>'authored_by' = '${S3S4_AUTHORED_BY}' group by 1, 2, 3 order by 1, 2, 3;
`;
}

export function buildS3S4TemplatesRollbackSql() {
  return `-- ROLLBACK for PROPOSED_20261010120000_s3_s4_natural_templates.sql
-- Deletes ONLY the rows that migration inserted, and only while still inactive.
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where metadata->>'authored_by' = '${S3S4_AUTHORED_BY}'
   and is_active = false;
commit;
`;
}

if (process.argv.includes("--write-sql")) {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  writeFileSync(new URL("PROPOSED_20261010120000_s3_s4_natural_templates.sql", dir), buildS3S4TemplatesSql());
  writeFileSync(new URL("PROPOSED_20261010120000_s3_s4_natural_templates_rollback.sql", dir), buildS3S4TemplatesRollbackSql());
}
