import { describe, expect, it, vi } from 'vitest'
import { startLiveVideo, type LoadHls } from './hls-player'

const URL = 'https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8'

function fakeVideo({ native = false, playRejects = false } = {}) {
  const listeners: Record<string, Array<() => void>> = {}
  const attrs: Record<string, string> = {}
  const v = {
    muted: false, playsInline: false, preload: 'auto',
    canPlayType: vi.fn(() => (native ? 'maybe' : '')),
    play: vi.fn(() => (playRejects ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve())),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn((k: string) => { delete attrs[k] }),
    addEventListener: vi.fn((k: string, cb: () => void) => { (listeners[k] ||= []).push(cb) }),
    removeEventListener: vi.fn((k: string, cb: () => void) => { listeners[k] = (listeners[k] || []).filter((x) => x !== cb) }),
    set src(u: string) { attrs.src = u },
    get src() { return attrs.src ?? '' },
    fire: (k: string) => (listeners[k] || []).forEach((cb) => cb()),
    attrs,
  }
  return v
}

function fakeHls({ supported = true } = {}) {
  const instances: Array<{ loadSource: ReturnType<typeof vi.fn>; attachMedia: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; config: unknown; handlers: Record<string, (e: string, d: { fatal?: boolean; details?: string }) => void> }> = []
  class Hls {
    static isSupported = () => supported
    static Events = { ERROR: 'hlsError' }
    loadSource = vi.fn()
    attachMedia = vi.fn()
    destroy = vi.fn()
    handlers: Record<string, (e: string, d: { fatal?: boolean; details?: string }) => void> = {}
    on = vi.fn((ev: string, cb: (e: string, d: { fatal?: boolean; details?: string }) => void) => { this.handlers[ev] = cb })
    config: unknown
    constructor(config: unknown) { this.config = config; instances.push(this) }
  }
  const loadHls = vi.fn(async () => ({ default: Hls })) as unknown as LoadHls & ReturnType<typeof vi.fn>
  return { loadHls, instances }
}

describe('live camera video lifecycle', () => {
  it('hls.js is loaded lazily — only when a stream is started, never before', async () => {
    const { loadHls, instances } = fakeHls()
    expect(loadHls).not.toHaveBeenCalled()
    const v = fakeVideo()
    const s = await startLiveVideo(v as unknown as HTMLVideoElement, URL, { loadHls })
    expect(loadHls).toHaveBeenCalledTimes(1)
    expect(s.engine).toBe('hls.js')
    expect(instances[0].loadSource).toHaveBeenCalledWith(URL)
    expect(instances[0].attachMedia).toHaveBeenCalled()
    expect(instances[0].config).toMatchObject({ startFragPrefetch: false, backBufferLength: 0 })
    expect(v.muted).toBe(true)
  })

  it('the real loader is a dynamic import (its own chunk), not a static dependency', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new globalThis.URL('./hls-player.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/import\('hls\.js'\)/)
    expect(src).not.toMatch(/^import .* from 'hls\.js'/m)
  })

  it('Safari plays natively — hls.js is never loaded', async () => {
    const { loadHls } = fakeHls()
    const v = fakeVideo({ native: true })
    const s = await startLiveVideo(v as unknown as HTMLVideoElement, URL, { loadHls })
    expect(s.engine).toBe('native')
    expect(v.src).toBe(URL)
    expect(loadHls).not.toHaveBeenCalled()
    s.stop()
    expect(v.pause).toHaveBeenCalled()
    expect(v.removeAttribute).toHaveBeenCalledWith('src')
    expect(v.load).toHaveBeenCalled()
  })

  it('stop destroys hls.js and releases the element (idempotent)', async () => {
    const { loadHls, instances } = fakeHls()
    const v = fakeVideo()
    const s = await startLiveVideo(v as unknown as HTMLVideoElement, URL, { loadHls })
    s.stop()
    s.stop()
    expect(instances[0].destroy).toHaveBeenCalledTimes(1)
    expect(v.removeAttribute).toHaveBeenCalledWith('src')
  })

  it('a fatal stream error stops the stream and reports it (caller falls back to the still)', async () => {
    const { loadHls, instances } = fakeHls()
    const v = fakeVideo()
    const onError = vi.fn()
    await startLiveVideo(v as unknown as HTMLVideoElement, URL, { loadHls, onError })
    instances[0].handlers.hlsError('hlsError', { fatal: false, details: 'bufferStalledError' })
    expect(onError).not.toHaveBeenCalled()
    instances[0].handlers.hlsError('hlsError', { fatal: true, details: 'manifestLoadError' })
    expect(onError).toHaveBeenCalledWith('manifestLoadError')
    expect(instances[0].destroy).toHaveBeenCalledTimes(1)
  })

  it('fallback: unsupported browser, a failed play, or a non-https URL rejects with the element released', async () => {
    const unsupported = fakeHls({ supported: false })
    await expect(startLiveVideo(fakeVideo() as unknown as HTMLVideoElement, URL, { loadHls: unsupported.loadHls })).rejects.toThrow('hls_not_supported')
    const ok = fakeHls()
    const v = fakeVideo({ playRejects: true })
    await expect(startLiveVideo(v as unknown as HTMLVideoElement, URL, { loadHls: ok.loadHls })).rejects.toThrow()
    expect(ok.instances[0].destroy).toHaveBeenCalled()
    expect(v.removeAttribute).toHaveBeenCalledWith('src')
    const nv = fakeVideo({ native: true, playRejects: true })
    await expect(startLiveVideo(nv as unknown as HTMLVideoElement, URL)).rejects.toThrow()
    expect(nv.removeAttribute).toHaveBeenCalledWith('src')
    await expect(startLiveVideo(fakeVideo() as unknown as HTMLVideoElement, 'http://wzmedia.dot.ca.gov/x.m3u8', { loadHls: ok.loadHls })).rejects.toThrow('stream_url_not_https')
  })
})
