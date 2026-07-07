/** Normalize catalog select field values (single or multi) for filter UI + API payloads. */
export function normalizeCatalogSelectValue(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
  }
  const single = String(value).trim()
  return single ? [single] : []
}

export function formatCatalogSelectSummary(values: string[]): string {
  if (!values.length) return ''
  if (values.length <= 2) return values.join(', ')
  return `${values.slice(0, 2).join(', ')} +${values.length - 2}`
}

export function isCatalogSelectValueActive(value: unknown): boolean {
  return normalizeCatalogSelectValue(value).length > 0
}