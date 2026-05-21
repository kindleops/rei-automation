import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import { ScoreBar, StatusPill, EmptyState } from '../components/AcquisitionComponents'
import type { AcquisitionWorkspaceModel } from '../acquisition.types'

interface ContactStackAppProps {
  data: AcquisitionWorkspaceModel
}

const PhoneViews = ['Best Phones', 'Bad Numbers', 'SMS Ready', 'DNC/Suppressed', 'Verified', 'Unverified']
const EmailViews = ['Verified', 'High Match', 'Low Match', 'All Emails']

const filterPhonesByView = (phones: any[], view: string) => {
  const normalized = view.toLowerCase()
  if (normalized === 'best phones') return phones.filter((p) => p.score >= 80)
  if (normalized === 'bad numbers') return phones.filter((p) => p.smsStatus === 'Invalid')
  if (normalized === 'sms ready') return phones.filter((p) => p.smsStatus === 'Valid')
  if (normalized === 'dnc/suppressed') return phones.filter((p) => p.suppression !== 'None')
  return phones
}

const filterEmailsByView = (emails: any[], view: string) => {
  const normalized = view.toLowerCase()
  if (normalized === 'verified') return emails.filter((e) => e.verificationStatus === 'Valid')
  if (normalized === 'high match') return emails.filter((e) => e.linkageQuality === 'High')
  if (normalized === 'low match') return emails.filter((e) => e.linkageQuality === 'Low')
  return emails
}

export const ContactStackApp = ({ data }: ContactStackAppProps) => {
  const [search, setSearch] = useState('')
  const [phoneView, setPhoneView] = useState('Best Phones')
  const [emailView, setEmailView] = useState('All Emails')
  const [mode, setMode] = useState<'phones' | 'emails'>('phones')

  const filteredPhones = useMemo(() => {
    let results = filterPhonesByView(data.phones, phoneView)
    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((p) => p.phoneNumber?.includes(needle) || p.ownerName?.toLowerCase().includes(needle))
    }
    return results
  }, [data.phones, phoneView, search])

  const filteredEmails = useMemo(() => {
    let results = filterEmailsByView(data.emails, emailView)
    if (search.trim()) {
      const needle = search.toLowerCase()
      results = results.filter((e) => e.email?.includes(needle) || e.ownerName?.toLowerCase().includes(needle))
    }
    return results
  }, [data.emails, emailView, search])

  return (
    <AcquisitionAppShell
      breadcrumb="Contact Stack"
      appName="Contact Stack"
      appDescription="Phone and email deliverability management"
      appStatus={`${data.phones.length} phones, ${data.emails.length} emails`}
      search={search}
      onSearchChange={setSearch}
    >
      <div className="acq-app-body">
        <main className="acq-app-main">
          <div className="acq-contact-switcher">
            <button
              type="button"
              className={mode === 'phones' ? 'is-active' : ''}
              onClick={() => setMode('phones')}
            >
              <Icon name="send" />
              Phone Numbers
            </button>
            <button
              type="button"
              className={mode === 'emails' ? 'is-active' : ''}
              onClick={() => setMode('emails')}
            >
              <Icon name="message" />
              Email Addresses
            </button>
          </div>

          {mode === 'phones' ? (
            <div className="acq-contact-section">
              <div className="acq-contact-filters">
                {PhoneViews.map((view) => (
                  <button
                    key={view}
                    type="button"
                    className={phoneView === view ? 'is-active' : ''}
                    onClick={() => setPhoneView(view)}
                  >
                    {view}
                  </button>
                ))}
              </div>

              {filteredPhones.length > 0 ? (
                <div className="acq-table-wrapper">
                  <table className="acq-table">
                    <thead>
                      <tr>
                        <th>Phone</th>
                        <th>Owner</th>
                        <th>Type</th>
                        <th>Score</th>
                        <th>SMS Status</th>
                        <th>DNC/Suppression</th>
                        <th>Last Contacted</th>
                        <th>Last Reply</th>
                        <th className="acq-col-actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPhones.map((phone) => (
                        <tr key={phone.id} className="acq-table-row">
                          <td className="acq-col-name">
                            <strong>{phone.phoneNumber}</strong>
                          </td>
                          <td>
                            <small>{phone.ownerName}</small>
                          </td>
                          <td>{phone.phoneType}</td>
                          <td className="acq-col-score">
                            <ScoreBar value={phone.score} />
                          </td>
                          <td>
                            <StatusPill value={phone.smsStatus} />
                          </td>
                          <td>{phone.suppression}</td>
                          <td>
                            <small>{phone.lastContacted}</small>
                          </td>
                          <td>
                            <small>{phone.lastReply}</small>
                          </td>
                          <td className="acq-col-actions">
                            <button type="button" title="Call">
                              <Icon name="send" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  title="No phone numbers found"
                  detail="No phone numbers match your filters."
                />
              )}
            </div>
          ) : (
            <div className="acq-contact-section">
              <div className="acq-contact-filters">
                {EmailViews.map((view) => (
                  <button
                    key={view}
                    type="button"
                    className={emailView === view ? 'is-active' : ''}
                    onClick={() => setEmailView(view)}
                  >
                    {view}
                  </button>
                ))}
              </div>

              {filteredEmails.length > 0 ? (
                <div className="acq-table-wrapper">
                  <table className="acq-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Owner</th>
                        <th>Score</th>
                        <th>Linkage Quality</th>
                        <th>Verification</th>
                        <th>Last Contacted</th>
                        <th className="acq-col-actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEmails.map((email) => (
                        <tr key={email.id} className="acq-table-row">
                          <td className="acq-col-name">
                            <strong>{email.email}</strong>
                          </td>
                          <td>
                            <small>{email.ownerName}</small>
                          </td>
                          <td className="acq-col-score">
                            <ScoreBar value={email.score} />
                          </td>
                          <td>{email.linkageQuality}</td>
                          <td>
                            <StatusPill value={email.verificationStatus} />
                          </td>
                          <td>
                            <small>{email.lastContacted}</small>
                          </td>
                          <td className="acq-col-actions">
                            <button type="button" title="Email">
                              <Icon name="message" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  title="No email addresses found"
                  detail="No email addresses match your filters."
                />
              )}
            </div>
          )}
        </main>
      </div>
    </AcquisitionAppShell>
  )
}
