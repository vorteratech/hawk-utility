import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { EngagementPage } from './pages/EngagementPage'
import { HomePage } from './pages/HomePage'

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
})

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/engagements/:id" element={<EngagementPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
