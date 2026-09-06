/**
 * sql-comment-stripper.mjs
 *
 * Quote-aware `--` comment removal, shared by every migration contract test.
 *
 * Extracted rather than copied. An earlier scope test in this repo stripped
 * comments with /\/\*[\s\S]*?\*\//g and was silently fooled by the cron literal
 * "*\/5 * * * *", whose embedded terminator mispaired the regex and swallowed
 * real code -- every assertion in that file was then reading mangled text. One
 * shared implementation means that class of bug is fixed in one place.
 */

export function stripSqlLineComments(sql) {
  const out = [];
  let inSingle = false;
  let inDollar = false;

  for (const line of sql.split("\n")) {
    let kept = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];

      if (!inSingle && ch === "$" && next === "$") {
        inDollar = !inDollar;
        kept += "$$";
        i += 1;
        continue;
      }
      if (!inDollar && ch === "'") {
        // '' is an escaped quote inside a literal, not a terminator.
        if (inSingle && next === "'") { kept += "''"; i += 1; continue; }
        inSingle = !inSingle;
        kept += ch;
        continue;
      }
      if (!inSingle && !inDollar && ch === "-" && next === "-") break; // comment
      kept += ch;
    }
    out.push(kept);
  }
  return out.join("\n");
}

export default { stripSqlLineComments };
