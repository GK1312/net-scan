# net-scan-backend — Technical Architecture

## Overview

A stateless, REST-only Node.js/TypeScript service that performs on-demand network device scans. Given a target IP and credentials, it discovers hardware inventory and installed software via PowerShell Remoting, WMI/DCOM, or SSH. No database, no queue, no persistent state — every result is returned synchronously in the HTTP response.

---

## System Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Clients (frontend / orchestrator / curl)                               │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │ HTTP / HTTPS
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Express API  (src/app.ts + src/server.ts)                              │
│  Middleware stack: Helmet → CORS → Rate Limiter → Body Parser           │
│  → Request Logger (UUID, timing) → Routes → Error Handler              │
│                                                                         │
│  /api/v1/scanner                                                        │
│  ├── GET  /methods          list available scan methods                 │
│  ├── POST /ping             ICMP reachability                           │
│  ├── POST /test-connection  validate credentials                        │
│  ├── POST /hardware         fetch hardware inventory                    │
│  ├── POST /software         fetch installed software                    │
│  └── POST /scan             full pipeline (ping→connect→hw→sw)         │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │ async/await
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  ScannerService  (src/modules/scanner/scanner.service.ts)               │
│  Orchestrates the 4-step full scan. Normalizes raw data into            │
│  canonical HardwareInfo / SoftwareEntry shapes. Validates input         │
│  via Zod before any I/O.                                                │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │ getMethod(ScanMethod)
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Method Factory  (src/modules/scanner/method.factory.ts)                │
│  Singleton Map<ScanMethod, BaseMethod> — lazy-initialised, reused       │
│  across requests.                                                       │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  PowerShell  │  │     WMI      │  │   SSH    │  │  Node-WMI   │  │
│  │  Method      │  │  Method      │  │  Method  │  │  Method     │  │
│  │  (WinRM)     │  │  (DCOM/RPC)  │  │  (ssh2)  │  │  (wmic)     │  │
│  └──────┬───────┘  └──────┬───────┘  └────┬─────┘  └──────┬──────┘  │
└─────────┼─────────────────┼───────────────┼────────────────┼──────────┘
          │                 │               │                │
          ▼                 ▼               ▼                ▼
    spawn(powershell)  spawn(cscript)  ssh2 library   node-wmi (wmic)
    Port 5985/5986     Port 135+high   Port 22         Port 135+high
```

---

## Scanning Methods

| Method | Transport | Target Ports | Platform | Notes |
|--------|-----------|-------------|----------|-------|
| **PowerShell** | WinRM (HTTP/HTTPS) | 5985 / 5986 | Win + Linux | Spawns `powershell.exe` / `pwsh` child process |
| **WMI** | DCOM / RPC | 135 + dynamic high | Windows only | Spawns `cscript.exe` running a VBScript |
| **SSH** | SSH | 22 | Win + Linux | `ssh2` library, no child process |
| **Node-WMI** | WMI COM | 135 + dynamic high | Windows only | `node-wmi` package wrapping `wmic` |

---

## Worker Process & Parallelism

### Current Model — Synchronous Per-Request

There is **no job queue**. Each POST /scan request blocks until all four steps complete (up to ~2 min worst case):

```
Request → [Ping 5 s] → [Connect 30 s] → [Hardware 60 s] → [Software 60 s] → Response
```

**Parallelism available today:**
- Node.js event loop handles concurrent HTTP requests in parallel — multiple scans run simultaneously without explicit threading.
- Each scan spawns independent child processes (`powershell.exe`, `cscript.exe`, `ping`) which run in OS-level parallel.
- SSH commands within one scan execute sequentially over a single connection.
- `fullScan` with `continueOnError: true` (default) proceeds through all steps even if earlier ones fail, returning partial results.

**Timeout guards (all configurable via env):**

| Operation | Env var | Default |
|-----------|---------|---------|
| PowerShell script | `PS_EXECUTION_TIMEOUT_MS` | 60 s |
| Remote connection | `PS_CONNECT_TIMEOUT_MS` | 30 s |
| SSH per-command | hardcoded per operation | 15–60 s |
| TCP port check | hardcoded | 3 s |

---

## Cloud Scaling Architecture

### Current Container Setup

```
Docker (node:18-alpine)
  └─ node dist/server.js   (single process, single thread)
       Port 3000
```

### Horizontal Scaling Path (recommended)

```
                    ┌─────────────────────┐
                    │  Load Balancer       │
                    │  (nginx / AWS ALB)   │
                    └──────┬──────┬───────┘
                           │      │
              ┌────────────┘      └────────────┐
              ▼                                ▼
   ┌────────────────────┐          ┌────────────────────┐
   │  Scanner Pod / VM  │          │  Scanner Pod / VM  │
   │  (this service)    │    ...   │  (this service)    │
   └────────────────────┘          └────────────────────┘
```

Because the service is **fully stateless** (no DB, no session, no in-process queue), horizontal scaling is drop-in:

1. Run N replicas behind any load balancer — no sticky sessions needed.
2. Each replica is independent; the singleton Method Factory cache is per-process but incurs zero correctness risk.
3. Rate limiting is per-instance today; move to Redis-backed `rate-limit-redis` store for accurate cluster-wide limits.

### Kubernetes Example (EKS / GKE)

```yaml
kind: Deployment
spec:
  replicas: 4                 # scale with scan volume
  resources:
    requests: { cpu: 500m, memory: 256Mi }
    limits:   { cpu: 2,    memory: 512Mi }
```

`HorizontalPodAutoscaler` on CPU is an accurate proxy — high CPU = many active child processes = busy scans.

---

## Scaling Gaps & Recommended Improvements

| Gap | Impact | Fix |
|-----|--------|-----|
| No job queue | Long scans tie up HTTP connections; clients must hold open connections | Add BullMQ + Redis; POST /scan returns job ID, client polls GET /scan/:jobId |
| Single-threaded CPU | JSON normalization blocks event loop on large software lists (1000+ entries) | Worker threads (`worker_threads`) for normalisation, or offload to queue worker |
| No cluster mode | Single pod can't use multi-core CPU | `cluster` module or PM2 cluster mode (N = CPU count replicas per node) |
| Per-instance rate limit | Easy to circumvent by hitting different pods | Redis-backed rate limit store |
| No result caching | Identical scans re-run every time | Redis cache with short TTL (5 min) keyed on `{target+method+credentials_hash}` |
| No scan concurrency cap | Runaway requests can exhaust child-process file descriptors | Semaphore (e.g. `async-sema`) limiting concurrent active scans per instance |

---

## Request Lifecycle

```
1. Client POST /api/v1/scanner/scan
   body: { target, method, credentials, skipPing?, skipSoftware?, continueOnError? }

2. Middleware chain
   ├─ Rate limit check (per IP, sliding window)
   ├─ Body parse & size check (1 MB limit)
   ├─ Attach requestId (UUID v4) + startTime to res.locals
   └─ Zod schema validation (fails fast → 400)

3. ScannerController.fullScan()
   └─ ScannerService.fullScan()
       ├─ Step 1: pingHost()             → spawn ping, parse TTL/latency
       ├─ Step 2: method.testConnection() → TCP port check + auth probe
       ├─ Step 3: method.fetchHardware()  → script/SSH, raw JSON → normalizeHardware()
       └─ Step 4: method.fetchSoftware()  → script/SSH, raw JSON → normalizeSoftware()

4. successResponse({ ...ScanResult }, message, { requestId, duration })
   HTTP 200

5. On any step failure:
   ├─ continueOnError=true  → record error, continue remaining steps, 200 with partial data
   └─ continueOnError=false → throw AppError → error middleware → 4xx/5xx
```

---

## Security Controls

| Control | Mechanism |
|---------|-----------|
| Security headers | Helmet (CSP, X-Frame-Options, HSTS, …) |
| CORS | Whitelist via `CORS_ORIGINS` env var |
| Rate limiting | express-rate-limit, configurable per deployment |
| Input validation | Zod: IPv4/hostname regex, enum method check, required fields |
| Credential safety | Passwords embedded in script body, never in process args, never logged |
| Log scrubbing | Winston formatter strips `password` fields before writing |
| Timeout protection | All child processes killed at deadline, no zombie accumulation |

---

## Environment Variables (Full Reference)

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | — | `production` \| `development` |
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | Winston log level |
| `LOG_DIR` | `./logs` | Log file directory |
| `PS_EXECUTION_TIMEOUT_MS` | `60000` | Max PowerShell script run time |
| `PS_CONNECT_TIMEOUT_MS` | `30000` | Max connection probe time |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit rolling window |
| `RATE_LIMIT_MAX` | `100` | Max requests per window per IP |
| `CORS_ORIGINS` | — | Comma-separated allowed origins |

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18, TypeScript (ES2020, strict) |
| HTTP framework | Express 4 |
| Validation | Zod |
| SSH client | ssh2 |
| WMI client | node-wmi, VBScript via cscript.exe |
| Logging | Winston + daily-rotate-file |
| Security | Helmet, express-rate-limit |
| Container | Docker (node:18-alpine), port 3000 |
