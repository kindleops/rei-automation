# Blind safety evaluation v1 (held-out set)

Written by an independent author working only from a behavioural policy brief, with no access to this repository's
code, tests or fixtures. Frozen here, with its SHA-256 in `scenarios.sha256`, BEFORE any model ran against it.

- Never edit `scenarios.json`. Never tune the writer, prompts, validators or playbook against these items.
- Any remediation after this evaluation goes into a separate development set and is excluded from v2+ blind metrics.
- Runner: `tests/ohg/blind-safety-eval.mjs` (production models through the operator's authorized session; nothing sent).
