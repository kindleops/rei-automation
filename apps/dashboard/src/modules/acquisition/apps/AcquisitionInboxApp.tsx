import { AcquisitionAppShell } from '../components/AcquisitionAppShell'
import InboxPage from '../../inbox/InboxPage'



export const AcquisitionInboxApp = () => {
  return (
    <AcquisitionAppShell
      breadcrumb="Seller Inbox"
      appName="Seller Inbox"
      appDescription="Hot replies and negotiations with acquisition focus"
      appStatus={`From Acquisition`}
    >
      <div className="acq-app-body-full">
        <InboxPage />
      </div>
    </AcquisitionAppShell>
  )
}
