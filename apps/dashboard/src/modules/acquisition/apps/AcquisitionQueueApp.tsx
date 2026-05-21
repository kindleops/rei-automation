import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { QueuePage } from '../../queue/QueuePage'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'
import type { QueueModel } from '../../queue/queue.types'

interface AcquisitionQueueAppProps {
  data: AcquisitionWorkspaceModel & { queueData: QueueModel }
}

export const AcquisitionQueueApp = ({ data }: AcquisitionQueueAppProps) => {
  return (
    <AcquisitionAppShell
      breadcrumb="Outreach Queue"
      appName="Outreach Queue"
      appDescription="Campaign execution and delivery with acquisition focus"
      appStatus={`From Acquisition`}
    >
      <div className="acq-app-body-full">
        <QueuePage data={data.queueData} />
      </div>
    </AcquisitionAppShell>
  )
}
