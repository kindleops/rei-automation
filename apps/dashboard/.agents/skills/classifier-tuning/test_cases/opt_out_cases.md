# Opt-Out Test Cases

Test cases for verifying opt-out and unsubscribe logic.

## Case: STOP
- **Input**: "STOP"
- **Expected Outcome**: Set `is_opted_out = true` on the contact.

## Case: Wrong Number
- **Input**: "Wrong number, don't text me"
- **Expected Outcome**: Set `is_wrong_number = true` and `is_opted_out = true`.

## Case: Unsubscribe
- **Input**: "Please unsubscribe"
- **Expected Outcome**: Trigger `opt_out_workflow`.
