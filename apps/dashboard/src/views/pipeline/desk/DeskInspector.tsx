/**
 * PIPELINE DESK · DEAL INSPECTOR — the one contextual inspector, holding a
 * deal: whose move it is and the evidence for it, the money (each figure with
 * its kind), the engine's read, the conversation and the story. Hand-offs go
 * to the canonical surfaces; nothing here writes.
 */
import type { ReactNode } from 'react'
import { ObjectMenuButton } from '../../../modules/desktop/objects'
import { deskDealObject } from './desk-objects'
import type { IconName } from '../../../shared/icons'
import { LCButton, LCError, LCFacts, LCIconButton, LCInspector, LCInspectorSection, LCSkeleton, LCStatus, LCTimeline, type LCTimelineItem } from '../../../shared/lc'
import { compactMoney, type PipelineDealStory } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskCard } from './pipeline-desk-api'
import { HOLD_META, OWNER_META, intentWords, relShort, stageTag, stampCT } from './pipeline-desk-model'
import { useDealStory } from './use-pipeline-desk'

const BEAT_ICON: Record<string, IconName> = {
  contact: 'send', reply: 'message', advance: 'arrow-up-right', regress: 'arrow-down-left', price: 'dollar-sign', offer: 'send',
  counter: 'refresh-cw', created: 'spark', exit: 'archive', heat: 'zap', accepted: 'check', closing: 'briefcase', now: 'activity',
}
const TIER: Record<string, string> = {
  AUTO_HARD_OFFER: 'Hard offer (spendable)', AUTO_RANGE_OFFER: 'Range offer (spendable)', REVIEW_REQUIRED: 'Review required',
  CREATIVE_TERMS: 'Creative terms', NURTURE: 'Nurture',
}

export type InspectorActions = {
  onConversation?: (card: DeskCard) => void
  onDealIntelligence?: (card: DeskCard) => void
  onMap?: (card: DeskCard) => void
  onEntityGraph?: (card: DeskCard) => void
  onBuyerMatch?: (card: DeskCard) => void
  onComps?: (card: DeskCard) => void
  onClosingDesk?: (card: DeskCard) => void
}

export function DeskInspector({ id, seed, onClose, actions, now }: { id: string | null; seed: DeskCard | null; onClose: () => void; actions: InspectorActions; now: number }) {
  const story = useDealStory(id)
  const fromStory = (story.data?.card as unknown as DeskCard | undefined) ?? null
  const card: DeskCard | null = fromStory && fromStory.id === id ? { ...(seed ?? {}), ...fromStory, owner: fromStory.owner ?? seed?.owner ?? 'seller' } as DeskCard : seed
  const open = Boolean(id)
  const owner = card ? OWNER_META[card.owner] ?? OWNER_META.seller : null
  return (
    <LCInspector
      open={open}
      onClose={onClose}
      id="pipeline-desk-deal"
      label="Deal"
      eyebrow={card ? stageTag(card.stageIndex, card.stage) : 'Deal'}
      title={card ? card.address || card.seller || 'Unaddressed deal' : 'Loading deal'}
      subtitle={card ? [card.address ? card.seller : null, card.market, card.propertyType].filter(Boolean).join(' · ') || null : null}
      status={card && owner ? (
        <span className="pd2-insp__status">
          <LCStatus label={owner.label} tone={owner.tone} quiet={!owner.human} />
          {card.hold ? <LCStatus label={HOLD_META[card.hold].label} tone={HOLD_META[card.hold].tone} hollow /> : null}
          {card.hot ? <LCStatus label="Hot" tone="attn" hollow /> : null}
        </span>
      ) : null}
      contentKey={id ?? 'none'}
      width={440}
      footer={card ? <InspectorFooter card={card} actions={actions} /> : null}
    >
      {!card ? <LCSkeleton shape="lines" count={6} /> : (
        <>
          <LCInspectorSection title="Next action">
            <div className="pd2-insp__next">
              <b>{card.lane.label}</b>
              {card.lane.detail ? <span>{card.lane.detail}</span> : null}
              {card.lane.since ? <small>Since {stampCT(card.lane.since)} · {relShort(card.lane.since, now)}</small> : null}
            </div>
            <LCFacts rows={[
              ...(card.hold ? [{ label: 'Rule', value: HOLD_META[card.hold].rule }] : []),
              ...(card.lane.evidence ? [{ label: 'Queue', value: card.lane.evidence }] : []),
              { label: 'Last turn said', value: card.intent_next ? `${intentWords(card.intent_next.action)}${card.intent_next.due ? ` · ${stampCT(card.intent_next.due)}` : ''}` : null, hint: 'The stated intent of the last inbound turn — the queue shows what actually happened' },
              ...(card.queue?.next ? [{ label: 'In the queue', value: `${card.queue.next.kind === 'follow_up' ? 'Follow-up' : 'Reply'} · ${card.queue.next.future ? `scheduled ${stampCT(card.queue.next.at)}` : 'sending'}` }] : []),
              ...(card.stall ? [{ label: 'Stalled', value: card.stall.label }] : []),
            ]} />
          </LCInspectorSection>

          <LCInspectorSection title="Money">
            <LCFacts rows={[
              { label: 'Seller ask · stated', value: card.money.askImplausible ? `${compactMoney(card.money.asking)} · looks mis-captured` : compactMoney(card.money.asking) },
              ...(card.money.counter ? [{ label: 'Seller counter · stated', value: card.money.counterImplausible ? `${compactMoney(card.money.counter)} · looks mis-captured` : compactMoney(card.money.counter) }] : []),
              { label: 'Value · estimated', value: compactMoney(card.money.value) },
              // engine + offer facts wait for the story — never "not recorded" while it loads
              ...(story.data ? [
                { label: 'Engine offer · modeled', value: story.data.decision?.offer ? compactMoney(story.data.decision.offer) : 'Not priced' },
                { label: 'Offer on record · actual', value: offerOnRecord(story.data) },
              ] : []),
            ]} />
          </LCInspectorSection>

          {story.error && !story.data ? <LCError what="The deal story didn’t load" onRetry={story.retry} compact /> : null}
          {story.loading && !story.data ? <LCSkeleton shape="rows" count={4} /> : null}

          {story.data?.decision ? (
            <LCInspectorSection title="Engine" aside={story.data.decision.computedAt ? <small className="pd2-insp__aside">priced {relShort(story.data.decision.computedAt, now)}</small> : null}>
              <LCFacts rows={[
                { label: 'Tier', value: story.data.decision.tier ? TIER[story.data.decision.tier] ?? story.data.decision.tier : null },
                { label: 'Confidence', value: story.data.decision.confidence !== null ? Math.round(story.data.decision.confidence) : null },
                { label: 'Value range · estimated', value: story.data.decision.valueLow && story.data.decision.valueHigh ? `${compactMoney(story.data.decision.valueLow)}–${compactMoney(story.data.decision.valueHigh)}` : null },
                { label: 'Strategy', value: story.data.decision.strategy ? story.data.decision.strategy.toLowerCase().replace(/_/g, ' ') : null },
              ]} />
            </LCInspectorSection>
          ) : null}

          {story.data ? (
            <LCInspectorSection title="Conversation" aside={<small className="pd2-insp__aside">{story.data.conversation.inbound} replies · {story.data.conversation.messages} messages</small>}>
              <div className="pd2-insp__convo">
                {story.data.conversation.lastInbound ? (
                  <Quote who="Seller" at={story.data.conversation.lastInbound.at} now={now}>{story.data.conversation.lastInbound.body}</Quote>
                ) : <p className="pd2-insp__none">No seller reply on this thread.</p>}
                {story.data.conversation.lastOutbound?.message_body ? (
                  <Quote who="Us" at={story.data.conversation.lastOutbound.created_at} now={now} out>{story.data.conversation.lastOutbound.message_body}</Quote>
                ) : null}
              </div>
            </LCInspectorSection>
          ) : null}

          {story.data?.story?.length ? (
            <LCInspectorSection title="Story">
              <LCTimeline
                dense
                byDay
                tz="America/Chicago"
                label="Deal story"
                items={story.data.story.map((b, i): LCTimelineItem => ({
                  id: `${b.kind}-${i}-${b.at}`,
                  at: b.kind === 'now' ? null : Date.parse(b.at),
                  title: b.title,
                  body: b.detail || undefined,
                  icon: BEAT_ICON[b.kind] ?? 'activity',
                  state: b.kind === 'now' ? 'now' : 'done',
                }))}
              />
            </LCInspectorSection>
          ) : null}
        </>
      )}
    </LCInspector>
  )
}

function offerOnRecord(story: PipelineDealStory): string | null {
  const live = [...(story.negotiation.offers || [])].reverse().find((o) => o.price && o.status && /sent|presented|pending|countered|accepted/i.test(o.status))
  return live ? `${compactMoney(live.price)} · ${live.status}` : 'None sent'
}

function Quote({ who, at, now, out, children }: { who: string; at: string | null | undefined; now: number; out?: boolean; children: ReactNode }) {
  return (
    <figure className={out ? 'pd2-quote is-out' : 'pd2-quote'}>
      <blockquote>{children}</blockquote>
      <figcaption>{who}{at ? ` · ${relShort(at, now)}` : ''}</figcaption>
    </figure>
  )
}

function InspectorFooter({ card, actions }: { card: DeskCard; actions: InspectorActions }) {
  return (
    <div className="pd2-insp__foot">
      {/* Every hand-off opens BESIDE Pipeline (desk/pipeline-open); Pipeline stays as it is. */}
      {card.threadKey && actions.onConversation ? <LCButton variant="primary" size="sm" icon="message" trailingIcon="arrow-up-right" title="Opens the conversation in the Inbox, beside Pipeline" onClick={() => actions.onConversation?.(card)}>Open conversation</LCButton> : null}
      {(card.threadKey || card.propertyId) && actions.onDealIntelligence ? <LCButton variant="secondary" size="sm" icon="brain" trailingIcon="arrow-up-right" title="Opens the Deal Intelligence app on this property, beside Pipeline" onClick={() => actions.onDealIntelligence?.(card)}>Deal Intelligence</LCButton> : null}
      <span className="pd2-insp__icons">
        {card.propertyId && actions.onMap ? <LCIconButton icon="map" label="Show on Map" size="sm" onClick={() => actions.onMap?.(card)} /> : null}
        {card.propertyId && actions.onEntityGraph ? <LCIconButton icon="layers" label="Open Entity Graph beside" size="sm" onClick={() => actions.onEntityGraph?.(card)} /> : null}
        {card.propertyId && actions.onComps ? <LCIconButton icon="stats" label="Open Comp Intelligence beside" size="sm" onClick={() => actions.onComps?.(card)} /> : null}
        {card.propertyId && actions.onBuyerMatch && (card.stageIndex ?? 0) >= 5 ? <LCIconButton icon="users" label="Open Buyer Match beside" size="sm" onClick={() => actions.onBuyerMatch?.(card)} /> : null}
        {card.closing && actions.onClosingDesk ? <LCIconButton icon="briefcase" label="Open Closing Desk beside" size="sm" onClick={() => actions.onClosingDesk?.(card)} /> : null}
        {/* [8.2] the deal's full object actions: Open beside, Inspect, Show property, missions */}
        <ObjectMenuButton object={deskDealObject(card)} omit={['open']} showOnMap={{ source: 'pipeline' }} />
      </span>
    </div>
  )
}
