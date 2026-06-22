# Acquisition Outbound Retry Contract

**Version:** 1.0.0  
**Module:** `apps/api/src/lib/domain/acquisition/outbound-retry-contract.js`  
**Max attempts:** 3

## Logical Action Identity

Each workflow outbound action has one stable identity. Attempt number does **not** change identity.

```
logical_action_id = hash(
  enrollment_id / workflow_execution_id,
  thread_key / contact_id,
  stage,
  canonical_language,
  use_case,
  touch_number,
  logical_action_sequence
)
```

Idempotency key: `{logical_action_id}:attempt:{n}`

## Failure Classification

### Class A — Transient transport/provider failure

Examples: timeout, connection reset, provider 5xx, temporary outage

| Behavior | Value |
|----------|-------|
| Retry same rendered message | Yes |
| Preserve template | Yes |
| Preserve stage/language | Yes |
| Backoff | Exponential (15s base) |
| Max attempts | 3 |
| Concurrent duplicate rows | Never |

### Class B — Rate limiting

| Behavior | Value |
|----------|-------|
| Preserve template/payload | Yes |
| Reschedule per provider backoff | Yes (60s base) |
| Max attempts | 3 |
| Consumes attempt | No (unless policy override) |

### Class C — Template/render/content failure

Examples: missing merge variable, render failure, content rejection

| Behavior | Value |
|----------|-------|
| Rotate template | Yes — same stage, language, use_case, touch |
| Exclude failed template IDs | Yes |
| Cross language | Never |
| Cross stage | Never |
| Max attempts | 3 |
| Record rejections | Yes — full audit trail |

### Class D — Terminal compliance/destination failure

Examples: TextGrid 21610, opt-out, suppression/DNC, blacklist, invalid destination

| Behavior | Value |
|----------|-------|
| Retry | 0 |
| Template rotation | 0 |
| Sender rotation bypass | 0 |
| Queue action | Terminalize |
| Suppression | Persist where appropriate |
| Workflow | Advance through terminal branch |

## Exhaustion

After 3 genuine retryable failures:

1. Mark logical action terminally failed
2. Record final reason
3. Execute workflow configured automated failure branch
4. Preserve complete attempt history
5. No infinite loops

## API

```javascript
import {
  buildLogicalActionId,
  classifyOutboundFailure,
  planOutboundRetry,
  selectRetryTemplate,
  MAX_RETRY_ATTEMPTS,
  FAILURE_CLASS,
} from '@/lib/domain/acquisition/outbound-retry-contract.js';

const plan = planOutboundRetry({
  enrollment_id: 'enr-1',
  thread_key: '+15551230001',
  stage: 'S1',
  language: 'Portuguese',
  use_case: 'ownership_check',
  attempt_number: 1,
  failure: { code: 'timeout' },
});
// → { retry: true, preserve_template: true, preserve_language: true, ... }

const rotated = selectRetryTemplate({ ...input, failed_template_ids: ['tpl-a'] }, candidates);
// → selects next enabled template in same pool
```

## Integration Points

| Consumer | Status |
|----------|--------|
| `delivery-retry-engine.js` | Existing delivery retry (pre-contract) — migrate to contract |
| `canonical-queue-writer.js` | Uses idempotency keys from logical action |
| Workflow V2 failure branches | Wire to `planOutboundRetry` exhaustion handler |

## Test Coverage

`tests/critical/acquisition-template-routing-correction.test.mjs`:

- Transient retry preserves template
- Content failure rotates within same language/stage
- No cross-language rotation
- 21610 terminal — zero retry
- Max 3 attempts enforced
- Logical action ID stable across attempts