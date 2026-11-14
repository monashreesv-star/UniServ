# UniServ Pay: Cooperative Service Marketplace with PayPal Sandbox & Autonomous AI Settlement

UniServ Pay is an experimental extension of a cooperative home-services marketplace. It provides cross-border authorization holds, deterministic financial settlement, split multi-receiver disbursements, autonomous AI settlement auditing, and an open treasury ledger.

This prototype was developed for the PayPal AI Hackathon to address cross-border booking scenarios—specifically where an expatriate, immigrant, or family member living abroad arranges and pays for trusted home maintenance (electrical, plumbing, carpentry, cleaning) for relatives in India.

---

## 1. The Problem & The Solution

* **The Problem:** In conventional on-demand gig platforms, pricing and dispute resolutions are handled through closed, centralized systems. Some platforms offer limited visibility into how payments are split, while buyers abroad arranging urgent repairs for family members lack transparent billing guarantees, fearing unauthorized extra charges or disputes across time zones.
* **The Solution:**
  1. **Cross-Border Authorization Hold:** The foreign buyer pre-authorizes an estimated hold in USD via PayPal Sandbox with a transparent conversion rate.
  2. **Server-Stamped Milestones:** Service progression (`start`, `pause_parts`, `extra_work`, `complete`) is recorded on the server with deterministic duration tracking.
  3. **Deterministic 4-Way Split:** Service fees are calculated strictly using integer mathematics:
     * **80%** directly to the artisan as a fair wage.
     * **10%** to the cooperative community welfare fund.
     * **6%** to the cooperative emergency capital reserve fund.
     * **4%** retained for platform operations (before payment processing fees).
  4. **Autonomous AI Audit Agent:** An LLM agent audits completed jobs against policy anomaly rules, proposing capture and payouts while deterministic server guards enforce final amounts.
  5. **Automated Split Disbursements:** Confirmed settlements trigger batched PayPal Payouts to distinct receiver accounts.
  6. **Public Co-op Ledger:** Every transaction, fee breakdown, and agent audit trace is auditable on a read-only AG Grid ledger.

---

## 2. Core Features Verified in This Repository

* **Multimodal AI Job Triage:** Accepts a customer's textual symptom description and an uploaded job photo (JPEG/PNG), returning structured JSON triage conforming strictly to the schema: `trade_id`, `urgency`, `likely_parts`, `price_range_inr`, `english_dispatch_summary`, `customer_language_summary`, `confidence`, and `safety_flag`.
* **Pure Deterministic Settlement Engine:** Source of truth in integer INR paise and USD cents; mathematical invariants guarantee that itemized splits exactly equal the final bill with zero floating-point rounding drift.
* **Guarded PayPal Pre-Authorization Hold:** Pre-authorizes an authorization hold for the estimated total plus a 25% contingency buffer via PayPal Orders v2 API.
* **Server-Stamped Job Event State Machine:** Validates and logs sequential lifecycle events (`start`, `pause_parts`, `resume`, `extra_work`, `complete`), preventing client-side timer manipulation.
* **Automated Multi-Receiver Payouts:** Disburses funds simultaneously to three separate PayPal receiver accounts (artisan, welfare fund, reserve fund) via PayPal Payouts v1 API.
* **Autonomous Multi-Turn Settlement Agent:** Operates via Gemini function-calling with strict server-side policy guards, automated capture correction, and policy rule veto checks.
* **Co-op Treasury Ledger:** Standalone, privacy-preserving web dashboard built with vendored AG Grid Community, featuring multi-column sorting, quick filtering, audit trace drawer, and sanitized CSV export.

---

## 3. Architecture

```mermaid
flowchart TD
    subgraph Client["Frontend Client (Expo / React Native Web)"]
        UI["Customer Web UI (Port 8081)"]
        Telemetry["Job Lifecycle Telemetry (start / complete)"]
        LedgerBtn["Profile Screen -> View Co-op Treasury Ledger"]
    end

    subgraph Server["UniServ Backend Server (Express, Port 5000)"]
        Engine["Deterministic Settlement Engine\n(Integer paise & cents math)"]
        EventSM["Event State Machine\n(Server-stamped milestones)"]
        Rules["Policy Anomaly Engine\n(Dual-severity rules)"]
        Agent["Autonomous Settlement Agent\n(Multi-turn tool execution)"]
        Store[("Local Store\nserver/data/bookings.json")]
        LedgerAPI["Ledger API (/api/ledger/*)"]
    end

    subgraph External["External APIs (Sandbox & AI)"]
        PayPalAuth["PayPal REST API v2\n(Orders / Authorize / Capture)"]
        PayPalPayout["PayPal REST API v1\n(Batched Split Payouts)"]
        Gemini["Google Gemini API\n(gemini-3.5-flash-lite)"]
    end

    subgraph LedgerView["Treasury Dashboard"]
        AGGrid["AG Grid Community Ledger\n(http://localhost:5000/ledger)"]
    end

    UI -->|"1. Submit Triage Photo + Text"| Server
    Server -->|"Forward Multimodal Triage Request"| Gemini
    Gemini -->|"Validated Structured JSON"| Server
    Server -->|"Return Triage Recommendation"| UI
    UI -->|"2. Create & Authorize Hold"| Server
    Server -->|"Create Order & Authorize"| PayPalAuth
    Telemetry -->|"3. Timestamp Milestones"| EventSM
    EventSM -->|"Record Stamped Events"| Store
    Server -->|"4. Trigger Audit & Settlement"| Agent
    Agent <-->|"Tool Calling Loop"| Gemini
    Agent -->|"Evaluate Anomaly Rules"| Rules
    Agent -->|"Calculate Exact Bill"| Engine
    Agent -->|"5. Guarded Capture"| PayPalAuth
    Agent -->|"6. Batched Split Payouts"| PayPalPayout
    Agent -->|"Store Audit Trace & Receipt"| Store
    LedgerBtn -->|"Open Dashboard"| AGGrid
    AGGrid -->|"Read Sanitized Records"| LedgerAPI
    LedgerAPI -->|"Read Records (Read-Only)"| Store
```

---

## 4. What Changed Since 1 Oct 2026

The core UniServ mobile UI prototype existed prior to the PayPal AI Hackathon (submission period 1 Oct 2026 to 13 Nov 2026). All backend server infrastructure, deterministic settlement mathematics, PayPal sandbox integrations, Gemini AI agents, and treasury ledger modules were built between 10 and 12 November 2026, within the submission period.

* **Initial Repository Baseline Commit:** `a5281e7` (Dated 2026-09-05: *Initial commit of UniServ Cooperative platform*).
* **Pre-Hackathon Baseline Commit:** `c92d577` (Dated 2026-09-05: *Update overtime surcharge to ₹20, add >7km distance surcharge rule, and fix mobile OTP screen alignment*).

### Chronological Hackathon Commit Log (Real Git History)

#### Phase 0: Baseline & Sanitization
* `06acf56` | 2026-11-10 | Phase 0: license, gitignore, brand and claim sanitization
* `f154d2d` | 2026-11-10 | Phase 0b: tracked-file cleanup and verification

#### Phase 1: Pure Deterministic Settlement Engine
* `0a7297c` | 2026-11-10 | Phase 1: deterministic settlement engine with tests

#### Phase 2: PayPal Authorization, Drafts & Server-Stamped Job Events
* `34c028f` | 2026-11-10 | Phase 2.0: PayPal smoke test script and env template
* `bc2752e` | 2026-11-10 | Phase 2.1: orders create/authorize with draft restore
* `f64ed4b` | 2026-11-11 | Phase 2.1e: preserve and show authorization hold
* `5d56bc6` | 2026-11-11 | Phase 2.2: server-stamped job events and guarded capture

#### Phase 3: PayPal Multi-Receiver Payouts & Store Safety
* `8096c84` | 2026-11-11 | Phase 3.1: PayPal payouts split
* `593e34d` | 2026-11-11 | Phase 3.1b: isolated test store, write guard and backup

#### Phase 4: Multimodal AI Triage (Google Gemini)
* `b4f0058` | 2026-11-11 | Phase 4.0: Gemini smoke test
* `c472530` | 2026-11-11 | Phase 4.0c: Gemini generation variants
* `fc3ea4a` | 2026-11-11 | Phase 4.1a: Gemini capability test
* `da52a86` | 2026-11-11 | Phase 4.1b: multimodal AI triage

#### Phase 5: Autonomous Settlement Agent & Hard Policy Guards
* `0030c53` | 2026-11-11 | Phase 5.0: settlement evidence and anomaly rules
* `b116036` | 2026-11-11 | Phase 5.1: settlement agent loop with guards
* `f754f58` | 2026-11-11 | Phase 5.2: settlement agent wired to PayPal and UI

#### Phase 6: Co-op Treasury Ledger (API & AG Grid Community)
* `aee9a45` | 2026-11-11 | Phase 6.1: treasury ledger API and plain table
* `fb2b404` | 2026-11-12 | Phase 6.2: AG Grid ledger
* `4de4d4c` | 2026-11-12 | Phase 6.3: ledger polish

#### Phase 7: Documentation, Third-Party Notices & Hygiene
* `e17652e` | 2026-11-12 | Phase 7.1: README and notices
* `66ae65e` | 2026-11-12 | Phase 7.1b: README corrections

#### Fixes, Polish & Cross-Platform Refinements
* `13fa6d1` | 2026-11-10 | Fix initial splash duration and set OTPLogin as root entry
* `6297011` | 2026-11-10 | Phase 2.0b: fix smoke test exit on Windows
* `2b9037b` | 2026-11-11 | Phase 2.1b: fix PayPal return routing
* `dd50dbb` | 2026-11-11 | Phase 2.1d: fix initialization order in AppNavigator
* `37edef0` | 2026-11-11 | Phase 2.2b: fix payment screen variable and per-user booking state
* `72663da` | 2026-11-11 | Phase 2.2c: fix job event emission and surface errors
* `519b71d` | 2026-11-11 | Phase 4.0b: Gemini smoke test diagnostics

---

## 5. What Is Real and What Is Simulated

| Component | Status | Operational Details |
|---|---|---|
| **PayPal Sandbox Orders** | **REAL** | Real HTTPS calls to `api-m.sandbox.paypal.com/v2/checkout/orders` creating orders with `intent: 'AUTHORIZE'`. |
| **PayPal Pre-Auth Hold** | **REAL** | Real HTTPS calls to `/v2/checkout/orders/{id}/authorize` creating PayPal authorization entities held in sandbox. |
| **PayPal Final Capture** | **REAL** | Real HTTPS calls to `/v2/payments/authorizations/{id}/capture` capturing exact final USD amounts. |
| **PayPal Split Payouts** | **REAL** | Real HTTPS calls to `/v1/payments/payouts` disbursing simultaneous batch transfers to artisan, welfare, and reserve emails. |
| **Gemini AI Triage** | **REAL** | Live API calls to `gemini-3.5-flash-lite` processing uploaded photos and text into validated JSON schemas. |
| **Gemini Settlement Agent**| **REAL** | Live multi-turn tool calling loop evaluating evidence packets, executing guarded capture, and initiating payouts. |
| **Job Event State Machine**| **REAL** | Server-timestamped sequential event logging (`start`, `pause_parts`, `resume`, `extra_work`, `complete`). |
| **Co-op Treasury Ledger** | **REAL** | Read-only ledger populated strictly from active records in `server/data/bookings.json`. |
| **OTP Verification** | **SIMULATED** | Checked client-side in the app demo flow. The server records event timestamps but does not verify SMS codes. |
| **Map & Worker Tracking** | **SIMULATED** | Interactive Leaflet map renders real map tiles, but artisan movement and GPS telemetry are simulated. |
| **Artisan Registry** | **SIMULATED** | Pre-seeded mock JSON database (`src/data/workers.json`, `src/data/services.json`). |
| **INR to USD Exchange Rate**| **SIMULATED** | Fixed demo constant (`SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD = 1 / 85`). Customer UI displays Indian Rupees (₹), while PayPal orders and ledger figures are strictly USD ($). |
| **Warranty Refunds** | **NOT WIRED** | Dispute guarantee policies are displayed for UI transparency; automated refund webhooks are not implemented. |
| **PayPal Webhooks** | **NOT USED** | Synchronous API return routing and polling endpoints are used instead of asynchronous webhook listeners. |
| **Graceful Fallback Mode** | **BUILT-IN** | If PayPal or Gemini credentials are not supplied, the server operates in `SIMULATED` mode: orders return mock IDs, triage returns labeled `[SIMULATED]` JSON, and settlement executes in `RULES_ONLY` mode. |

---

## 6. Testing Access & Credentials

* **Sandbox Credentials:** Sandbox buyer login credentials for judging and evaluation are provided directly in the Devpost submission's testing credentials field (not published in this public repository).
* **Simulated Mode:** If running without external credentials, the entire application still functions end-to-end in `SIMULATED` mode:
  * PayPal orders return mock sandbox IDs and simulated authorization holds.
  * Gemini triage returns valid mock JSON clearly badged with `[SIMULATED AI RESPONSE]`.
  * The settlement agent operates in deterministic `RULES_ONLY` mode.

---

## 7. Setup and Run Guide

### Prerequisites
* **Node.js**: Node.js 20 or newer (developed and tested on Node 24).
* **Operating System**: Windows (PowerShell / Command Prompt), macOS, or Linux.
* **Ports Available**: `5000` (API Server) and `8081` (Expo Web Client).

### Step 1: Install Dependencies
Open a terminal in the project root:
```cmd
cmd /c npm install
cd /d server
cmd /c npm install
cd /d ..
```
*(On macOS/Linux, run `npm install && cd server && npm install && cd ..`)*.

### Step 2: Configure Environment Variables
Copy the template file to create `server/.env`:
```cmd
copy server\.env.example server\.env
```
Open `server/.env` and configure the following variables:

```ini
# Server Port
PORT=5000

# PayPal Sandbox Environment Configuration
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_CLIENT_ID=your_paypal_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_paypal_sandbox_client_secret

# Origin URL for PayPal redirect return
CLIENT_RETURN_URL=http://localhost:8081

# Payout Receiver Accounts (Sandbox personal or business accounts)
PAYPAL_RECEIVER_ARTISAN_EMAIL=artisan@example.com
PAYPAL_RECEIVER_WELFARE_EMAIL=welfare@example.com
PAYPAL_RECEIVER_RESERVE_EMAIL=reserve@example.com

# Google Gemini API Configuration
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash-lite

# Optional demo-only settings (do not use for real runs)
# DEMO_TIME_SCALE=60      # Multiplies active seconds for rapid duration testing
# MIN_HOLD_CENTS=100      # Sets a minimum authorization hold ceiling in USD cents
# DEMO_MODE=true          # Activates demo mode overrides
```
> [!IMPORTANT]
> Any edits to `server/.env` require restarting the API server process to take effect. Never commit real keys or sandbox passwords to version control.

### Step 3: Run the Application (Two Terminals)

* **Terminal 1 (Backend API Server):**
  ```cmd
  cd /d server
  cmd /c npm start
  ```
  The API will start on `http://localhost:5000`.

* **Terminal 2 (Expo Web Client):**
  ```cmd
  cmd /c npx expo start --web
  ```
  The client will launch on `http://localhost:8081`.

### Step 4: Run the Automated Test Suite
From the repository root:
```cmd
cmd /c npm test
```
Executes the full automated suite, `npm test`, covering unit, regression, and integration tests with zero network dependencies.

### Step 5: Open the Co-op Treasury Ledger
Navigate to `http://localhost:5000/ledger` in any browser to inspect transaction records, financial breakdown KPIs, and agent audit traces.

---

## 8. Gemini API & PayPal Sandbox Notes

### Gemini Model Selection & Observed Latencies
* **Recommended Model:** `gemini-3.5-flash-lite`.
* **Measured Performance & Latency:**
  * In our testing, `gemini-3.5-flash-lite` achieved typical response latencies of 1 to 4 seconds for multimodal triage, and 5 to 30 seconds for complete multi-turn settlement agent loops.
* **Findings from Testing:**
  1. `thinkingBudget: 0` is rejected with HTTP 400 (`INVALID_ARGUMENT`) on `gemini-3.5-flash-lite`.
  2. `gemini-3.8-flash` timed out or returned HTTP 503 errors during testing under high load.
  3. `gemini-3.5-flash-lite` without `thinkingConfig` executed structured JSON triage and multi-turn tool calling reliably.

### PayPal Developer Account Setup
1. Log in to the [PayPal Developer Dashboard](https://developer.paypal.com/).
2. Create **one Business Account** (Platform/Merchant) and generate REST API credentials (`PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`).
3. Under Sandbox App Settings, ensure **Payouts** is enabled.
4. Create **one Personal Sandbox Account** (Buyer) for checkout approval.
5. Create **three Sandbox Accounts** (Personal or Business) for payout receivers: Artisan, Welfare Fund, and Capital Reserve.

### Costs
* **Free:** All payment flows operate in the PayPal Sandbox environment. All AI functions operate within Google Gemini Free Tier quotas. Zero real money is charged.

---

## 9. Judge Quick-Start (5-Minute Evaluation)

Follow these exact steps using the application UI:

1. **Quick Login:**
   Open `http://localhost:8081` in your browser. On the login screen, click **"Quick Demo Login (Priya Sharma)"**.
2. **Service Selection:**
   On the Home screen, select **"Plumber"** (recommended for evaluation as it features realistic pricing and extra-work catalog options).
3. **AI Smart Triage:**
   Enter a brief issue description (e.g., "Leaking kitchen sink pipe under high pressure") or attach an image. Tap the **"AI Smart Triage"** button to view the structured Gemini triage recommendation.
4. **Payer Selection:**
   In the booking form payment options, select **"Pay from abroad via PayPal sandbox (USD)"**.
5. **Review & Authorize Hold:**
   Advance to the review screen and tap **"Authorize with PayPal Sandbox • $X.XX USD"**. You will be redirected to PayPal Sandbox checkout. Log in with the Sandbox Buyer account (from Devpost testing credentials) and approve the authorization hold.
6. **Job Progression & Active Duration:**
   Upon redirect back to the app, the booking displays an active authorization hold. Tap to start the job with the Start OTP.
   > [!TIP]
   > Wait 30 or more seconds between Start OTP and Completion OTP for a realistic recorded duration.
   Optionally, add a standard extra work item from the catalog, then complete the job with the Completion OTP.
7. **Settlement Screen:**
   On the final settlement screen, tap **"Settle Final Bill • $X.XX USD"**. The autonomous Gemini Settlement Agent audits the job evidence packet, verifies anomaly rules, executes the guarded capture against the authorization hold, and triggers the batched split payouts. The UI displays an audit progress card and renders the step-by-step audit trace upon completion.
8. **View Treasury Ledger:**
   Open the Profile screen and tap **"View Co-op Treasury Ledger"** (or visit `http://localhost:5000/ledger` directly) to audit the settled transaction in AG Grid, inspect the audit drawer, and export CSV reports.

### Try the HOLD Scenario
To test policy guard veto enforcement:
1. Start a new booking for **Plumber** and authorize the hold.
2. During the job, add a large extra work item or multiple extra items such that extra work exceeds 100% of the base service bill (`RULE_EXCESSIVE_EXTRAS`) or the total exceeds the ceiling (`RULE_CEILING_EXCEEDED`).
3. Complete the job and tap **"Settle Final Bill • $X.XX USD"**.
4. **Observed Outcome:**
   * The settlement agent detects the policy rule violation.
   * The UI displays `HOLD FOR HUMAN` status with an explanation card.
   * The payout tool is **not** offered, and $0.00 is captured.
   * In the Co-op Treasury Ledger, the booking is listed with decision **`HELD`**, and total paid out is **`$0.00`**.

---

## 10. How the AI Settlement Agent Stays Safe

The settlement agent uses a defense-in-depth model where the LLM is treated as an untrusted decision aid:

1. **Server Decides; Model Only Proposes:** The LLM cannot directly modify database state or initiate HTTP calls. It can only call declared tools (`capture_payment`, `run_payouts`, `hold_for_review`).
2. **Amounts Sourced Exclusively from Server:** The model is not allowed to compute or invent billing amounts. Capture amounts must equal `engine_total_usd_cents` computed by the deterministic engine; any altered amount is rejected by the server guard with an error message instructing the model to use `engine_total_usd_cents`.
3. **Deterministic Anomaly Rules (Dual-Severity):** Deterministic rules evaluate evidence before the model speaks:
   * `RULE_CEILING_EXCEEDED` (**HIGH**): Triggered when the final bill exceeds the pre-authorized ceiling.
   * `RULE_EXCESSIVE_EXTRAS` (**HIGH**): Triggered when extra work plus parts exceed 100% of the base service bill.
   * `RULE_SUSPICIOUS_FAST_EXTRAS` (**HIGH**): Triggered when active service duration is below 20s while billing extra work or parts.
   * `RULE_NON_POSITIVE_DURATION` (**LOW**): Triggered when recorded elapsed duration is zero or negative (treated safely as 0s).
   * `RULE_MANY_EXTRA_WORK_EVENTS` (**LOW**): Advisory flag when extra work events exceed 3.
   * `RULE_EXCESSIVE_PAUSED_TIME` (**LOW**): Advisory flag when paused parts time exceeds 50% of total elapsed time.
   * `RULE_URGENCY_MISMATCH` (**LOW**): Advisory flag when booking type disagrees with AI triage urgency.
   * *Policy Decision Invariant:* Any **HIGH** severity flag deterministically vetoes model approval and forces `HOLD_FOR_HUMAN`.
4. **Untrusted Data Quarantine:** Customer descriptions and artisan notes are quarantined inside an `untrusted_data` JSON field with explicit system prompt instructions forbidding instruction-following inside it.
5. **Guard Rejection Limits:** If the model attempts an invalid action twice, the server terminates execution and locks the booking in `HOLD_FOR_HUMAN` (`AGENT_GUARD_FAILURE`).
6. **Concurrency Locks:** Atomic in-progress states (`IN_PROGRESS`) prevent duplicate or concurrent agent executions.

---

## 11. Tools Used & Credits

* **Google Antigravity:** Agentic AI assistant used for engineering, architecture design, test authoring, and documentation.
* **PayPal REST APIs:** Orders v2 (Authorize & Capture), Payouts v1 (Batched split disbursements).
* **Google Gemini API:** `gemini-3.5-flash-lite` for multimodal triage and autonomous multi-turn tool calling.
* **AG Grid Community:** High-performance, client-side data grid under MIT License.
* **Expo & React Native for Web:** Cross-platform web and mobile frontend application framework.
* **Node.js & Express:** Backend API server hosting the deterministic calculation engine and atomic store.
* **Claude (Anthropic):** Planning and code review were also assisted by Claude (Anthropic).
