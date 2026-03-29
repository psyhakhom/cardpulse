const ALLOWED_HOSTS = [
  'optcgapi.com',
  'en.onepiece-cardgame.com',
  'www.dbs-cardgame.com',
  'www.gundam-gcg.com',
  'deckplanet.com',
]

export default async function handler(req, res) {
  const raw = req.query.url
  if (!raw) {
    return res.status(400).send('Missing url parameter')
  }

  let imageUrl
  try {
    imageUrl = decodeURIComponent(raw)
    const parsed = new URL(imageUrl)
    if (!ALLOWED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return res.status(403).send('Forbidden: domain not allowed')
    }
  } catch {
    return res.status(400).send('Invalid URL')
  }

  try {
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': 'CardPulse/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      return res.status(response.status).send('Upstream error')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.status(200).send(buffer)
  } catch (err) {
    return res.status(502).send('Fetch failed: ' + err.message)
  }
}
