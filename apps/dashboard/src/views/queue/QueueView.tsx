import { QueuePage } from './QueuePage'
import type { QueueModel } from '../../domain/queue/queue.types'

interface QueueViewProps {
  data: QueueModel
}

export function QueueView({ data }: QueueViewProps) {
  return <QueuePage data={data} />
}
