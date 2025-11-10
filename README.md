# PubMed MCP Server

A Model Context Protocol (MCP) server that provides Claude.ai with access to PubMed/NCBI biomedical research databases. Optimized for pharmaceutical patent research and molecular scaffolding analysis.

**Now running on Cloudflare Pages - Free forever!** 🚀

---

## Features

### 7 Powerful Research Tools

1. **search_articles** - Search PubMed by keywords, dates, and relevance
2. **get_article_details** - Fetch complete article metadata (title, authors, abstract, DOI)
3. **search_by_compound** - Drug/molecule search with MeSH synonym expansion
4. **search_clinical_trials** - Filter clinical trial publications by phase
5. **search_by_author** - Find all publications by researcher name/affiliation
6. **advanced_boolean_search** - Complex queries with Boolean operators and field tags
7. **get_article_citations** - Track citation networks and related prior art

### Performance Enhancements

- **1-hour response caching** - Reduces NCBI API load and improves speed
- **Exponential backoff retry** - Resilient to transient API errors
- **NCBI API key support** - 10 req/s with key, 3 req/s without
- **Global edge deployment** - <50ms cold starts on Cloudflare's network

---

## Tech Stack

### Current (Cloudflare Pages)
- **Runtime:** TypeScript on Cloudflare Workers
- **Transport:** HTTP (modern MCP protocol)
- **Caching:** Cloudflare Cache API (1-hour TTL)
- **Cost:** $0/month (Free tier: 100,000 requests/day)

### Previous (Google Cloud Run)
- **Runtime:** Python + FastMCP
- **Cost:** $20/month
- **Migration date:** November 2025

---

## Deployment

### Quick Start

1. **Deploy to Cloudflare Pages** (Dashboard method - no CLI):
   - See [CLOUDFLARE-DEPLOYMENT.md](CLOUDFLARE-DEPLOYMENT.md) for step-by-step guide
   - Takes 5 minutes, zero cost

2. **Connect to Claude.ai**:
   - URL: `https://your-project.pages.dev/mcp`
   - Transport: HTTP

### Local Development

```bash
# Install dependencies
npm install

# Run local dev server
npm run dev

# Visit http://localhost:8788/mcp
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server status and configuration |
| `/mcp` | POST | MCP protocol endpoint (for Claude.ai) |
| `/mcp` | GET | Tool discovery endpoint |
| `/health` | GET | Health check |

---

## Configuration

### Environment Variables

Set in Cloudflare Dashboard → Settings → Environment Variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `NCBI_API_KEY` | Optional | NCBI E-utilities API key (increases rate limit to 10 req/s) |

**Getting an API key (free):**
1. Sign up at https://www.ncbi.nlm.nih.gov/account/
2. Go to Settings → API Key Management
3. Generate new key
4. Add to Cloudflare environment variables

---

## Usage Examples

### Example 1: Search for Diabetes Drug Research

```json
{
  "tool": "search_articles",
  "arguments": {
    "query": "metformin diabetes",
    "max_results": 20,
    "min_date": "2020/01/01",
    "sort_by": "relevance"
  }
}
```

**Returns:** List of PMIDs + result count

### Example 2: Get Full Article Details

```json
{
  "tool": "get_article_details",
  "arguments": {
    "pmids": ["12345678", "87654321"],
    "include_abstract": true
  }
}
```

**Returns:** Array of articles with title, authors, journal, abstract, DOI

### Example 3: Search Clinical Trials

```json
{
  "tool": "search_clinical_trials",
  "arguments": {
    "condition_or_drug": "lisinopril hypertension",
    "trial_phase": "Phase 3",
    "max_results": 20
  }
}
```

**Returns:** PMIDs of Phase 3 trial publications

### Example 4: Advanced Boolean Search

```json
{
  "tool": "advanced_boolean_search",
  "arguments": {
    "query": "scaffold[Title] AND diabetes[MeSH] NOT review[Publication Type]",
    "max_results": 50,
    "sort_by": "date"
  }
}
```

**Returns:** PMIDs matching complex query criteria

---

## Architecture

### File Structure

```
pubmed-mcp-server/
├── functions/
│   └── _middleware.ts       # Main MCP server logic
├── package.json             # TypeScript dependencies
├── tsconfig.json            # TypeScript configuration
├── wrangler.toml            # Cloudflare Pages config
├── CLOUDFLARE-DEPLOYMENT.md # Deployment guide
├── README.md                # This file
├── main.py                  # Legacy Python version (archived)
└── Dockerfile               # Legacy Docker config (archived)
```

### Data Flow

```
Claude.ai
   ↓ (SSE request)
Cloudflare Pages (/mcp endpoint)
   ↓ (Check cache)
Cloudflare Cache API
   ↓ (Cache miss)
NCBI E-utilities API (esearch/efetch/elink)
   ↓ (XML response)
XML Parser (DOMParser)
   ↓ (Structured data)
MCP Response (JSON-RPC 2.0)
   ↑
Claude.ai (displays results)
```

---

## NCBI E-utilities APIs Used

| API | Purpose | Endpoint |
|-----|---------|----------|
| **ESearch** | Search PMIDs by query | `/esearch.fcgi` |
| **EFetch** | Fetch article metadata | `/efetch.fcgi` |
| **ELink** | Find citation links | `/elink.fcgi` |

**Documentation:** https://www.ncbi.nlm.nih.gov/books/NBK25501/

---

## Migration Notes

### From Google Cloud Run to Cloudflare Pages

**Why migrate?**
- **Cost:** $240/year savings ($20/month → $0/month)
- **Performance:** Global edge network, <50ms cold starts
- **Simplicity:** No container management, auto-scaling

**Migration checklist:**
- [x] Convert Python FastMCP to TypeScript Cloudflare Workers
- [x] Migrate all 7 tools with identical functionality
- [x] Add 1-hour caching layer
- [x] Implement retry logic with exponential backoff
- [x] Preserve NCBI API key support
- [x] XML parsing (Python xml.etree → TypeScript DOMParser)
- [x] MCP protocol compliance (JSON-RPC 2.0)
- [x] Test all tools for feature parity

**Bug fixes during migration:**
- XML null safety (17 locations)
- Array slicing consistency
- Query string spacing
- Parameter clamping (min/max)
- UTC date handling
- Content-type case sensitivity
- Retry loop indexing

---

## Testing

### Manual Testing

```bash
# Test root endpoint
curl https://your-project.pages.dev/

# Test health check
curl https://your-project.pages.dev/health

# Test MCP endpoint (requires valid JSON-RPC request)
curl -X POST https://your-project.pages.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Expected Responses

**Root endpoint:**
```json
{
  "service": "PubMed MCP Server",
  "status": "running",
  "version": "1.0.0",
  "tools_count": 7,
  "api_key_configured": true,
  "rate_limit": "10 req/s (with API key)"
}
```

**Tools list:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "search_articles",
        "description": "Search PubMed for research articles..."
      },
      ...
    ]
  }
}
```

---

## Monitoring

### Cloudflare Analytics

Access via Dashboard → Your Project → Analytics:

- **Requests:** Total MCP calls per day
- **Bandwidth:** Data transferred
- **Cache hit rate:** % of cached responses
- **Errors:** Failed requests (4xx, 5xx)
- **P50/P95/P99 latency:** Response time percentiles

### Logs

Real-time logs available in Cloudflare Dashboard:
- Function execution logs
- API request/response traces
- Error stack traces
- Cache hits/misses

---

## Rate Limits

### NCBI E-utilities
- **Without API key:** 3 requests/second
- **With API key:** 10 requests/second
- **Enforcement:** Server-side at NCBI (HTTP 429 errors)

### Cloudflare Pages (Free Tier)
- **Requests:** 100,000/day
- **CPU time:** 30 seconds/request
- **Bandwidth:** Unlimited

---

## Contributing

### Adding New Tools

1. Edit `functions/_middleware.ts`
2. Add tool function (follow existing pattern)
3. Add tool definition to `TOOLS` array
4. Add switch case in `handleMCP()` for routing
5. Test locally with `npm run dev`
6. Commit and push (auto-deploys)

### Code Style

- **TypeScript strict mode** enabled
- **Null safety** required (use `?.` and `??`)
- **Error handling** required (try/catch on all tools)
- **Type annotations** required for function parameters

---

## License

MIT License - See LICENSE file for details

---

## Links

- **Repository:** https://github.com/sagarjaink/pubmed-mcp-server
- **Cloudflare Pages:** https://developers.cloudflare.com/pages/
- **MCP Protocol:** https://modelcontextprotocol.io/
- **NCBI E-utilities:** https://www.ncbi.nlm.nih.gov/books/NBK25501/
- **Claude.ai:** https://claude.ai

---

## Support

For issues or questions:
1. Check [CLOUDFLARE-DEPLOYMENT.md](CLOUDFLARE-DEPLOYMENT.md) troubleshooting section
2. Review Cloudflare logs for error messages
3. Verify NCBI API status: https://www.ncbi.nlm.nih.gov/
4. Open GitHub issue with reproduction steps

---

**Built with Claude Code** - November 2025
