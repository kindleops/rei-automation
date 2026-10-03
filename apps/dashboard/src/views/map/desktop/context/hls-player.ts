/**
 * Live camera video — the lifecycle, framework-free so it can be tested.
 *
 *   startLiveVideo(video, url)  → Promise<LiveSession>
 *     Safari: native HLS (video.src). Everywhere else: hls.js, imported
 *     dynamically HERE and only here — nothing loads until an operator presses
 *     Play. The browser reads the agency's own official playlist directly
 *     (MnDOT, Caltrans; both CORS-open); LeadCommand never proxies video.
 *   session.stop()
 *     Destroys hls.js, detaches and empties the <video>, so the stream is
 *     released (no segment requests continue after a preview closes).
 *
 * Fair use (Caltrans): one stream per operator click, a short buffer, no
 * prefetch, no pre-open, no retries beyond hls.js's own fatal-error stop.
 */

export interface LiveSession { stop: () => void; engine: 'native' | 'hls.js' }

type HlsLike = {
  loadSource: (url: string) => void
  attachMedia: (el: HTMLMediaElement) => void
  on: (event: string, cb: (event: string, data: { fatal?: boolean; type?: string; details?: string }) => void) => void
  destroy: () => void
}
type HlsCtor = { new (config?: Record<string, unknown>): HlsLike; isSupported: () => boolean; Events: { ERROR: string } }
export type LoadHls = () => Promise<{ default: HlsCtor }>

/** The real loader: a dynamic import, so hls.js is its own chunk, fetched on first Play. */
export const loadHlsJs: LoadHls = () => import('hls.js') as unknown as Promise<{ default: HlsCtor }>

const NATIVE_HLS = 'application/vnd.apple.mpegurl'

function release(video: HTMLVideoElement) {
  try { video.pause() } catch { /* already stopped */ }
  video.removeAttribute('src')
  try { video.load() } catch { /* detached */ }
}

/**
 * Start one live stream in `video`. Rejects (and leaves the element empty) if
 * the browser cannot play HLS or the first play fails; `onError` fires for a
 * fatal error after playback started. Either way the caller falls back to the
 * still.
 */
export async function startLiveVideo(
  video: HTMLVideoElement,
  url: string,
  { onError, loadHls = loadHlsJs }: { onError?: (reason: string) => void; loadHls?: LoadHls } = {},
): Promise<LiveSession> {
  if (!/^https:\/\//.test(url)) throw new Error('stream_url_not_https')
  video.muted = true
  video.playsInline = true
  video.preload = 'none'
  if (video.canPlayType(NATIVE_HLS)) {
    const onFail = () => onError?.('native_playback_error')
    video.addEventListener('error', onFail)
    video.src = url
    try { await video.play() } catch (e) { video.removeEventListener('error', onFail); release(video); throw e instanceof Error ? e : new Error('play_failed') }
    let stopped = false
    return { engine: 'native', stop: () => { if (stopped) return; stopped = true; video.removeEventListener('error', onFail); release(video) } }
  }
  const { default: Hls } = await loadHls()
  if (!Hls.isSupported()) throw new Error('hls_not_supported')
  // A short buffer: we watch "now", we do not download minutes ahead.
  const hls = new Hls({ maxBufferLength: 12, maxMaxBufferLength: 20, backBufferLength: 0, lowLatencyMode: false, enableWorker: true, startFragPrefetch: false })
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try { hls.destroy() } catch { /* already gone */ }
    release(video)
  }
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data?.fatal) return
    stop()
    onError?.(data.details || data.type || 'stream_error')
  })
  hls.attachMedia(video)
  hls.loadSource(url)
  try { await video.play() } catch (e) { stop(); throw e instanceof Error ? e : new Error('play_failed') }
  return { engine: 'hls.js', stop }
}
