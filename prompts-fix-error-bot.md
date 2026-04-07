## CONTEXT
HĐĐT SaaS — GDT Bot infrastructure. Vietnamese e-invoice sync platform.
Files to modify:
  - proxy-manager.ts        (ProxyManager class, TMProxy multi-key pool, IPRoyal, static pool)
  - tracuunnt-crawler.ts    (TracuunntCrawler, MST lookup via tracuunnt.gdt.gov.vn)
  - tmproxy-refresher.ts    (TmproxyRefresher, getCurrent / getNew)

All code comments and log messages in Vietnamese.
All variable/function/type names in English.

---

## BUG FIXES (implement in this exact order)

### FIX-1 — Startup race condition: all 5 slots return null for 2–5 seconds

Problem:
  _initSlot() is fire-and-forget for all slots simultaneously.
  During startup, all slot.currentUrl = null.
  nextForCompany() finds no fallback → returns null.
  sync_worker receives proxyUrl = null → connects directly without proxy → GDT sees real server IP.

Implementation:
  a) Add public method to ProxyManager:
     async waitUntilReady(timeoutMs = 15_000): Promise<void>
     - Poll every 300ms until at least ONE slot has currentUrl !== null
     - If timeoutMs exceeded: log warn and return (do not throw — graceful degradation)
     - Log: '[ProxyManager] Tất cả slot proxy đã sẵn sàng' when done

  b) In server startup (wherever BullMQ workers are created/resumed):
     await proxyManager.waitUntilReady();
     // Resume workers only after this resolves

  c) In nextForCompany() fallback block (when slot.currentUrl is null):
     Current:
       const fallback = this.slots.find(s => s.currentUrl);
       if (!fallback) return null;
     Replace with:
       const fallback = this.slots.find(s => s.currentUrl && !s.refreshing);
       if (!fallback) {
         // All slots initialising — return first slot that is currently refreshing
         // so caller knows proxy is coming, and log a warning
         const refreshingSlot = this.slots.find(s => s.refreshing);
         logger.warn('[ProxyManager] Tất cả slot đang khởi tạo, chờ slot đầu tiên sẵn sàng', {
           sessionSuffix: sessionSuffix.slice(0, 8),
           refreshingSlots: this.slots.filter(s => s.refreshing).length,
         });
         return null; // caller must handle null gracefully
       }

### FIX-2 — markFailed does not null currentUrl immediately

Problem:
  markFailed() calls _rotateSlot() which is background (no await, 4-min cooldown).
  During rotation window, slot.currentUrl still holds the failed URL.
  Next job for same company receives the failed URL again.

Implementation in markFailed(), Mode A (TMProxy) block:
  Current:
    if (slot) {
      slot.failedUrls.add(url);
      this._rotateSlot(slot);
    }
  Replace with:
    if (slot) {
      slot.failedUrls.add(url);
      // Null out immediately so nextForCompany falls back to another slot
      slot.currentUrl       = null;
      slot.currentSocks5Url = null;
      logger.warn('[ProxyManager] Slot bị đánh dấu lỗi — đang xoay IP mới', {
        apiKey: slot.apiKey.slice(0, 8) + '…',
        failedUrl: url.replace(/:([^@:]+)@/, ':****@'),
      });
      this._rotateSlot(slot);
    }

  Also in _rotateSlot() catch block — after rotation fails, keep currentUrl = null
  so the slot is skipped by nextForCompany until rotation succeeds:
    .catch(err => {
      logger.error('[ProxyManager] Xoay IP thất bại — slot sẽ bị bỏ qua', {
        apiKey: slot.apiKey.slice(0, 8) + '…',
        error:  (err as Error).message,
      });
      slot.currentUrl       = null;  // already null from markFailed, keep it
      slot.currentSocks5Url = null;
    })

### FIX-3 — TracuunntCrawler: masothue fallback calls nextForSession a second time

Problem:
  buildClient() calls proxyManager.nextForSession(this.sessionId) → stores in local var.
  lookupMasothue() calls proxyManager.nextForSession(this.sessionId) AGAIN.
  If slot rotated between calls → different proxy URL or null → masothue bypasses proxy.

Implementation in TracuunntCrawler:
  a) Add private field: private readonly proxyUrl: string | null

  b) In constructor:
     this.proxyUrl  = proxyManager.nextForSession(sessionId);  // call ONCE, store
     this.client    = this.buildClient();                       // uses this.proxyUrl

  c) Change buildClient() signature to use this.proxyUrl instead of calling nextForSession again:
     private buildClient(): AxiosInstance {
       const profile = getProfileForSession(this.sessionId);
       const headers = getSessionHeaders(profile);
       headers['Content-Type'] = 'application/x-www-form-urlencoded';
       headers['Referer']      = 'http://tracuunnt.gdt.gov.vn/';
       headers['Origin']       = 'http://tracuunnt.gdt.gov.vn';
       const instance = axios.create({ timeout: 15_000, headers, maxRedirects: 3 });
       if (this.proxyUrl) {
         const agent = createTunnelAgent({ proxyUrl: this.proxyUrl, plainHttp: true });
         instance.defaults.httpAgent  = agent;
         instance.defaults.httpsAgent = agent;
       }
       return instance;
     }

  d) In lookupMasothue(): replace the proxyUrl local call with this.proxyUrl:
     private async lookupMasothue(taxCode: string): Promise<CompanyLookupResult> {
       const masothueClient = axios.create({
         headers: { 'User-Agent': getSessionHeaders(getProfileForSession(this.sessionId))['User-Agent'] },
         timeout: 10_000,
         ...(this.proxyUrl ? {
           httpAgent:  createTunnelAgent({ proxyUrl: this.proxyUrl }),
           httpsAgent: createTunnelAgent({ proxyUrl: this.proxyUrl }),
         } : {}),
       });
       // rest unchanged
     }

### FIX-4 — TracuunntCrawler: no proxy refresh when TMProxy IP expires (~45 min)

Problem:
  TracuunntCrawler stores proxyUrl at construction time.
  After 45 minutes the TMProxy IP expires and rotates.
  this.proxyUrl is stale — all subsequent requests use a dead IP.

Implementation:
  a) Add method refreshProxyIfNeeded(): void to TracuunntCrawler:
     refreshProxyIfNeeded(): void {
       const fresh = proxyManager.nextForSession(this.sessionId);
       if (fresh && fresh !== this.proxyUrl) {
         logger.info('[TracuunntCrawler] Proxy đã được làm mới', {
           sessionId: this.sessionId.slice(0, 8),
           old: (this.proxyUrl ?? 'none').replace(/:([^@:]+)@/, ':****@'),
           new: fresh.replace(/:([^@:]+)@/, ':****@'),
         });
         (this as { proxyUrl: string | null }).proxyUrl = fresh;
         this.client = this.buildClient();
       }
     }

  b) Call refreshProxyIfNeeded() at the start of lookup():
     async lookup(taxCode: string): Promise<CompanyLookupResult> {
       this.refreshProxyIfNeeded();   // ← add this line
       await jitter(2_000, 5_000);
       // rest unchanged
     }

### FIX-5 — TracuunntCrawler: no retry before masothue fallback

Problem:
  Any network error or empty HTML → fallback masothue immediately.
  GDT throttle causes transient empty response → false not_found recorded.

Implementation: replace the try/catch in lookup() with retry logic:
  async lookup(taxCode: string): Promise<CompanyLookupResult> {
    this.refreshProxyIfNeeded();

    const MAX_GDT_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_GDT_ATTEMPTS; attempt++) {
      await jitter(attempt === 0 ? 2_000 : 4_000, attempt === 0 ? 5_000 : 9_000);
      try {
        const response = await this.client.post(
          GDT_TRACUUNNT_URL,
          new URLSearchParams({ mst: taxCode.trim() }).toString(),
        );
        const html = response.data as string;
        // Guard: empty or clearly wrong HTML = throttle response, retry
        if (!html || html.trim().length < 200) {
          logger.warn('[TracuunntCrawler] GDT trả về HTML rỗng — thử lại', {
            taxCode, attempt,
          });
          continue;
        }
        return this.parseResponse(taxCode, html);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[TracuunntCrawler] GDT lookup lỗi — thử lại', { taxCode, attempt, msg });
        if (attempt < MAX_GDT_ATTEMPTS - 1) continue;
      }
    }
    // All GDT attempts failed → fallback
    logger.warn('[TracuunntCrawler] GDT lookup thất bại sau tất cả lần thử — chuyển masothue', { taxCode });
    return this.lookupMasothue(taxCode);
  }

### FIX-6 — Uneven company distribution with small modulo

Problem:
  _hashToIndex uses djb2 % slotCount.
  With 5 slots and UUID company IDs, distribution can skew ±2 companies per slot.
  No monitoring — cannot detect imbalance.

Implementation:
  a) Replace _hashToIndex with a better hash (murmur-inspired, better avalanche):
     private _hashToIndex(s: string, len: number): number {
       let h = 0x811c9dc5;
       for (let i = 0; i < s.length; i++) {
         h ^= s.charCodeAt(i);
         h = (Math.imul(h, 0x01000193)) >>> 0;
       }
       return h % len;
     }

  b) Add method getSlotDistribution() for monitoring/admin dashboard:
     getSlotDistribution(): Array<{ apiKey: string; companyCount: number; publicIp: string | null }> {
       // Returns per-slot info for admin metrics endpoint
       return this.slots.map(slot => ({
         apiKey:       slot.apiKey.slice(0, 8) + '…',
         publicIp:     slot.currentUrl
                         ? new URL(slot.currentUrl).hostname
                         : null,
         companyCount: 0, // populated by caller from DB query: SELECT count(*) GROUP BY proxy_slot_idx
       }));
     }

---

## PROXY OPTIMIZATION — Cost Reduction Strategy

### Strategy 1: Shared Pool for Non-GDT Crawlers (TracuunntCrawler)

Current: TracuunntCrawler calls proxyManager.nextForSession() which maps to a TMProxy slot.
Problem: tracuunnt.gdt.gov.vn only needs 1 request per company lookup (not continuous stream).
         Wasting a premium residential IP slot on occasional lookups.

Implement a two-tier proxy strategy in ProxyManager:

  Add CHEAP_PROXY_LIST env var for low-cost datacenter proxies (used for non-GDT lookups):
    CHEAP_PROXY_LIST=http://user:pass@dc-proxy1:8080,http://user:pass@dc-proxy2:8080

  Add method nextCheapProxy(): string | null:
    Returns from CHEAP_PROXY_LIST round-robin if configured.
    Falls back to nextForSession() if not configured.

  TracuunntCrawler uses nextCheapProxy() instead of nextForSession():
    this.proxyUrl = proxyManager.nextCheapProxy() ?? proxyManager.nextForSession(sessionId);

  Cost impact: tracuunnt lookup ~5đ/request on datacenter proxy vs ~50đ on residential.

### Strategy 2: TMProxy IP Reuse Window

Current: Each GdtDirectApiService constructor calls nextForCompany() which returns currentUrl.
         If two jobs for the same company run within 45 minutes, they reuse the same IP. ✓
         But if the first job is still running when the IP expires (45-min jobs), rotation
         is triggered in the background and the second concurrent job gets null.

Implement IP lease tracking in ProxyManager:
  Add field: private activeLeases = new Map<string, number>() // slotIdx → active job count

  In nextForCompany(): increment lease count for chosen slot
  Add method releaseProxy(sessionSuffix): decrement lease count
  In _rotateSlot(): if activeLeases.get(slotIdx) > 0 → defer rotation until lease drops to 0

  This prevents mid-job IP rotation which causes stream abort errors.

### Strategy 3: Off-Peak Proxy Rotation (reduce getNew() cost)

TMProxy charges per IP rotation (getNew()), not per request.
Auto-syncs run 5–6 hours apart and mostly at business hours.

Add rotation scheduling: only call getNew() between 00:00–06:00 VN time for scheduled jobs.
During business hours: prefer getCurrent() and tolerate IP age up to 4 hours.

Implement in _rotateSlot(): check VN hour before calling getNew():
  private _shouldRotateNow(): boolean {
    const vnHour = new Date(Date.now() + 7 * 3_600_000).getUTCHours();
    // Prefer rotating during low-traffic hours to avoid wasting fresh IPs on daytime GDT traffic
    return vnHour >= 0 && vnHour < 6;
  }
  // If !_shouldRotateNow(): schedule rotation for next off-peak window
  // Use setTimeout to defer: next midnight VN + random 0–60 min jitter

### Strategy 4: IPRoyal as Primary for Binary Downloads, TMProxy for JSON API (Do not do it)

Current architecture is already correct (SOCKS5 for binary).
Reinforce by documenting cost comparison in proxy-manager.ts:

  TMProxy "Đổi IP" plan: ~5,000đ/key/day → good for sticky sessions (JSON API calls)
  IPRoyal residential:   ~$3.5/GB         → expensive per-byte
  IPRoyal datacenter:    ~$1.5/GB         → cheap for binary downloads (XML ZIP ~400KB each)
  Recommendation: use IPRoyal datacenter SOCKS5 for XLSX/XML binary downloads
                  use TMProxy residential for JSON API calls (captcha, auth, invoice list)

  Set in .env:
    TMPROXY_API_KEYS=key1,key2,key3,key4,key5   # residential, JSON API
    IPROYAL_PROXY_LIST=dc-host:port:user:pass    # datacenter, binary downloads only

### Strategy 5: Request Deduplication for TracuunntCrawler

Add 24-hour Redis cache for MST lookups.
Cache key: tracuu:mst:{taxCode}   TTL: 86400s

Before making HTTP request to GDT:
  const cached = await redis.get(`tracuu:mst:${taxCode}`);
  if (cached) return JSON.parse(cached);

After successful lookup:
  await redis.set(`tracuu:mst:${taxCode}`, JSON.stringify(result), 'EX', 86400);

Cost impact: same MST looked up multiple times in a day → 0 proxy requests after first.
Typical scenario: vendor MST appears on 50 invoices → only 1 proxy request instead of 50.

---

## MANDATORY CONSTRAINTS

1. TypeScript strict mode — no `any`, use `unknown` with type guards
2. All proxy URL logging must redact password: .replace(/:([^@:]+)@/, ':****@')
3. Proxy failures are never fatal to sync — always degrade gracefully
4. keepAlive: false on all tunnel agents (already correct — do not change)
5. Backward compatible: TMPROXY_API_KEY (single key) still works as before
6. All Redis operations in tracuunnt cache: wrap in try/catch, non-fatal

## IMPLEMENTATION ORDER

FIX-2: markFailed null currentUrl immediately    ← prevents compounding failures
FIX-1: waitUntilReady startup guard              ← prevents null proxy at boot
FIX-3: TracuunntCrawler store proxyUrl once      ← fixes proxy leak
FIX-4: refreshProxyIfNeeded on each lookup       ← handles IP expiry
FIX-5: retry before masothue fallback            ← reduces false not_found
FIX-6: better hash + distribution monitoring     ← monitoring, low risk

OPTIMIZATION-5: Redis cache for MST lookups      ← biggest cost win, implement first
OPTIMIZATION-1: CHEAP_PROXY_LIST for tracuunnt   ← second biggest win
OPTIMIZATION-2: IP lease tracking                ← prevents mid-job rotation
OPTIMIZATION-3: Off-peak rotation scheduling     ← reduces getNew() calls
OPTIMIZATION-4: Document cost tiers in comments  ← no code change, just docs