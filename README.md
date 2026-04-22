# Job Tracker — Supreme Art

Packaging press job tracking system.

## Stack
- **Frontend**: Plain HTML/JS (`public/index.html`)
- **Backend**: Node.js + Express (`server.js`)
- **Database**: Neon Postgres (via `@neondatabase/serverless`)
- **Hosting**: Vercel

## Local Development

1. Clone the repo
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file in the root:
   ```
   DATABASE_URL=your_neon_connection_string
   ```
4. Run locally:
   ```
   npm run dev
   ```
5. Open `http://localhost:3000`

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to vercel.com → New Project → Import your GitHub repo
3. Add environment variable in Vercel dashboard:
   - Key: `DATABASE_URL`
   - Value: your Neon connection string
4. Deploy — Vercel auto-deploys on every push to main

## Making Changes

- Edit code in Cursor
- Push to GitHub (`git push`)
- Vercel auto-deploys within ~30 seconds
- No manual steps needed

## Stages
CTP Plate Making → Printing → Coatings → Die Cutting → Breaking → Pasting → Storage / Ready → Delivered
