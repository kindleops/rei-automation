import type { SellerAssetClassKey } from './seller-asset-presentation-registry'
import {
  formatMoney,
  formatPercent,
} from './seller-map-card-formatters'

export type FinancialMeter = {
  key: string
  label: string
  percent: number
  caption: string | null
}

export type FinancialProfileView = {
  fields: Array<{ label: string; value: string }>
  meters: FinancialMeter[]
  summaryChips: Array<{ label: string; value: string }>
  pressureCaption: string | null
}

type FinancialInput = {
  estimatedValue: number | null
  equityAmount: number | null
  equityPercent: number | null
  mortgageBalance: number | null
  repairs: number | null
  pricePerUnit: number | null
  pricePerSqft: number | null
  units: number | null
  sqft: number | null
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)))

export const buildFinancialProfile = (
  input: FinancialInput,
  assetClassKey: SellerAssetClassKey,
): FinancialProfileView => {
  const freeAndClear = (input.equityPercent ?? 0) >= 95
  const leveragePercent = input.estimatedValue && input.mortgageBalance
    ? clamp((input.mortgageBalance / input.estimatedValue) * 100)
    : input.mortgageBalance == null && freeAndClear
      ? 0
      : null

  const repairBurdenPercent = input.estimatedValue && input.repairs
    ? clamp((input.repairs / input.estimatedValue) * 100)
    : null

  const equityBarPercent = input.equityPercent != null
    ? clamp(input.equityPercent)
    : input.estimatedValue && input.equityAmount
      ? clamp((input.equityAmount / input.estimatedValue) * 100)
      : 0

  const leverageCaption = leveragePercent == null
    ? '—'
    : leveragePercent >= 70
      ? 'High'
      : leveragePercent >= 40
        ? 'Moderate'
        : 'Low'

  const repairCaption = repairBurdenPercent == null
    ? '—'
    : repairBurdenPercent >= 15
      ? 'Heavy'
      : repairBurdenPercent >= 8
        ? 'Moderate'
        : 'Light'

  const summaryChips = [
    { label: 'Equity', value: formatPercent(input.equityPercent) },
    { label: 'Leverage', value: leverageCaption },
    { label: 'Repair Burden', value: repairCaption },
    { label: 'Free & Clear', value: freeAndClear ? 'Yes' : input.equityPercent != null ? 'No' : '—' },
  ].filter((chip) => chip.value !== '—')

  const fields = [
    { label: 'Estimated Value', value: formatMoney(input.estimatedValue) },
    { label: 'Equity Amount', value: formatMoney(input.equityAmount) },
    { label: 'Repair Estimate', value: formatMoney(input.repairs) },
    { label: 'Mortgage Balance', value: formatMoney(input.mortgageBalance) },
  ]

  if (assetClassKey === 'multifamily_2_4' || assetClassKey === 'multifamily_5_plus') {
    fields.push({ label: 'Value / Unit', value: formatMoney(input.pricePerUnit) })
  } else if (input.sqft && input.estimatedValue) {
    fields.push({ label: 'Value / Sqft', value: formatMoney(input.pricePerSqft) })
  }

  const meters: FinancialMeter[] = [
    {
      key: 'equity',
      label: 'Equity',
      percent: equityBarPercent,
      caption: formatPercent(input.equityPercent),
    },
  ]

  if (leveragePercent != null) {
    meters.push({
      key: 'leverage',
      label: 'Leverage',
      percent: leveragePercent,
      caption: leverageCaption,
    })
  }

  if (repairBurdenPercent != null) {
    meters.push({
      key: 'repairs',
      label: 'Repair burden',
      percent: repairBurdenPercent,
      caption: repairCaption,
    })
  }

  const pressureCaption = leveragePercent != null && leveragePercent >= 70
    ? 'High leverage pressure'
    : repairBurdenPercent != null && repairBurdenPercent >= 15
      ? 'Repair burden elevated'
      : freeAndClear
        ? 'Strong equity position'
        : null

  return {
    fields: fields.filter((field) => field.value !== '—'),
    meters,
    summaryChips,
    pressureCaption,
  }
}