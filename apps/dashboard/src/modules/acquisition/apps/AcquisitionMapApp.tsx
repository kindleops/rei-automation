import { useMemo, useState } from 'react'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { EmptyState } from '../components/AcquisitionComponents'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'
import { useInboxData, toWorkflowThread } from '../../inbox/inbox.adapter'
import { InboxCommandMap } from '../../inbox/InboxCommandMap'
import { pushRoutePath } from '../../../app/router'

interface AcquisitionMapAppProps {
  data: AcquisitionWorkspaceModel
}

export const AcquisitionMapApp = ({ data }: AcquisitionMapAppProps) => {
  void data
  const [selectedMarket, setSelectedMarket] = useState<string>('All Markets')
  const { data: inboxData } = useInboxData()

  const threads = useMemo(
    () => (inboxData.threads ?? []).map(toWorkflowThread),
    [inboxData.threads],
  )
  const visibleThreads = useMemo(
    () => selectedMarket === 'All Markets'
      ? threads
      : threads.filter((thread) => (thread.market || thread.marketName || thread.marketId || '').toLowerCase() === selectedMarket.toLowerCase()),
    [selectedMarket, threads],
  )
  const marketOptions = useMemo(
    () => ['All Markets', ...Array.from(new Set(threads.map((thread) => thread.market || thread.marketName || thread.marketId).filter(Boolean) as string[])).sort()],
    [threads],
  )

  return (
    <AcquisitionAppShell
      breadcrumb="Acquisitions Map"
      appName="Acquisitions Command Map"
      appDescription="Deterministic spatial command surface for SMS acquisitions"
      appStatus={`${visibleThreads.length} conversations mapped`}
      marketOptions={marketOptions}
      selectedMarket={selectedMarket}
      onMarketChange={setSelectedMarket}
      actions={[
        { label: 'Open Inbox', onClick: () => pushRoutePath('/inbox') },
      ]}
    >
      <div className="acq-app-body acq-map-body">
        <main className="acq-app-main acq-map-main">
          {visibleThreads.length > 0 ? (
            <div className="acq-map-container">
              <InboxCommandMap
                threads={threads}
                visibleThreads={visibleThreads}
                selectedThread={visibleThreads[0] ?? null}
                zoomedIn={selectedMarket !== 'All Markets'}
                sourceMode="visible_threads"
                onSelectThreadId={() => {}}
                fullHeight
              />
            </div>
          ) : (
            <EmptyState
              title="No map data available"
              detail="Select a different market or check inbox data connectivity."
            />
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
