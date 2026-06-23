/**
 * Recipient deduplication for campaign target snapshots.
 * Default grain: campaign touch + canonical E.164 (owner/portfolio collapsed).
 */

function clean(value) {
  return String(value ?? '').trim()
}

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function touchNumberFromRow(row, fallback = 1) {
  const fromMeta = row?.metadata?.outreach_snapshot?.current_touch_number
    ?? row?.current_touch_number
    ?? row?.touch_number
  const parsed = Number(fromMeta)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

/**
 * Rank properties for primary selection (lower = better).
 */
export function comparePropertyPriority(a, b) {
  const scoreA = numberOrNull(a.acquisition_score) ?? -Infinity
  const scoreB = numberOrNull(b.acquisition_score) ?? -Infinity
  if (scoreB !== scoreA) return scoreB - scoreA

  const motA = numberOrNull(a.motivation_score ?? a.distress_score) ?? -Infinity
  const motB = numberOrNull(b.motivation_score ?? b.distress_score) ?? -Infinity
  if (motB !== motA) return motB - motA

  const eqA = numberOrNull(a.equity_amount) ?? -Infinity
  const eqB = numberOrNull(b.equity_amount) ?? -Infinity
  if (eqB !== eqA) return eqB - eqA

  const valA = numberOrNull(a.estimated_value) ?? -Infinity
  const valB = numberOrNull(b.estimated_value) ?? -Infinity
  if (valB !== valA) return valB - valA

  const idA = clean(a.property_id)
  const idB = clean(b.property_id)
  return idA.localeCompare(idB)
}

/**
 * Collapse property-grain graph rows to recipient-grain rows.
 * Canonical E.164 wins; one row per phone per touch.
 */
export function collapseGraphRowsToRecipients(rows = [], options = {}) {
  const touchDefault = Number(options.touch_number || options.stage_touch || 1) || 1
  const byPhoneTouch = new Map()
  const stats = {
    input_property_rows: rows.length,
    output_recipient_rows: 0,
    duplicate_phones_collapsed: 0,
    duplicate_owners_collapsed: 0,
    ambiguous_phone_ownership: 0,
  }

  for (const row of rows) {
    const phone = clean(row.canonical_e164)
    if (!phone) continue
    const touch = touchNumberFromRow(row, touchDefault)
    const key = `${phone}|${touch}`
    const ownerId = clean(row.master_owner_id)

    if (!byPhoneTouch.has(key)) {
      byPhoneTouch.set(key, {
        primary: row,
        portfolio: [row],
        owners: ownerId ? new Set([ownerId]) : new Set(),
      })
      continue
    }

    const bucket = byPhoneTouch.get(key)
    bucket.portfolio.push(row)
    if (ownerId) {
      if (bucket.owners.size && !bucket.owners.has(ownerId)) {
        stats.ambiguous_phone_ownership += 1
      }
      bucket.owners.add(ownerId)
    }
    if (comparePropertyPriority(row, bucket.primary) < 0) {
      bucket.primary = row
    }
  }

  const ownerSeen = new Map()
  const recipients = []

  for (const [key, bucket] of byPhoneTouch.entries()) {
    if (bucket.portfolio.length > 1) stats.duplicate_phones_collapsed += bucket.portfolio.length - 1

    const primary = bucket.primary
    const touch = touchNumberFromRow(primary, touchDefault)
    const ownerId = clean(primary.master_owner_id)
    const ownerKey = ownerId ? `${ownerId}|${touch}` : null

    if (ownerKey) {
      if (ownerSeen.has(ownerKey)) {
        stats.duplicate_owners_collapsed += 1
        continue
      }
      ownerSeen.set(ownerKey, key)
    }

    const portfolioIds = [...new Set(bucket.portfolio.map((r) => clean(r.property_id)).filter(Boolean))]
    recipients.push({
      ...primary,
      touch_number: touch,
      matched_property_count: portfolioIds.length,
      portfolio_property_ids: portfolioIds,
      primary_property_id: clean(primary.property_id) || portfolioIds[0] || null,
      recipient_dedup_key: key,
      owner_dedup_key: ownerKey,
      ambiguous_phone_ownership: bucket.owners.size > 1,
    })
  }

  stats.output_recipient_rows = recipients.length
  return { recipients, stats }
}