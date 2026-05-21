import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import { loadCensusForProperty, type CensusData } from '../../lib/data/censusData'
import type { PropertyRecord } from './property.types'

interface CensusIntelligencePanelProps {
  property: PropertyRecord
}

const MetricRow = ({ label, value, unit = '', signal = 'neutral' }: { 
  label: string; 
  value: string | number; 
  unit?: string;
  signal?: 'neutral' | 'positive' | 'risk' 
}) => {
  const signalColor = signal === 'positive' ? '#00E676' : signal === 'risk' ? '#FF3B30' : '#888';
  return (
    <div className="census-intel-row" style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: '8px 0',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
      fontFamily: 'var(--nx-font-mono, "IBM Plex Mono", monospace)',
      fontSize: '11px',
      letterSpacing: '0.02em',
      fontVariantNumeric: 'tabular-nums'
    }}>
      <span style={{ color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>{label}</span>
      <strong style={{ color: signalColor }}>{value}{unit}</strong>
    </div>
  );
}

export const CensusIntelligencePanel = ({ property }: CensusIntelligencePanelProps) => {
  const [data, setData] = useState<CensusData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const census = await loadCensusForProperty(property);
      setData(census);
      setLoading(false);
    }
    load();
  }, [property]);

  if (loading) return <div className="pi-panel is-loading">Loading Census Intelligence...</div>;
  if (!data) return null;

  const score = data.investor_opportunity_score ?? 0;
  const scoreColor = score >= 80 ? '#00E676' : score >= 60 ? '#C6FF4A' : score >= 40 ? '#FFB800' : '#FF3B30';

  return (
    <section className="pi-panel" style={{
      backgroundColor: '#000',
      border: '1px solid rgba(198, 255, 74, 0.1)',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Industrial Differentiator: Accent hairline */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '1px', background: '#C6FF4A', opacity: 0.3 }}></div>
      
      <div className="pi-panel-heading">
        <Icon name="search" />
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <div>
            <span style={{ color: '#C6FF4A', opacity: 0.8, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Demographic Intelligence</span>
            <h2 style={{ fontFamily: 'var(--nx-font-mono)', fontSize: '14px', margin: '2px 0 0 0' }}>ACS 5-YEAR ESTIMATES</h2>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '20px', fontWeight: 'bold', color: scoreColor, fontFamily: 'var(--nx-font-mono)' }}>{score}</div>
            <div style={{ fontSize: '9px', opacity: 0.5, textTransform: 'uppercase' }}>Opportunity</div>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 12px 12px 12px' }}>
        <p style={{ 
          fontSize: '11px', 
          lineHeight: '1.5', 
          color: 'rgba(255,255,255,0.7)', 
          margin: '0 0 16px 0',
          padding: '8px',
          backgroundColor: 'rgba(198, 255, 74, 0.03)',
          borderLeft: '2px solid #C6FF4A'
        }}>
          {data.investor_signal_summary}
        </p>

        <div className="census-intel-grid">
          <MetricRow label="Median Income" value={new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.median_household_income ?? 0)} signal={data.median_household_income && data.median_household_income > 50000 ? 'positive' : 'neutral'} />
          <MetricRow label="Vacancy Rate" value={data.vacancy_rate ?? 0} unit="%" signal={data.vacancy_rate && data.vacancy_rate > 8 && data.vacancy_rate < 15 ? 'positive' : data.vacancy_rate && data.vacancy_rate > 15 ? 'risk' : 'neutral'} />
          <MetricRow label="Renter Occupied" value={data.renter_occupied_percent ?? 0} unit="%" signal={data.renter_occupied_percent && data.renter_occupied_percent > 45 ? 'positive' : 'neutral'} />
          <MetricRow label="Owner Occupied" value={data.owner_occupied_percent ?? 0} unit="%" />
          <MetricRow label="Median Rent" value={new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.median_gross_rent ?? 0)} />
          <MetricRow label="Median Home Value" value={new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.median_home_value ?? 0)} signal={data.median_home_value && data.median_home_value < 350000 ? 'positive' : 'neutral'} />
          <MetricRow label="Pop Density" value={new Intl.NumberFormat('en-US').format(data.population_density ?? 0)} unit="/sqmi" signal={data.population_density && data.population_density > 2000 ? 'positive' : 'neutral'} />
          <MetricRow label="Poverty Rate" value={data.poverty_rate ?? 0} unit="%" signal={data.poverty_rate && data.poverty_rate > 20 ? 'risk' : 'neutral'} />
        </div>
      </div>
    </section>
  );
}
