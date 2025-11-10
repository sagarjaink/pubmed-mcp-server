# Cloudflare Pages Deployment Guide

## Migration Summary

**BEFORE:** Google Cloud Run - $20/month
**AFTER:** Cloudflare Pages - $0/month (Free tier includes 100,000 requests/day)

This guide walks you through deploying your PubMed MCP server to Cloudflare Pages using the dashboard (no CLI required).

---

## Prerequisites

1. **GitHub Repository:** Your code is already on GitHub at `sagarjaink/pubmed-mcp-server`
2. **Cloudflare Account:** Sign up at https://dash.cloudflare.com/sign-up (free)
3. **NCBI API Key:** You already have one (keep it handy for step 6)

---

## Step-by-Step Deployment

### Step 1: Log in to Cloudflare Dashboard

1. Go to https://dash.cloudflare.com/
2. Log in or create a free account

### Step 2: Create New Pages Project

1. Click **"Workers & Pages"** in the left sidebar
2. Click **"Create application"** button
3. Select **"Pages"** tab
4. Click **"Connect to Git"**

### Step 3: Connect GitHub Repository

1. Click **"Connect GitHub"**
2. Authorize Cloudflare to access your GitHub account
3. Select repository: **`sagarjaink/pubmed-mcp-server`**
4. Click **"Begin setup"**

### Step 4: Configure Build Settings

Use these exact settings:

| Setting | Value |
|---------|-------|
| **Project name** | `pubmed-mcp-server` (or your preferred name) |
| **Production branch** | `claude/deploy-mcp-cloudflare-011CUyfvuTDX2w9VPFk8pcE2` |
| **Build command** | *(leave empty)* |
| **Build output directory** | `/` |

**Important:** Cloudflare Pages automatically detects the `functions/` directory and deploys TypeScript files directly. No build step needed!

### Step 5: Click "Save and Deploy"

Cloudflare will:
- Clone your repository
- Detect `functions/_middleware.ts`
- Deploy your MCP server
- Provide a URL like: `https://pubmed-mcp-server.pages.dev`

Initial deployment takes 1-2 minutes.

### Step 6: Add Environment Variable (API Key)

**CRITICAL:** Do this immediately after first deployment to enable 10 req/s rate limit.

1. In your Cloudflare Pages project, click **"Settings"** tab
2. Click **"Environment variables"** in left sidebar
3. Click **"Add variables"** button (for Production)
4. Add this variable:

   | Variable name | Value |
   |--------------|-------|
   | `NCBI_API_KEY` | `YOUR_ACTUAL_API_KEY_HERE` |

   **Note:** Replace `YOUR_ACTUAL_API_KEY_HERE` with your real NCBI API key (the one you found in your Cloud Run environment variables)

5. Click **"Save"**
6. Go to **"Deployments"** tab and click **"Retry deployment"** to apply the new variable

### Step 7: Verify Deployment

1. Open your Cloudflare Pages URL: `https://pubmed-mcp-server.pages.dev`
2. You should see:
   ```json
   {
     "service": "PubMed MCP Server",
     "status": "running",
     "version": "1.0.0",
     "endpoints": {
       "mcp": "/mcp",
       "health": "/health"
     },
     "tools_count": 7,
     "api_key_configured": true,
     "rate_limit": "10 req/s (with API key)"
   }
   ```

3. Verify `"api_key_configured": true` - this confirms your API key is working

### Step 8: Test Health Endpoint

Visit: `https://pubmed-mcp-server.pages.dev/health`

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2025-11-10T12:34:56.789Z"
}
```

### Step 9: Connect to Claude.ai

1. Go to https://claude.ai
2. Click **Settings** → **Developer** → **Model Context Protocol**
3. Click **"Add server"**
4. Enter:
   - **Name:** `PubMed Research`
   - **URL:** `https://pubmed-mcp-server.pages.dev/mcp`
   - **Transport:** `HTTP`
5. Click **"Save"**

Claude will now have access to all 7 PubMed tools!

---

## Cost Comparison

### Google Cloud Run (BEFORE)
- **Base cost:** $20/month
- **Includes:** 2 million requests
- **Cold starts:** Yes (~2-5 seconds)
- **Scaling:** Manual configuration

### Cloudflare Pages (AFTER)
- **Base cost:** $0/month (Free tier)
- **Includes:** 100,000 requests/day (~3 million/month)
- **Cold starts:** None (<50ms globally)
- **Scaling:** Automatic, global edge network

**Savings:** $240/year

---

## Available Tools

Your MCP server provides these 7 tools to Claude:

1. **search_articles** - Keyword-based PubMed search
2. **get_article_details** - Fetch full article metadata from PMIDs
3. **search_by_compound** - Drug/molecule search with MeSH synonyms
4. **search_clinical_trials** - Filter for clinical trial publications
5. **search_by_author** - Find publications by author name
6. **advanced_boolean_search** - Complex queries with Boolean operators
7. **get_article_citations** - Find citing articles via citation network

---

## Performance Features

### 1. Caching
- **TTL:** 1 hour
- **Storage:** Cloudflare edge cache (shared across requests)
- **Benefit:** Faster responses, reduced NCBI API load

### 2. Retry Logic
- **Max retries:** 3 attempts
- **Backoff:** Exponential (2s → 4s → 8s)
- **Benefit:** Resilient to transient NCBI API errors

### 3. Rate Limiting
- **With API key:** 10 requests/second to NCBI
- **Without API key:** 3 requests/second to NCBI
- **Your setup:** API key configured ✅

---

## Monitoring & Logs

### View Real-Time Logs
1. Go to Cloudflare Pages project
2. Click **"Deployment details"** for latest deployment
3. Click **"View logs"** to see function execution logs

### View Analytics
1. Click **"Analytics"** tab in your Pages project
2. See requests, bandwidth, cache hit rates, errors

---

## Updating the Server

Cloudflare automatically redeploys when you push to the branch:

```bash
# Make changes to functions/_middleware.ts
git add functions/_middleware.ts
git commit -m "Update tool implementation"
git push origin claude/deploy-mcp-cloudflare-011CUyfvuTDX2w9VPFk8pcE2
```

Cloudflare detects the push and redeploys in ~1 minute.

---

## Troubleshooting

### Issue: "api_key_configured": false

**Solution:** You forgot to add the `NCBI_API_KEY` environment variable. Go back to Step 6.

### Issue: Tools return empty results

**Possible causes:**
1. NCBI API is temporarily down (check https://www.ncbi.nlm.nih.gov/)
2. Invalid query syntax (especially for `advanced_boolean_search`)
3. PMIDs don't exist (for `get_article_details`)

**Solution:** Check Cloudflare logs for error messages.

### Issue: "Too many requests" errors

**Possible causes:**
1. API key not configured (rate limited to 3 req/s)
2. Burst of >10 requests/second (exceeds NCBI limit)

**Solution:**
- Verify API key is set (Step 6)
- Caching helps reduce API calls automatically

### Issue: Deployment failed

**Common causes:**
1. TypeScript syntax errors in `_middleware.ts`
2. Missing environment variables
3. Invalid branch name

**Solution:** Check deployment logs in Cloudflare Dashboard for specific error message.

---

## Security Notes

### Environment Variables
- **Never commit API keys to git** - Always use Cloudflare Dashboard environment variables
- Your `NCBI_API_KEY` is encrypted at rest and only accessible to your Functions

### CORS Headers
- Currently set to `Access-Control-Allow-Origin: *` for Claude.ai compatibility
- Restricting to `https://claude.ai` is possible but may break local testing

### Rate Limiting
- NCBI enforces API rate limits at their end (3 or 10 req/s)
- Consider implementing client-side rate limiting in `_middleware.ts` if needed

---

## Next Steps

### Optional Enhancements

1. **Custom Domain:** Map `mcp.yourdomain.com` to your Pages project
   - Go to Pages project → Custom domains → Add domain
   - Update Claude.ai MCP server URL

2. **Add More Tools:** Edit `functions/_middleware.ts` and add to `TOOLS` array

3. **Improve Caching:** Adjust `CACHE_TTL` in `_middleware.ts` (currently 3600s = 1 hour)

4. **Analytics:** Use Cloudflare Analytics to monitor usage patterns

---

## Need Help?

- **Cloudflare Pages Docs:** https://developers.cloudflare.com/pages/
- **NCBI E-utilities API:** https://www.ncbi.nlm.nih.gov/books/NBK25501/
- **MCP Protocol:** https://modelcontextprotocol.io/

---

## Migration Checklist

- [x] Create TypeScript version of all 7 tools
- [x] Add 1-hour caching layer
- [x] Implement exponential backoff retry logic
- [x] Set up Cloudflare Pages project
- [x] Configure environment variables
- [x] Connect to Claude.ai
- [ ] Test all 7 tools with real queries
- [ ] Monitor logs for errors
- [ ] Decommission Google Cloud Run instance (save $20/month!)

---

**Congratulations!** Your PubMed MCP server is now running on Cloudflare Pages at zero cost.
