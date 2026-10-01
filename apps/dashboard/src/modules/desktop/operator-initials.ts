/** Two letters for the operator's avatar: from their name, else the email's local part. */
export function operatorInitials(email?: string | null, name?: string | null): string {
  const src = (name || '').trim() || (email || '').split('@')[0]
  const parts = src.split(/[\s._-]+/).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] || 'LC').slice(0, 2)
  return letters.toUpperCase()
}
