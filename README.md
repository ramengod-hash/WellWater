# WellWater — Know What's in Your Tap Water

A public health tool that pulls real EPA Safe Drinking Water Act data to show
any US resident their water system's safety record — violations, risk score,
and what to test for at home.

Built for the **Congressional App Challenge** — TX-04 district.

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/water/:zip` | Full lookup by 5-digit zip code |
| GET | `/api/system/:pwsid` | Lookup by EPA PWSID (e.g. `TX0010001`) |
| GET | `/api/report/:pwsid` | Plain-text constituent letter |
| GET | `/api/health` | Liveness + EPA connectivity check |

### Example response — `/api/water/76201`

```json
{
  "zip": "76201",
  "system": {
    "pwsid": "TX0670005",
    "name": "CITY OF DENTON",
    "city": "DENTON",
    "state": "TX",
    "type": "CWS",
    "sourceCode": "SW",
    "population": 139000,
    "epaLink": "https://echo.epa.gov/drinking-water/water-systems/details/TX0670005"
  },
  "violations": [
    {
      "id": "...",
      "category": "monitoring",
      "contaminant": "Lead & Copper Rule",
      "isHealthBased": false,
      "isOpen": false,
      "startDate": "2022-01-01",
      "endDate": "2022-06-30"
    }
  ],
  "risk": {
    "level": "moderate",
    "label": "Moderate risk",
    "score": 2
  },
  "stats": {
    "total": 3,
    "healthBasedTotal": 0,
    "healthBasedOpen": 0,
    "monitoringOpen": 0,
    "resolvedCount": 3
  },
  "tests": [
    { "name": "Lead", "reason": "LCR violations present, or universal baseline — no safe level." },
    { "name": "Nitrate", "reason": "Common near farms and feedlots. Dangerous for infants." }
  ],
  "cached": false,
  "fetchedAt": "2026-10-18T21:00:00.000Z",
  "dataSource": "EPA SDWIS via Envirofacts"
}
```

---

## Data source

All data comes from the **EPA Safe Drinking Water Information System (SDWIS)**
via the [EPA Envirofacts REST API](https://data.epa.gov/efservice/) — a free,
public, no-key-required federal database covering 300,000+ US water systems.

WellWater does not modify or editorialize EPA data.

---

## Running locally

```bash
git clone https://github.com/YOUR_USERNAME/wellwater.git
cd wellwater
npm install
cp .env.example .env
npm start
# → http://localhost:3000
```

---

## Deploy to Vercel (free, ~2 minutes)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your repo
3. Framework preset: **Other**
4. Root directory: `.` (default)
5. Click Deploy

Vercel reads `vercel.json` automatically — no config needed.
Your app will be live at `https://wellwater-YOUR_USERNAME.vercel.app`.

---

## Deploy to Railway (alternative)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## Project structure

```
wellwater/
├── server.js          # Express API server
├── public/
│   └── index.html     # Frontend (calls /api/* — no CORS issues)
├── vercel.json        # Vercel deployment config
├── .env.example       # Environment variable template
├── package.json
└── README.md
```

---

## License

MIT. Data © U.S. Environmental Protection Agency (public domain).
