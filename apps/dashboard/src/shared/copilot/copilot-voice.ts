/**
 * NEXUS Copilot — Voice Mode Hook
 *
 * Real Web Speech API integration with:
 * - Microphone permission handling
 * - Push-to-talk support
 * - Real-time interim transcription
 * - Final transcript delivery
 * - Animated amplitude for orb visualization
 */

import { useState, useRef, useCallback, useEffect } from 'react'

export interface VoiceState {
  supported: boolean
  listening: boolean
  transcript: string
  interimTranscript: string
  amplitude: number      // 0–1 for orb visualization
  error: string | null
  permissionDenied: boolean
}

interface VoiceCallbacks {
  onTranscript?: (text: string) => void
  onInterim?: (text: string) => void
  onStart?: () => void
  onEnd?: () => void
  onError?: (error: string) => void
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as Record<string, unknown>).SpeechRecognition as (new () => SpeechRecognitionLike) | null
    ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition as (new () => SpeechRecognitionLike) | null
    ?? null
}

export function useVoiceMode(callbacks?: VoiceCallbacks) {
  const [state, setState] = useState<VoiceState>({
    supported: false,
    listening: false,
    transcript: '',
    interimTranscript: '',
    amplitude: 0,
    error: null,
    permissionDenied: false,
  })

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)

  // Check support on mount
  useEffect(() => {
    const SR = getSpeechRecognition()
    setState(s => ({ ...s, supported: SR != null }))
    return () => {
      stopAmplitude()
      recognitionRef.current?.abort()
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // Amplitude tracking via AnalyserNode
  const startAmplitude = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const ctx = new AudioContext()
      audioContextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser
      const data = new Uint8Array(analyser.frequencyBinCount)

      const tick = () => {
        analyser.getByteFrequencyData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i]
        const avg = sum / data.length / 255
        setState(s => ({ ...s, amplitude: avg }))
        animFrameRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // Amplitude tracking is optional — voice recognition still works
    }
  }, [])

  const stopAmplitude = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    audioContextRef.current?.close()
    audioContextRef.current = null
    analyserRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setState(s => ({ ...s, amplitude: 0 }))
  }, [])

  const startListening = useCallback(() => {
    const SR = getSpeechRecognition()
    if (!SR) {
      setState(s => ({ ...s, error: 'Speech recognition not supported' }))
      callbacks?.onError?.('Speech recognition not supported')
      return
    }

    const recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognitionRef.current = recognition

    let finalTranscript = ''

    recognition.onstart = () => {
      setState(s => ({ ...s, listening: true, error: null, permissionDenied: false }))
      callbacks?.onStart?.()
    }

    recognition.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalTranscript += result[0].transcript + ' '
          callbacks?.onTranscript?.(result[0].transcript.trim())
        } else {
          interim += result[0].transcript
        }
      }
      setState(s => ({
        ...s,
        transcript: finalTranscript.trim(),
        interimTranscript: interim,
      }))
      if (interim) callbacks?.onInterim?.(interim)
    }

    recognition.onerror = (event) => {
      const msg = event.error === 'not-allowed'
        ? 'Microphone access denied'
        : `Voice error: ${event.error}`
      setState(s => ({
        ...s,
        listening: false,
        error: msg,
        permissionDenied: event.error === 'not-allowed',
      }))
      callbacks?.onError?.(msg)
      stopAmplitude()
    }

    recognition.onend = () => {
      setState(s => ({ ...s, listening: false, interimTranscript: '' }))
      callbacks?.onEnd?.()
      stopAmplitude()
    }

    recognition.start()
    startAmplitude()
  }, [callbacks, startAmplitude, stopAmplitude])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    stopAmplitude()
  }, [stopAmplitude])

  const cancelListening = useCallback(() => {
    recognitionRef.current?.abort()
    stopAmplitude()
    setState(s => ({ ...s, listening: false, interimTranscript: '', error: null }))
  }, [stopAmplitude])

  const toggleListening = useCallback(() => {
    if (state.listening) {
      stopListening()
    } else {
      startListening()
    }
  }, [state.listening, startListening, stopListening])

  const clearTranscript = useCallback(() => {
    setState(s => ({ ...s, transcript: '', interimTranscript: '' }))
  }, [])

  const retryListening = useCallback(() => {
    setState(s => ({ ...s, error: null, permissionDenied: false }))
    startListening()
  }, [startListening])

  return {
    ...state,
    startListening,
    stopListening,
    cancelListening,
    toggleListening,
    clearTranscript,
    retryListening,
  }
}
