// secret – the literal-secret firewall: what may leave this process as a
// credential, and the string-level redaction applied wherever provider text
// could carry one. Pure functions; no I/O, no logging, no caching.

/**
 * A stored credential is usable only as a PLAIN LITERAL. Anything that reads
 * like an indirection is refused before it is ever placed in a header or body:
 * a "$" marks an environment/template reference, a leading "!" marks a shell
 * history/command reference, and control characters mark paste accidents or
 * binary junk. Such a value must never be resolved, expanded, or executed –
 * refusing here keeps a poisoned credential store from turning subtrk into its
 * interpreter. The value is classified present-but-unusable by the caller.
 */
export function usableLiteralSecret(v: string): boolean {
  if (v === "") return false;
  if (v.startsWith("!")) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false; // control chars (incl. \n \r \t, DEL)
    if (c === 0x24) return false; // "$" anywhere – env/template indirection
  }
  return true;
}

/**
 * Replace every occurrence of each secret with "[redacted]". Secrets are
 * applied longest-first so overlapping values redact whole (a shorter secret
 * must never carve up a longer one and leak the remainder). Empty secrets are
 * skipped – split("") would shatter the text. With no (matching) secrets the
 * text is returned unchanged.
 */
export function redactSecret(text: string, secrets: string[]): string {
  const sorted = [...secrets].filter((s) => s !== "").sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of sorted) out = out.split(s).join("[redacted]");
  return out;
}
