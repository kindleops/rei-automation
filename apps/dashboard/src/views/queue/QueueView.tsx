import { QueuePage } from '../../modules/queue/QueuePage'
import type { QueueModel } from '../../modules/queue/queue.types'

interface QueueViewProps {
  data: QueueModel
}

export function QueueView({ data }: QueueViewProps) {
  return <QueuePage data={data} />
}