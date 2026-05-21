# Asking Price Classifier Examples

Regex patterns for identifying asking prices in message bodies.

## Regex Patterns

- **Standard Price**: `body_norm ~ '(^| )\d{6,8}( |$)'`
  - Matches: "450000", "500000"
- **Formatted Price**: `body_norm ~ '\$\d{1,3}(,\d{3})*'`
  - Matches: "$450,000", "$1,000,000"

## False Positives
- **Addresses**: "123 main st" (Matches the digits but should be excluded by context).
- **Phone Numbers**: "5551234567" (Too long for a typical residential asking price).
- **Dates**: "2024" (Too short).
