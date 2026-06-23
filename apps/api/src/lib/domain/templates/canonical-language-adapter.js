// Central language adapter — catalog-driven normalization with ISO-style codes.
// Extends legacy language_aliases; no EN/ES/RU allowlists.

import legacyLanguageAliases, {
  normalizeLanguage as legacyNormalizeLanguage,
  resolveLanguage as legacyResolveLanguage,
} from '../../sms/language_aliases.js';

const { CANONICAL_LANGUAGE_SET, CANONICAL_LANGUAGES: LEGACY_CANONICAL_LANGUAGES } =
  legacyLanguageAliases;

/** Canonical display name → primary ISO 639-1 code */
export const CANONICAL_TO_ISO = Object.freeze({
  English: 'en',
  Spanish: 'es',
  Portuguese: 'pt',
  Italian: 'it',
  French: 'fr',
  German: 'de',
  Greek: 'el',
  Hebrew: 'he',
  Mandarin: 'zh',
  Japanese: 'ja',
  Korean: 'ko',
  Russian: 'ru',
  Arabic: 'ar',
  Polish: 'pl',
  Vietnamese: 'vi',
  'Asian Indian (Hindi or Other)': 'hi',
});

/** ISO / alias → canonical display name (built from CANONICAL_TO_ISO + legacy aliases) */
const ISO_TO_CANONICAL = new Map();
for (const [canonical, iso] of Object.entries(CANONICAL_TO_ISO)) {
  ISO_TO_CANONICAL.set(iso.toLowerCase(), canonical);
  ISO_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
}

// Locale variants that preserve materially relevant distinctions
const LOCALE_VARIANTS = Object.freeze({
  'pt-br': { canonical: 'Portuguese', iso: 'pt', locale: 'pt-BR' },
  'pt-pt': { canonical: 'Portuguese', iso: 'pt', locale: 'pt-PT' },
  'zh-cn': { canonical: 'Mandarin', iso: 'zh', locale: 'zh-CN' },
  'zh-tw': { canonical: 'Mandarin', iso: 'zh', locale: 'zh-TW' },
  'zh-hans': { canonical: 'Mandarin', iso: 'zh', locale: 'zh-Hans' },
  'zh-hant': { canonical: 'Mandarin', iso: 'zh', locale: 'zh-Hant' },
  'he-il': { canonical: 'Hebrew', iso: 'he', locale: 'he-IL' },
  'ar-sa': { canonical: 'Arabic', iso: 'ar', locale: 'ar-SA' },
  'ar-ae': { canonical: 'Arabic', iso: 'ar', locale: 'ar-AE' },
});

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Register a language discovered from template catalog data.
 * New languages become available through data without code deployment.
 */
const catalogDiscoveredLanguages = new Map();

export function registerCatalogLanguage(rawValue, { template_count = 0 } = {}) {
  const raw = clean(rawValue);
  if (!raw) return null;
  const resolved = resolveCanonicalLanguage(raw);
  if (resolved.canonical) {
    const existing = catalogDiscoveredLanguages.get(resolved.canonical) || { count: 0 };
    catalogDiscoveredLanguages.set(resolved.canonical, {
      count: existing.count + template_count,
      iso: resolved.iso,
      locale: resolved.locale,
    });
    return resolved;
  }
  catalogDiscoveredLanguages.set(raw, { count: template_count, iso: null, locale: null, malformed: true });
  return resolved;
}

export function getCatalogDiscoveredLanguages() {
  return Object.fromEntries(catalogDiscoveredLanguages);
}

export function __resetCatalogLanguagesForTests() {
  catalogDiscoveredLanguages.clear();
}

/**
 * Resolve any raw language value to canonical form.
 * @returns {{ canonical: string|null, iso: string|null, locale: string|null, raw: string, malformed: boolean, unsupported: boolean }}
 */
export function resolveCanonicalLanguage(value = null) {
  const raw = clean(value);
  if (!raw) {
    return { canonical: null, iso: null, locale: null, raw: '', malformed: false, unsupported: false };
  }

  const localeKey = lower(raw).replace(/_/g, '-');
  if (LOCALE_VARIANTS[localeKey]) {
    const v = LOCALE_VARIANTS[localeKey];
    return {
      canonical: v.canonical,
      iso: v.iso,
      locale: v.locale,
      raw,
      malformed: false,
      unsupported: false,
    };
  }

  const legacy = legacyResolveLanguage(raw);
  if (legacy.unsupported) {
    return { canonical: legacy.canonical, iso: null, locale: null, raw, malformed: false, unsupported: true };
  }
  if (legacy.canonical) {
    const iso = CANONICAL_TO_ISO[legacy.canonical] || null;
    return { canonical: legacy.canonical, iso, locale: null, raw, malformed: false, unsupported: false };
  }

  // Title-case pass-through for catalog values already in canonical form
  if (CANONICAL_LANGUAGE_SET.has(raw)) {
    return {
      canonical: raw,
      iso: CANONICAL_TO_ISO[raw] || null,
      locale: null,
      raw,
      malformed: false,
      unsupported: false,
    };
  }

  // ISO code direct lookup
  const isoCanonical = ISO_TO_CANONICAL.get(localeKey);
  if (isoCanonical) {
    return {
      canonical: isoCanonical,
      iso: CANONICAL_TO_ISO[isoCanonical] || localeKey,
      locale: null,
      raw,
      malformed: false,
      unsupported: false,
    };
  }

  return { canonical: null, iso: null, locale: null, raw, malformed: true, unsupported: false };
}

/** @deprecated Use resolveCanonicalLanguage — kept for backward compatibility */
export function normalizeCanonicalLanguage(value = null) {
  return resolveCanonicalLanguage(value).canonical;
}

export function canonicalLanguageMatches(templateLanguage, requestedLanguage) {
  const a = resolveCanonicalLanguage(templateLanguage);
  const b = resolveCanonicalLanguage(requestedLanguage);
  if (!a.canonical || !b.canonical) return false;
  if (a.canonical !== b.canonical) return false;
  // Prefer exact locale match when both specify locale
  if (a.locale && b.locale && a.locale !== b.locale) return false;
  return true;
}

export function isLanguageSupportedInCatalog(language, catalogLanguages = null) {
  const resolved = resolveCanonicalLanguage(language);
  if (!resolved.canonical || resolved.malformed || resolved.unsupported) return false;
  if (!catalogLanguages) return true;
  const set = catalogLanguages instanceof Set ? catalogLanguages : new Set(catalogLanguages);
  return set.has(resolved.canonical);
}

export function buildLanguageInventoryFromTemplates(templates = []) {
  const inventory = new Map();
  for (const row of templates) {
    const raw = clean(row.language);
    const resolved = resolveCanonicalLanguage(raw);
    const key = resolved.canonical || `__malformed:${raw}`;
    const entry = inventory.get(key) || {
      raw_values: new Set(),
      canonical: resolved.canonical,
      iso: resolved.iso,
      locale: resolved.locale,
      template_count: 0,
      enabled_count: 0,
      disabled_count: 0,
      retired_count: 0,
      draft_count: 0,
      malformed_count: 0,
      stages: new Set(),
      use_cases: new Set(),
      touches: new Set(),
    };
    entry.raw_values.add(raw);
    entry.template_count += 1;
    if (resolved.malformed) entry.malformed_count += 1;
    if (row.lifecycle_status === 'retired' || row.metadata?.retired) entry.retired_count += 1;
    else if (row.is_active === false) entry.disabled_count += 1;
    else if (row.lifecycle_status === 'draft') entry.draft_count += 1;
    else if (row.is_active === true) entry.enabled_count += 1;
    if (row.stage_code) entry.stages.add(row.stage_code);
    if (row.use_case) entry.use_cases.add(row.use_case);
    if (row.touch_number) entry.touches.add(String(row.touch_number));
    inventory.set(key, entry);
    if (resolved.canonical) registerCatalogLanguage(raw);
  }
  return [...inventory.values()].map((e) => ({
    raw_language_values: [...e.raw_values],
    canonical: e.canonical,
    iso: e.iso,
    locale: e.locale,
    template_count: e.template_count,
    enabled_count: e.enabled_count,
    disabled_count: e.disabled_count,
    retired_count: e.retired_count,
    draft_count: e.draft_count,
    malformed_count: e.malformed_count,
    stage_coverage: [...e.stages].sort(),
    use_case_coverage: [...e.use_cases].sort(),
    touch_coverage: [...e.touches].sort(),
  }));
}

export const CANONICAL_LANGUAGES = LEGACY_CANONICAL_LANGUAGES;

export default {
  CANONICAL_LANGUAGES,
  CANONICAL_TO_ISO,
  resolveCanonicalLanguage,
  normalizeCanonicalLanguage,
  canonicalLanguageMatches,
  isLanguageSupportedInCatalog,
  registerCatalogLanguage,
  getCatalogDiscoveredLanguages,
  buildLanguageInventoryFromTemplates,
  __resetCatalogLanguagesForTests,
};