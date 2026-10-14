/**
 * A PEM key pasted through a single-line input arrives with its line breaks turned into spaces (or as literal
 * "\n"), which OpenSSL rejects as BAD_END_LINE. Rebuild the armor with 64-column base64; anything that is not
 * PEM is returned unchanged.
 */
export function normalizePem(key: string): string {
  const m = key.replace(/\\n/g, '\n').match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/)
  if (!m) return key
  const body = m[2].replace(/\s+/g, '')
  return `-----BEGIN ${m[1]}-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${m[1]}-----\n`
}
