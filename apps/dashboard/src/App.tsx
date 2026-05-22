import { AuthProvider } from './components/auth/AuthProvider'
import { RequireAuth } from './components/auth/RequireAuth'
import { CommandCenterApp } from './app/CommandCenterApp'

export default function App() {
  return (
    <AuthProvider>
      <RequireAuth>
        <CommandCenterApp />
      </RequireAuth>
    </AuthProvider>
  )
}
