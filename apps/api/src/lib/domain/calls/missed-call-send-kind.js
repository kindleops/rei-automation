// Shape predicate for a missed-call auto-text queue row. Pure, dependency-free
// so the queue processor can import it without pulling the calls domain.
//
// Why the processor needs it: the dispatch "seller name guard" pauses any
// automated row without a seller_first_name, because seller templates render
// "Hi {first name}". The missed-call copy addresses nobody by name, and the
// caller is often unknown, so without this exemption every missed-call text to
// an unknown caller would sit in paused_name_missing forever. The exemption is
// for the NAME guard only — the contact window, suppression, brakes and every
// other dispatch check still apply.

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isMissedCallAutotextSend(row = {}) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const call_sid = String(metadata?.missed_call?.call_sid ?? "").trim();
  return (
    lower(row?.use_case_template) === "missed_call" &&
    lower(metadata.action_type) === "missed_call_autotext" &&
    Boolean(call_sid) &&
    // A body that still asks for a name is not the nameless missed-call copy.
    !/\{\{[^}]*\}\}/.test(String(row?.message_body ?? row?.message_text ?? ""))
  );
}

export default isMissedCallAutotextSend;
