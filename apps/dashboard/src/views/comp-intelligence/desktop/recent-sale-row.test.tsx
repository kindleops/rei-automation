import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecentSaleRow } from './RecentSaleRow'
import { SALE } from '../../../domain/comp-intelligence/recent-sale-facts.test'
import { recentSaleView } from '../../../domain/comp-intelligence/recent-sale-facts'

const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const NOW = Date.parse('2026-10-11')

describe('Recent market sales row — the useful facts, not just "Public record"', () => {
  it('shows channel, ONE buyer chip, distance, date, spec, price and $/sf', () => {
    const s = SALE({ buyerKind: 'company', buyerCompany: 'Acme Homes LLC', buyerClass: 'llc_investor', investor: true, cash: true })
    const html = renderToStaticMarkup(<RecentSaleRow s={s} now={NOW} view={recentSaleView(s, [s])} />)
    const t = text(<RecentSaleRow s={s} now={NOW} view={recentSaleView(s, [s])} />)
    expect(t).toContain('Off market')
    expect(t).toContain('LLC investor')
    expect(t).not.toContain('Public record')
    expect(t).toContain('0.4')
    expect(t).toContain('3 bd · 2 ba · 1,400 sf')
    expect(t).toContain('$250K')
    expect(t).toContain('$180/sf')
    expect(t).toContain('Cash')
    // exactly one channel chip and one buyer chip
    expect(html.match(/class="cst"/g)?.length).toBe(1)
    expect(html.match(/class="cbt"/g)?.length).toBe(1)
  })
  it('an unknown buyer says so, and an unpriced transfer shows no price', () => {
    const s = SALE({ priced: false, price: null, ppsf: null })
    const t = text(<RecentSaleRow s={s} now={NOW} view={recentSaleView(s, [s])} />)
    expect(t).toContain('Buyer unknown')
    expect(t).toContain('no price recorded')
    expect(t).toContain('Activity')
  })
  it('a foreclosure deed rides in the channel chip, not as a repeated flag', () => {
    const s = SALE({ docType: 'Sheriff’s Deed', saleSource: 'public_record' })
    const t = text(<RecentSaleRow s={s} now={NOW} view={recentSaleView(s, [s])} />)
    expect(t).toContain('Foreclosure / auction')
    expect(t.match(/Foreclosure/g)?.length).toBe(1)
  })
})
