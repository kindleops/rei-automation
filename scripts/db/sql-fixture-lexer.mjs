// Minimal psql-script lexer for the migration-fixture linter.
//
// It understands exactly what decides whether a script can end, open or
// escape a transaction, or pull in another file:
//   - top-level statements split on `;` (outside quotes / comments / dollar
//     bodies), with their leading keywords;
//   - psql meta-commands (a backslash outside any quote or comment), which
//     psql executes client-side and which can include files or reconnect;
//   - dollar-quoted bodies (DO blocks, function bodies, nested EXECUTE text),
//     kept so their contents can be scanned too.
// It is deliberately conservative: anything it cannot classify is reported,
// never assumed safe.

/**
 * @typedef {{ kind: 'statement', text: string, line: number, bodies: string[] }} Stmt
 * @typedef {{ kind: 'meta', command: string, args: string, line: number }} Meta
 */

/**
 * Lex a psql script into top-level statements and meta-commands, in order.
 * Comments and quoted literals are removed from statement text; dollar bodies
 * are replaced with a placeholder in `text` and collected in `bodies`.
 * @param {string} src
 * @returns {Array<Stmt|Meta>}
 */
export function lexPsqlScript(src) {
  const out = []
  let i = 0
  let line = 1
  let buf = ''
  let bodies = []
  let stmtLine = 1
  let stmtStarted = false
  const n = src.length

  const startIfNeeded = () => {
    if (!stmtStarted) { stmtStarted = true; stmtLine = line }
  }
  const flush = () => {
    const text = buf.replace(/\s+/g, ' ').trim()
    if (text) out.push({ kind: 'statement', text, line: stmtLine, bodies })
    buf = ''
    bodies = []
    stmtStarted = false
  }
  const advance = (s) => { for (const ch of s) if (ch === '\n') line++ }

  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    // line comment
    if (c === '-' && next === '-') {
      const end = src.indexOf('\n', i)
      i = end === -1 ? n : end
      continue
    }
    // block comment (nestable in PostgreSQL)
    if (c === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; continue }
        if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; continue }
        j++
      }
      advance(src.slice(i, j))
      buf += ' '
      i = j
      continue
    }
    // single-quoted literal (E'' strings honour backslash escapes)
    if (c === "'") {
      startIfNeeded()
      const isE = /[eE]$/.test(buf) && !/[A-Za-z0-9_][eE]$/.test(buf)
      let j = i + 1
      while (j < n) {
        if (isE && src[j] === '\\') { j += 2; continue }
        if (src[j] === "'") {
          if (src[j + 1] === "'") { j += 2; continue }
          break
        }
        j++
      }
      advance(src.slice(i, j + 1))
      buf += "''"
      i = j + 1
      continue
    }
    // quoted identifier
    if (c === '"') {
      startIfNeeded()
      let j = i + 1
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue }
          break
        }
        j++
      }
      advance(src.slice(i, j + 1))
      buf += '"q"'
      i = j + 1
      continue
    }
    // dollar quote: $tag$ ... $tag$  (not a positional parameter like $1)
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 80))
      const prev = i > 0 ? src[i - 1] : ''
      if (m && !/[A-Za-z0-9_]/.test(prev)) {
        startIfNeeded()
        const tag = m[0]
        const bodyStart = i + tag.length
        const end = src.indexOf(tag, bodyStart)
        const bodyEnd = end === -1 ? n : end
        const body = src.slice(bodyStart, bodyEnd)
        bodies.push(body)
        advance(src.slice(i, end === -1 ? n : end + tag.length))
        buf += ' $body$ '
        i = end === -1 ? n : end + tag.length
        continue
      }
    }
    // psql meta-command: backslash outside quotes runs to end of line
    if (c === '\\') {
      const end = src.indexOf('\n', i)
      const raw = src.slice(i + 1, end === -1 ? n : end)
      const m = /^([A-Za-z!?]+|[!?])\s*(.*)$/.exec(raw)
      const command = m ? m[1] : raw.trim()
      const args = m ? m[2].trim() : ''
      // A meta-command terminates nothing by itself, but \g / \gexec / \gset
      // send the current buffer: treat those as a statement boundary.
      if (/^(g|gexec|gset|gx|gdesc)$/.test(command)) flush()
      out.push({ kind: 'meta', command, args, line })
      i = end === -1 ? n : end
      continue
    }
    if (c === ';') {
      flush()
      i++
      continue
    }
    if (c === '\n') line++
    if (!/\s/.test(c)) startIfNeeded()
    buf += c
    i++
  }
  flush()
  return out
}

/**
 * Strip comments and single-quoted literals from a PL/pgSQL (or SQL) body,
 * returning the code text plus any nested dollar bodies.
 * @param {string} body
 * @returns {{ code: string, nested: string[] }}
 */
export function stripBody(body) {
  const items = lexPsqlScript(body)
  const code = items.filter((x) => x.kind === 'statement').map((x) => x.text).join(' ; ')
  const nested = items.flatMap((x) => (x.kind === 'statement' ? x.bodies : []))
  return { code, nested }
}

/** Leading keywords of a statement, upper-cased. */
export function leadingWords(text, count = 4) {
  return text.replace(/^\(+/, '').split(/[\s(]+/).filter(Boolean).slice(0, count).map((w) => w.toUpperCase())
}
