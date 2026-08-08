import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import { requireCronAuth } from "@/lib/security/cron-auth.js";
import { generateCampaignRecommendations } from "@/lib/domain/recommendation/campaign-recommendation-service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const logger = child({ module: "api.internal.recommendations.campaigns" });

function clean(value) {
  return String(value ?? "").trim();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

// SHADOW ONLY (spine gap G11): computes + returns ranked campaign
// recommendations with full score breakdowns and reasons. Persistence into
// campaign_recommendations degrades gracefully while its migration is
// unapplied. Nothing here — and nothing in the service it calls — creates,
// activates, or schedules campaigns.
export async function GET(request) {
  const auth = requireCronAuth(request, logger);
  if (!auth.authorized) return auth.response;

  if (!hasSupabaseConfig()) {
    return NextResponse.json(
      { ok: false, error: "supabase_not_configured" },
      { status: 503 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const window = clean(searchParams.get("window")) || "30d";
    const persist = asBoolean(searchParams.get("persist"), true);

    const result = await generateCampaignRecommendations({
      window,
      persist,
    });

    logger.info("campaign_recommendations.route_completed", {
      window,
      persist,
      recommendations: result?.recommendations?.length ?? 0,
      persistence_reason: result?.persistence?.reason || null,
    });

    return NextResponse.json({
      ok: true,
      route: "internal/recommendations/campaigns",
      result,
    });
  } catch (error) {
    logger.error("campaign_recommendations.route_failed", {
      error: clean(error?.message) || "unknown_error",
    });

    return NextResponse.json(
      {
        ok: false,
        error: "campaign_recommendations_failed",
        message: clean(error?.message) || "unknown_error",
      },
      { status: 500 }
    );
  }
}
