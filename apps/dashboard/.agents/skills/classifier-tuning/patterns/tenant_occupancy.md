# Tenant Occupancy Patterns

Regex patterns for identifying tenant-related signals in message bodies.

## Regex Patterns

- **Keyword Match**: `body_pad LIKE '% tenant %'`
- **Occupancy Match**: `body_norm ~ '(occupied|rented|lease)'`

## False Positives
- **General Inquiry**: "I am not a tenant" (Negative match).
- **Property Management**: "Tenant portal login" (Internal system noise).
