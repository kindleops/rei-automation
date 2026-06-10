import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueueProcessorHealth, ThreadMessage } from '../../../lib/data/inboxData'
import type { InboxActivityEvent } from '../../../lib/data/inboxActivityData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { InboxSavedFilterPreset, InboxViewSelectValue } from '../inbox-ui-helpers'
import type { CommandSuggestion } from '../ai-command-center'
import { emitNotification } from '../../../shared/NotificationToast'
import { formatRelativeTime } from '../../../shared/formatters'
import { Icon } from '../../../shared/icons'
import { InboxCommandMap } from '../../../views/map/InboxCommandMap'
import { InboxSidebar } from './InboxSidebar'
import { InboxConversationTable, type ConversationTableSort } from './InboxConversationTable'
import type { InboxMapActivityMode, MapFilterState, MapOverlayToggles } from '../../../views/map/InboxCommandMap'
import { COMMAND_MAP_THEME_OPTIONS, type MapStyleMode } from '../commandMapThemes'
import { updateSetting, applyThemeToDOM } from '../../../shared/settings'
import { MAP_THEME_TO_NEXUS_GLOBAL } from '../../theme/nexusThemes'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type CommandViewMode = 'split' | 'list' | 'dossier' | 'command'
type CommandStatus = 'ready' | 'listening' | 'thinking' | 'analyzing' | 'cooking'
type CommandRail = 'inbox' | 'list'

type SpeechRecognitionResultLike = {
  0: { transcript: string }
}

type SpeechRecognitionEventLike = {
  results: {
    length: number
    [index: number]: SpeechRecognitionResultLike
  }
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

const getSpeechRecognition = (): SpeechRecognitionConstructor | null => {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null
}

const text = (value: unknown) => String(value ?? '').trim()
const lower = (value: unknown) => text(value).toLowerCase()

export function CommandView({
  threads,
  visibleThreads,
  selectedThread,
  selectedSuppressed,
  selectedMessages,
  messagesLoading,
  searchQuery,
  tableSort,
  tableDensity,
  listStatCounts,
  activityFeed,
  queueProcessorHealth,
  viewFilter,
  savedPreset,
  viewCounts,
  recentlyUpdatedThreadIds,
  visibleThreadCount,
  canLoadMore,
  liveFetchError,
  draftText,
  isSending,
  commandSuggestions,
  onSelectThreadId,
  onClearSelection,
  onExitCommandView,
  onSwitchViewMode,
  onSearchQueryChange,
  onApplySavedPreset,
  onSetViewFilter,
  onThreadAction,
  onLoadMore,
  onSetTableSort,
  onSetTableDensity,
  onSetDraftText,
  onSend,
  onOpenAi,
}: {
  threads: InboxWorkflowThread[]
  visibleThreads: InboxWorkflowThread[]
  selectedThread: InboxWorkflowThread | null
  selectedSuppressed: boolean
  selectedMessages: ThreadMessage[]
  messagesLoading: boolean
  searchQuery: string
  tableSort: ConversationTableSort
  tableDensity: 'comfortable' | 'compact' | 'ultra_compact'
  listStatCounts: Array<{ label: string; value: number | string | null | undefined }>
  activityFeed: InboxActivityEvent[]
  queueProcessorHealth: QueueProcessorHealth | null
  viewFilter: InboxViewSelectValue
  savedPreset: InboxSavedFilterPreset
  viewCounts: any
  recentlyUpdatedThreadIds: Set<string>
  visibleThreadCount: number
  canLoadMore: boolean
  liveFetchError?: string | null
  draftText: string
  isSending: boolean
  commandSuggestions: CommandSuggestion[]
  onSelectThreadId: (threadId: string) => void
  onClearSelection: () => void
  onExitCommandView: () => void
  onSwitchViewMode: (mode: CommandViewMode) => void
  onSearchQueryChange: (value: string) => void
  onApplySavedPreset: (preset: InboxSavedFilterPreset) => void
  onSetViewFilter: (view: InboxViewSelectValue) => void
  onThreadAction: (target: string | InboxWorkflowThread, action: string) => Promise<void>
  onLoadMore: () => Promise<void>
  onSetTableSort: (sort: ConversationTableSort) => void
  onSetTableDensity: (density: 'comfortable' | 'compact' | 'ultra_compact') => void
  onSetDraftText: (text: string | ((prev: string) => string)) => void
  onSend: (text: string) => Promise<void> | void
  onOpenAi: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bottomStripVisible, setBottomStripVisible] = useState(true)
  const [visibleRails, setVisibleRails] = useState<CommandRail[]>([])
  const [commandInput, setCommandInput] = useState('')
  const [commandStatus, setCommandStatus] = useState<CommandStatus>('ready')
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [mapActivityMode, setMapActivityMode] = useState<InboxMapActivityMode>('threads')
  const [mapTheme, setMapTheme] = useState<MapStyleMode>('dark_ops')
  const [mapFilters, setMapFilters] = useState<Partial<MapFilterState>>({})
  const [mapOverlays, setMapOverlays] = useState<Partial<MapOverlayToggles>>({})

  const handleMapThemeChange = (themeId: MapStyleMode) => {
    setMapTheme(themeId)
    const nexusTheme = MAP_THEME_TO_NEXUS_GLOBAL[themeId]
    if (nexusTheme) {
      updateSetting('nexusTheme', nexusTheme)
      applyThemeToDOM()
    }
  }
  const threadCardRef = useRef<HTMLElement | null>(null)

  const tickerItems = useMemo(() => {
    const items = activityFeed.slice(0, 14).map((item) => {
      const related = threads.find((thread) => (thread.threadKey || thread.id) === item.thread_key)
      return {
        id: item.id,
        label: item.title,
        detail: related?.ownerName || related?.propertyAddress || item.description,
        timestamp: formatRelativeTime(item.created_at),
        threadId: related?.id ?? null,
      }
    })
    if (queueProcessorHealth?.status === 'critical' || queueProcessorHealth?.status === 'warning') {
      items.unshift({
        id: 'queue-health',
        label: queueProcessorHealth.status === 'critical' ? 'Routing blocked' : 'Queue warning',
        detail: queueProcessorHealth.summary,
        timestamp: formatRelativeTime(queueProcessorHealth.checkedAt),
        threadId: null,
      })
    }
    return items
  }, [activityFeed, queueProcessorHealth, threads])

  const commandHints = useMemo(() => (
    commandSuggestions.slice(0, 3).map((item) => item.label)
  ), [commandSuggestions])

  const toggleRail = (rail: CommandRail) => {
    setVisibleRails((current) => current.includes(rail) ? current.filter((item) => item !== rail) : [...current, rail])
  }

  const executeCommand = (rawInput: string) => {
    const input = lower(rawInput)
    if (!input) return

    setCommandStatus('analyzing')

    window.setTimeout(() => {
      if (input.includes('show inbox') || input.includes('toggle inbox')) {
        toggleRail('inbox')
        emitNotification({ title: 'Command View', detail: 'Inbox rail toggled.', severity: 'success' })
      } else if (input.includes('show list') || input.includes('toggle list')) {
        toggleRail('list')
        emitNotification({ title: 'Command View', detail: 'List rail toggled.', severity: 'success' })
      } else if (input.includes('hide rails')) {
        setVisibleRails([])
        emitNotification({ title: 'Command View', detail: 'All rails hidden.', severity: 'success' })
      } else if (input.includes('ticker off') || input.includes('hide ticker')) {
        setBottomStripVisible(false)
        emitNotification({ title: 'Command View', detail: 'Bottom command strip hidden.', severity: 'success' })
      } else if (input.includes('ticker on') || input.includes('show ticker')) {
        setBottomStripVisible(true)
        emitNotification({ title: 'Command View', detail: 'Bottom command strip shown.', severity: 'success' })
      } else if (input.includes('priority')) {
        onApplySavedPreset('positive_hot')
        emitNotification({ title: 'Command View', detail: 'Priority view armed.', severity: 'success' })
      } else if (input.includes('new replies')) {
        onSetViewFilter('new_replies')
        emitNotification({ title: 'Command View', detail: 'New replies highlighted.', severity: 'success' })
      } else if (input.includes('spanish')) {
        onSetViewFilter('spanish_language')
        emitNotification({ title: 'Command View', detail: 'Spanish conversations isolated.', severity: 'success' })
      } else if (input.includes('map only') || input.includes('focus map')) {
        setVisibleRails([])
        setBottomStripVisible(false)
      } else if (input.includes('split view')) {
        onSwitchViewMode('split')
      } else if (input.includes('list view')) {
        onSwitchViewMode('list')
      } else if (input.includes('dossier view')) {
        onSwitchViewMode('dossier')
      } else {
        setCommandStatus('thinking')
        emitNotification({ title: 'Routing To Copilot', detail: 'Opening live AI command surface for this request.', severity: 'success' })
        onOpenAi()
      }

      setCommandInput('')
      setVoiceTranscript('')
      setCommandStatus('ready')
    }, 280)
  }

  const toggleVoice = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
      setCommandStatus('ready')
      return
    }

    const Recognition = getSpeechRecognition()
    if (!Recognition) {
      emitNotification({ title: 'Voice Unavailable', detail: 'Speech recognition is not available in this browser.', severity: 'warning' })
      return
    }

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    setCommandStatus('listening')

    recognition.onresult = (event) => {
      const transcript: string[] = []
      for (let index = 0; index < event.results.length; index += 1) {
        transcript.push(event.results[index][0].transcript.trim())
      }
      const combined = transcript.join(' ').trim()
      setVoiceTranscript(combined)
      setCommandInput(combined)
    }
    recognition.onerror = () => {
      recognitionRef.current = null
      setCommandStatus('ready')
    }
    recognition.onend = () => {
      const finalText = text(commandInput)
      recognitionRef.current = null
      if (finalText) {
        setCommandStatus('cooking')
        executeCommand(finalText)
      } else {
        setCommandStatus('ready')
      }
    }
    recognition.start()
    recognitionRef.current = recognition
  }

  const handleFullscreen = async () => {
    if (!rootRef.current) return
    if (document.fullscreenElement === rootRef.current) {
      await document.exitFullscreen?.()
      return
    }
    await rootRef.current.requestFullscreen?.().catch(() => {})
  }

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement === rootRef.current) {
        void document.exitFullscreen?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!selectedThread) return
      const target = event.target as Node | null
      if (!target) return
      if (threadCardRef.current?.contains(target)) return
      const commandBar = rootRef.current?.querySelector('.nx-command-bar')
      const settingsPanel = rootRef.current?.querySelector('.nx-command-settings-panel')
      if (commandBar?.contains(target) || settingsPanel?.contains(target)) return
      onClearSelection()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [onClearSelection, selectedThread])

  const showInboxRail = visibleRails.includes('inbox')
  const showListRail = visibleRails.includes('list')

  return (
    <section ref={rootRef} className={cls('nx-command-surface', isFullscreen && 'is-fullscreen')}>
      <button type="button" className={cls('nx-command-settings-toggle', settingsOpen && 'is-active')} onClick={() => setSettingsOpen((current) => !current)} aria-label="Command settings">
        <Icon name="settings" />
      </button>

      {settingsOpen && (
        <aside className="nx-command-settings-panel">
          <button type="button" className={cls(showInboxRail && 'is-active')} onClick={() => toggleRail('inbox')}>Inbox Rail</button>
          <button type="button" className={cls(showListRail && 'is-active')} onClick={() => toggleRail('list')}>List Rail</button>
          <button type="button" className={cls(bottomStripVisible && 'is-active')} onClick={() => setBottomStripVisible((current) => !current)}>Live Strip</button>
          <button type="button" onClick={handleFullscreen}>{isFullscreen ? 'Exit Full Screen' : 'Full Screen'}</button>
          <div className="nx-command-settings-panel__section">
            <span>Map Theme</span>
            <div className="nx-command-settings-panel__seg">
              {COMMAND_MAP_THEME_OPTIONS.map((theme) => (
                <button key={theme.id} type="button" className={cls(mapTheme === theme.id && 'is-active')} onClick={() => handleMapThemeChange(theme.id)}>{theme.label}</button>
              ))}
            </div>
          </div>
          <div className="nx-command-settings-panel__section">
            <span>Map Mode</span>
            <div className="nx-command-settings-panel__seg">
              {([
                ['threads', 'Threads'],
                ['sends', 'Sends'],
                ['follow_ups', 'Follow-Ups'],
              ] as const).map(([mode, label]) => (
                <button key={mode} type="button" className={cls(mapActivityMode === mode && 'is-active')} onClick={() => setMapActivityMode(mode)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="nx-command-settings-panel__section">
            <span>Filters</span>
            <div className="nx-command-settings-panel__seg is-wrap">
              <button type="button" className={cls(mapFilters.unreadOnly && 'is-active')} onClick={() => setMapFilters((current) => ({ ...current, unreadOnly: !current.unreadOnly }))}>Unread</button>
              <button type="button" className={cls(mapFilters.followUpDue && 'is-active')} onClick={() => setMapFilters((current) => ({ ...current, followUpDue: !current.followUpDue }))}>Follow-Up Due</button>
              <button type="button" className={cls(mapFilters.highEquity && 'is-active')} onClick={() => setMapFilters((current) => ({ ...current, highEquity: !current.highEquity }))}>High Equity</button>
            </div>
          </div>
          <button type="button" onClick={() => executeCommand('show priority')}>Show Priority</button>
          <button type="button" onClick={() => executeCommand('show new replies')}>Show New Replies</button>
          {commandHints.map((hint) => (
            <button key={hint} type="button" onClick={() => executeCommand(hint)}>{hint}</button>
          ))}
          <button type="button" onClick={onExitCommandView}>Exit Command</button>
        </aside>
      )}

      <header className="nx-command-bar">
        <div className="nx-command-bar__orb" aria-live="polite">
          <button type="button" className={cls('nx-command-bar__orb-shell', `is-${commandStatus}`)} onClick={toggleVoice} title="Toggle voice command mode">
            <span className="nx-command-bar__orb-core" />
          </button>
          <div className="nx-command-bar__orb-meta">
            <span>Command AI</span>
            <strong>{commandStatus === 'ready' ? 'Ready' : commandStatus === 'listening' ? 'Listening' : commandStatus === 'thinking' ? 'Thinking' : commandStatus === 'analyzing' ? 'Analyzing' : 'Cooking'}</strong>
          </div>
        </div>

        <form
          className="nx-command-bar__input-shell"
          onSubmit={(event) => {
            event.preventDefault()
            executeCommand(commandInput)
          }}
        >
          <Icon name="search" />
          <input
            value={commandInput}
            onChange={(event) => setCommandInput(event.target.value)}
            placeholder="Ask NEXUS anything or run commands..."
          />
          <button type="button" onClick={toggleVoice} className={cls(recognitionRef.current && 'is-live')}>
            <Icon name="mic" />
          </button>
          <button type="submit">
            <Icon name="spark" />
          </button>
        </form>
      </header>

      <div className="nx-command-surface__viewport">
        {showInboxRail && (
          <aside className="nx-command-surface__rail nx-command-surface__rail--inbox">
            <InboxSidebar
              threads={threads}
              selectedId={selectedThread?.id ?? null}
              activeViewFilter={viewFilter}
              onSelect={onSelectThreadId}
              onThreadAction={onThreadAction}
              savedPreset={savedPreset}
              onApplySavedPreset={onApplySavedPreset}
              viewCounts={viewCounts}
              onOpenAdvancedFilters={() => {}}
              onClearFilters={() => onApplySavedPreset('my_priority')}
              onLoadMore={onLoadMore}
              canLoadMore={canLoadMore}
              recentlyUpdatedThreadIds={recentlyUpdatedThreadIds}
              searchQuery={searchQuery}
              onSearchQueryChange={onSearchQueryChange}
              visibleThreadCount={visibleThreadCount}
              loadingError={liveFetchError}
              densityMode="compact"
            />
          </aside>
        )}

        <main className="nx-command-surface__map-stage">
          <InboxCommandMap
            threads={threads}
            visibleThreads={visibleThreads}
            selectedThread={selectedThread}
            zoomedIn
            sourceMode="all_active_coordinate_threads"
            onSelectThreadId={onSelectThreadId}
            fullHeight
            commandMode
            initialActivityMode={mapActivityMode}
            initialMapStyleMode={mapTheme}
            initialFilters={mapFilters}
            initialMapOverlays={mapOverlays}
            onStateChange={(state) => {
              setMapActivityMode(state.activityMode)
              handleMapThemeChange(state.mapStyleMode)
              setMapFilters(state.filters)
              setMapOverlays(state.mapOverlays)
            }}
          />

          {selectedThread && (
            <section ref={threadCardRef} className="nx-command-thread-card">
              <div className="nx-command-thread-dock__header">
                <div>
                  <span>Live SMS Workspace</span>
                  <strong>{selectedThread.ownerName || selectedThread.propertyAddress || 'Conversation'}</strong>
                </div>
                <button type="button" onClick={onClearSelection}>
                  <Icon name="close" />
                </button>
              </div>
              <div className="nx-command-thread-card__meta">
                <div>{selectedThread.propertyAddress || selectedThread.subject || 'Unknown property'}</div>
                <div>{String(selectedThread.conversationStage || '').replace(/_/g, ' ') || 'Unknown stage'}</div>
              </div>
              <div className="nx-command-thread-card__messages">
                {messagesLoading && <div className="nx-command-thread-card__empty">Syncing thread...</div>}
                {!messagesLoading && selectedMessages.length === 0 && <div className="nx-command-thread-card__empty">No messages yet.</div>}
                {selectedMessages.slice(-6).map((message) => (
                  <article key={message.id} className={cls('nx-command-thread-card__bubble', message.direction === 'outbound' && 'is-outbound')}>
                    <p>{message.body}</p>
                    <small>{formatRelativeTime(message.createdAt || message.timelineAt || '')}</small>
                  </article>
                ))}
              </div>
              <div className="nx-command-thread-card__actions">
                <button type="button" onClick={() => onThreadAction(selectedThread, selectedThread.isStarred ? 'unstar' : 'star')}>
                  <Icon name="star" />
                </button>
                <button type="button" onClick={() => onThreadAction(selectedThread, selectedThread.isPinned ? 'unpin' : 'pin')}>
                  <Icon name="bookmark" />
                </button>
                <button type="button" onClick={onOpenAi}>
                  <Icon name="spark" />
                </button>
              </div>
              <form
                className="nx-command-thread-card__composer"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!draftText.trim() || selectedSuppressed) return
                  void onSend(draftText)
                }}
              >
                <input
                  value={draftText}
                  onChange={(event) => onSetDraftText(event.target.value)}
                  placeholder={selectedSuppressed ? 'Messaging disabled for suppressed thread' : 'Type a message...'}
                  disabled={selectedSuppressed || isSending}
                />
                <button type="submit" disabled={selectedSuppressed || isSending || !draftText.trim()}>
                  <Icon name="send" />
                </button>
              </form>
              <div className="nx-command-thread-card__suggestions">
                {commandSuggestions.slice(0, 3).map((suggestion) => (
                  <button key={suggestion.label} type="button" onClick={() => onSetDraftText(suggestion.label)}>
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </section>
          )}
        </main>

        {showListRail && (
          <aside className="nx-command-surface__rail nx-command-surface__rail--list">
            <InboxConversationTable
              threads={visibleThreads}
              selectedId={selectedThread?.id ?? null}
              sort={tableSort}
              density={tableDensity}
              statCounts={listStatCounts}
              onSortChange={onSetTableSort}
              onDensityChange={onSetTableDensity}
              onSelect={onSelectThreadId}
            />
          </aside>
        )}
      </div>

      {bottomStripVisible && (
        <footer className="nx-command-strip">
          <div className="nx-command-strip__track">
            {tickerItems.map((item) => (
              <button key={item.id} type="button" className="nx-command-strip__item" onClick={() => item.threadId && onSelectThreadId(item.threadId)}>
                <span>{item.label}</span>
                <strong>{item.detail}</strong>
                <small>{item.timestamp}</small>
              </button>
            ))}
          </div>
        </footer>
      )}

      {voiceTranscript && <div className="nx-command-voice-caption">{voiceTranscript}</div>}
    </section>
  )
}
