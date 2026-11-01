import { RegistryProvider } from '@effect/atom-react'
import { createHashHistory, createRootRoute, createRoute, createRouter, RouterProvider, useNavigate } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { OpenPage } from '../../src/OpenPage.tsx'
import { ReviewPage } from '../../src/review/ReviewPage.tsx'
import { StackPage } from '../../src/stack/StackPage.tsx'
import '../../src/styles.css'

// Dark first, following the system when it is light.
const scheme = matchMedia('(prefers-color-scheme: light)')
const applyScheme = () => (document.documentElement.dataset.theme = scheme.matches ? 'light' : 'dark')
applyScheme()
scheme.addEventListener('change', applyScheme)

const root = createRootRoute()
const pr = createRoute({
  getParentRoute: () => root,
  path: '/pr/$host/$owner/$repo/$number',
  component: function PrRoute() {
    const p = pr.useParams()
    const prRef = { host: p.host, owner: p.owner, repo: p.repo, number: Number(p.number) }
    document.title = `#${p.number} · ${p.owner}/${p.repo}`
    return <ReviewPage key={`${p.host}/${p.owner}/${p.repo}/${p.number}`} prRef={prRef} />
  },
})
const stack = createRoute({
  getParentRoute: () => root,
  path: '/stack/$host/$owner/$repo/$number',
  component: function StackRoute() {
    const p = stack.useParams()
    document.title = `Stack #${p.number} · ${p.owner}/${p.repo}`
    return <StackPage key={`${p.host}/${p.owner}/${p.repo}/${p.number}`} prRef={{ host: p.host, owner: p.owner, repo: p.repo, number: Number(p.number) }} />
  },
})
const open = createRoute({
  getParentRoute: () => root,
  path: '/open/$host/$owner/$repo/$number',
  component: function OpenRoute() {
    const p = open.useParams()
    const navigate = useNavigate()
    const go = (view: 'pr' | 'stack') =>
      void navigate({ to: view === 'stack' ? '/stack/$host/$owner/$repo/$number' : '/pr/$host/$owner/$repo/$number', params: p, replace: true })
    return <OpenPage prRef={{ host: p.host, owner: p.owner, repo: p.repo, number: Number(p.number) }} go={go} />
  },
})
const router = createRouter({ routeTree: root.addChildren([pr, stack, open]), history: createHashHistory() })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
      <Toaster theme="system" position="bottom-right" />
    </RegistryProvider>
  </StrictMode>,
)
