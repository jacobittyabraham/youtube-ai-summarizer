# AI YouTube Summarizer

Browser extension + backend that summarizes YouTube video transcripts using Google’s Gemini API.

## What’s included

- **Extension**: Runs on YouTube watch pages, grabs the visible transcript and sends it to your backend.
- **Backend**: Receives transcript, calls Gemini, returns summary. API key stays on the server (no key in the extension).

## Quick start

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env and set GEMINI_API_KEY (from https://aistudio.google.com/apikey)
npm install
npm start
```

Server runs at `http://localhost:3000`.

### 2. Extension

1. Open Chrome → **Extensions** → **Manage extensions** → **Load unpacked**.
2. Select the `extension` folder.
3. Make sure the backend is running at `http://localhost:3000`.

On a YouTube video page, open the extension, click **Summarize Video**, and the summary will appear in the popup.

## Gemini tier / rate limits

- **Free tier** (no billing): about **15 requests per minute**, **250K tokens per minute**, and daily caps depending on model.
- If you hit limits you’ll see: *“Rate limit reached… Please wait a minute and try again.”*
- The backend uses **gemini-2.0-flash** by default (good for free tier). Override with `GEMINI_MODEL` in `.env` (e.g. `gemini-1.5-flash`).

To reduce usage:

- Summarize only when needed.
- Keep transcripts under ~30k characters (backend already trims to 120k).

## Deployment

### Backend (e.g. Railway, Render, Fly.io)

1. Deploy the `backend` folder (Node.js, start with `npm start`).
2. Set environment variables:
   - **Required**: `GEMINI_API_KEY`
   - Optional: `GEMINI_MODEL`, `PORT`
3. Ensure the server is served over **HTTPS** and allows CORS from your extension (backend already uses `cors()`).

### Extension for production

1. In `extension/popup.js`, set `API_BASE` to your backend URL:
   ```js
   const API_BASE = "https://your-backend.railway.app";
   ```
2. In `extension/manifest.json`, add your backend origin to `host_permissions`:
   ```json
   "host_permissions": [
     "http://localhost:3000/*",
     "https://your-backend.railway.app/*"
   ],
   ```
3. Reload the extension (or repackage for the Chrome Web Store).

## API

- **POST /summarize-transcript**  
  Body: `{ "transcript": "..." }`  
  Returns: `{ "success": true, "summary": "..." }` or `{ "success": false, "error": "..." }`.  
  Uses Gemini; API key must be set in backend env.

- **POST /summarize**  
  Body: `{ "videoId": "dQw4w9WgXcQ" }`  
  Returns transcript for that video (alternative to extension scraping).

## Security

- **Do not** put your Gemini API key in the extension. The extension only talks to your backend; the backend holds `GEMINI_API_KEY` in environment variables.
