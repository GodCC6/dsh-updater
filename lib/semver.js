const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parse(v) {
  const m = RE.exec(String(v).trim())
  if (!m) return null
  return {
    major: +m[1], minor: +m[2], patch: +m[3],
    pre: m[4] ? m[4].split('.') : null,
  }
}

function cmpPre(a, b) {
  if (!a && !b) return 0
  if (!a) return 1   // release > prerelease
  if (!b) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { const d = +x - +y; if (d) return Math.sign(d) }
    else if (xn !== yn) { return xn ? -1 : 1 } // 数字段 < 字符串段
    else if (x !== y) { return x < y ? -1 : 1 }
  }
  return 0
}

export function compareVersions(a, b) {
  const pa = parse(a), pb = parse(b)
  if (!pa || !pb) throw new Error(`unparseable version: ${!pa ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return Math.sign(pa[k] - pb[k])
  }
  return cmpPre(pa.pre, pb.pre)
}

export function isNewer(candidate, current) {
  try { return compareVersions(candidate, current) > 0 } catch { return false }
}
