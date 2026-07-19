# Statistical sample-size requirements (authority qualification)

Authority qualification for a **narrow candidate × language** requires simultaneous satisfaction of:

| Metric | Point estimate | One-sided 95% lower bound |
|---|---|---|
| Precision | ≥ 0.99 | ≥ 0.99 |
| Recall | ≥ 0.95 | ≥ 0.95 |
| Terminal / authority-sensitive unsafe confusions | 0 | n/a |

## Independence unit

The independent unit is a **true semantic family**, not a surface paraphrase.

Development pack v3 must **not** be used to claim these bounds.

## Minimum independent support (planning targets)

### Precision lower bound ≥ 0.99 (one-sided 95%)

Using Clopper–Pearson style intuition: with **zero false positives**, the number of independent predicted-positive families \(n_{pp}\) must satisfy roughly:

\[
(1-\alpha)^{1/n_{pp}} \le 0.01 \Rightarrow n_{pp} \gtrsim \frac{\ln(0.05)}{\ln(0.99)} \approx 299
\]

**Planning target:** ≥ **300 independent predicted-positive opportunities** per candidate × language (family-clustered).

### Recall lower bound ≥ 0.95 (one-sided 95%)

With zero false negatives among gold positives, gold-positive independent families \(n_{+}\) need roughly:

\[
n_{+} \gtrsim \frac{\ln(0.05)}{\ln(0.95)} \approx 59
\]

**Planning target:** ≥ **60 gold-positive independent families** per candidate × language, preferably more with realistic FN risk; product practice also pairs with substantial adversarial negatives (≥ gold-positive count recommended).

### Unsafe confusions

Sample size does not relax the **zero** unsafe terminal / ownership-role confusions requirement.

## What does **not** qualify

- 50 permutations of one construction
- Repeated paraphrases counted as independent families
- One surface string per synthetic “family” with no shared construction grouping
- Development / adversarial packs (including this pack)
- Labels from a single agent that edited the classifier

## Development pack v3 status

For every candidate × language in the preserved pack:

**`insufficient_independent_support`** for authority confidence.

See `statistical-support-assessment.json`.
