import { BuyerIntelPage } from './BuyerIntelPage'
import type { BuyerModel } from '../../domain/buyer/buyer.adapter'

interface BuyerMatchViewProps {
  data: BuyerModel
}

export function BuyerMatchView({ data }: BuyerMatchViewProps) {
  return <BuyerIntelPage data={data} />
}
