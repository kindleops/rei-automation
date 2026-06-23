import { type FC } from 'react'

interface TemplateStat {
  name: string
  count: number
  failCount: number
  // TODO: wire replyRate from message_events join
  replyRate?: number
}

interface TemplateCoverageData {
  topTemplates: TemplateStat[]
  missingTemplate: number
  blankBody: number
}

interface TemplateCoveragePanelProps {
  coverage: TemplateCoverageData
}

const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s

export const TemplateCoveragePanel: FC<TemplateCoveragePanelProps> = ({ coverage }) => {
  const maxCount = coverage.topTemplates[0]?.count ?? 1

  return (
    <div className="sqd-panel">
      <div className="sqd-panel__head">
        <span className="sqd-panel__eyebrow">Template Coverage</span>
      </div>

      {/* Summary */}
      <div className="sqd-rmetrics">
        <div className="sqd-rmetric">
          <span className="sqd-rmetric__label">Missing Template</span>
          <strong className={`sqd-rmetric__val${coverage.missingTemplate > 0 ? ' is-amber' : ''}`}>
            {coverage.missingTemplate}
          </strong>
        </div>
        <div className="sqd-rmetric">
          <span className="sqd-rmetric__label">Blank Body</span>
          <strong className={`sqd-rmetric__val${coverage.blankBody > 0 ? ' is-red' : ''}`}>
            {coverage.blankBody}
          </strong>
        </div>
      </div>

      {/* Top templates */}
      {coverage.topTemplates.length === 0 ? (
        <div className="sqd-empty">
          <span className="sqd-empty__icon">—</span>
          <span>No template data</span>
        </div>
      ) : (
        <div className="sqd-template-list">
          <div className="sqd-template-list__header">
            <span>Template</span>
            <span>Usage</span>
            <span>Count</span>
            <span>Fails</span>
            <span>Reply%</span>
          </div>
          {coverage.topTemplates.map(tpl => (
            <div key={tpl.name} className="sqd-template-row sqd-template-row--ops">
              <span className="sqd-template-row__name" title={tpl.name}>{truncate(tpl.name, 24)}</span>
              <div className="sqd-template-row__bar-wrap">
                <div
                  className="sqd-template-row__bar"
                  style={{ width: `${Math.max(4, (tpl.count / maxCount) * 100)}%` }}
                />
              </div>
              <span className="sqd-template-row__count">{tpl.count}</span>
              {tpl.failCount > 0
                ? <span className="sqd-template-row__fail">{tpl.failCount} fail</span>
                : <span className="sqd-template-row__ok">—</span>}
              {/* TODO: wire replyRate from message_events reply counts */}
              <span className="sqd-template-row__reply is-muted">
                {tpl.replyRate != null ? `${tpl.replyRate}%` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
