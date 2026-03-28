const ALLOWED_HOSTS = [
  'optcgapi.com',
  'en.onepiece-cardgame.com',
  'www.dbs-cardgame.com',
  'www.gundam-gcg.com',
]

export default async function handler(request) {
  const raw = new URL(request.url, 'http://localhost').searchParams.get('url')
  if (!raw) {
    return new Response('Missing url parameter', { status: 400 })
  }

  let imageUrl
  try {
    imageUrl = decodeURIComponent(raw)
    const parsed = new URL(imageUrl)
    if (!ALLOWED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return new Response('Forbidden: domain not allowed', { status: 403 })
    }
  } catch {
    return new Response('Invalid URL', { status: 400 })
  }

  try {
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': 'CardPulse/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      return new Response('Upstream error', { status: response.status })
    }
    const buffer = await response.arrayBuffer()
    return new Response(buffer, {
      headers: {
        'Content-Type': response.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err) {
    return new Response('Fetch failed: ' + err.message, { status: 502 })
  }
}
