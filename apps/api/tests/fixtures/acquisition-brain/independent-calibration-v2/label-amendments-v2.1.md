# independent_calibration_v2 → v2.1 label amendments

The frozen corpus (`gold-labels.jsonl`, hash-pinned in `immutable-content-hashes.json`) is **not modified**.
Amendments are a separate, versioned overlay (`gold-label-amendments-v2.1.jsonl`); each one names the
previous value, the amended value, the text hash it applies to, and its evidence. A consumer that wants
v2.1 applies the overlay on top of v2; v2 stays reproducible.

## ic2-adv-own-02

- **Original exchange** (frozen corpus, independent of any model prediction):
  - preceding outbound: our **ownership question** (`preceding_outbound_use_case: ownership_check`);
  - seller reply: **"Yeah that was mine years ago"**.
- **Reading:** the seller says the property we named *was* theirs in the past, so they deny owning it
  now. They say nothing about the wrong number or the wrong person: the phone reached the person we
  meant, a former owner of that property.
- **Rule** (owner decision LOCKED 2026-10-17): *"If the seller denied owning the specified property →
  property denial. If they explicitly said wrong number / wrong person → keep wrong_number."*
- **Amendment:** `expected_primary_intent` wrong_number → **property_specific_non_owner** (the
  property-scoped denial lane; a former-owner statement about this property).
- **Not done to improve a score:**
  - this example is an adversarial neighbor for the `adversarial_ownership` authority;
  - none of the three calibrated candidates (confirmation / proposal request / asking price) depends
    on it, so the gates' precision and recall are unchanged;
  - the decision comes from the exchange text alone.
- `expected_terminal_state` (terminal) and every other field are unchanged.
