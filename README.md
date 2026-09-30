This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Access: agency staff vs. client roles

- **Agency staff** (Elko Creative, table `agency_staff`) see and manage every client,
  acting as owner on each, and can create clients and invite more staff from the
  dashboard. They have no per-client membership and don't appear in a client's Team list.
- **Client roles** (`client_members`: owner / admin / viewer) only ever cover that one
  client's own business. Owners and admins manage it and invite its team; viewers are read-only.

Bootstrap staff from the CLI (production `.env.local`):

```bash
npm run staff -- --list
npm run staff -- --add you@example.com --drop-memberships   # existing account
npm run invite -- --email new@elkocreative.com --agency     # no account yet
```

Invites are links to copy and send; the app doesn't email them yet.

## End-to-end tests (separate Neon branch)

`npm run test:e2e` never runs against the production database. It reads `DATABASE_URL`
from `.env.test.local` (gitignored), which should point at a Neon branch called `e2e`,
and refuses to run if that file is missing or points at the same endpoint as `.env.local`.

One-time setup:

1. Neon console → project → **Branches** → **New branch**, name `e2e`, parent `main`
   (schema-only if offered, so no real client data is copied).
2. Copy that branch's pooled connection string into `.env.test.local`:
   `DATABASE_URL=postgresql://...`
3. `npm run db:check:e2e` to confirm the connection, then `npm run db:migrate:e2e`.
   Run `db:migrate:e2e` again whenever a new migration is added.
   A schema-only branch copies the tables but not Drizzle's migration log
   (`drizzle.__drizzle_migrations`), so the first migrate fails on "already exists".
   Fix by inserting a row per already-applied migration into that table on the e2e
   branch: `hash` = sha256 of the `.sql` file, `created_at` = its `when` in
   `drizzle/meta/_journal.json`.

Running the suite:

```bash
npm run e2e:server   # terminal 1: build + start :3000 on the e2e branch
npm run test:e2e     # terminal 2
```
