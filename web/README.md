# OSMSEA web

Next.js UI for OSMSEA. Setup, environment variables and run instructions are in the
[root README](../README.md); the design is in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

```bash
pnpm install
pnpm dev                      # http://localhost:3000 (needs the backend on NEXT_PUBLIC_API_URL)
pnpm exec tsc --noEmit && pnpm lint && pnpm build
```

Layout: `src/app/(app)/*` are the authenticated screens, `src/components/` the shared UI, graphs and
charts, `src/lib/` the Supabase client (RLS reads + Realtime), the typed API client, and
`database.types.ts` (generated from the Supabase schema).
