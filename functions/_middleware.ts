/**
 * PubMed MCP Server - Cloudflare Pages Edition
 * Migrated from Google Cloud Run (Python/FastMCP) to Cloudflare Pages (TypeScript)
 *
 * Transport: HTTP (modern MCP protocol) for Claude.ai compatibility
 * Endpoint: /mcp
 *
 * Features:
 * - 7 PubMed research tools via NCBI E-utilities API
 * - 1-hour response caching to reduce API load
 * - Exponential backoff retry logic
 * - Optional NCBI_API_KEY support (10 req/s with key, 3 req/s without)
 */

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

interface Env {
  NCBI_API_KEY?: string;
}

interface Article {
  pmid: string;
  title: string;
  authors: string[];
  journal: string;
  pub_date: string;
  abstract: string;
  doi: string;
}

interface SearchResult {
  count: number;
  pmids: string[];
  query_translation: string;
}

interface MCPRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: string;
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const CACHE_TTL = 3600; // 1 hour in seconds

// =============================================================================
// XML PARSING UTILITIES
// =============================================================================

/**
 * Parse ESearch XML response
 * Bug fixes applied:
 * - #1: Null safety on all element.text accesses
 * - #13: Case-insensitive content-type check
 */
function parseESearchXML(xmlText: string): SearchResult {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");

    // Extract count (Bug #1: null safety)
    const countElem = doc.querySelector("Count");
    const count = countElem?.textContent ? parseInt(countElem.textContent, 10) : 0;

    // Extract PMIDs (Bug #1: null safety)
    const idElements = doc.querySelectorAll("Id");
    const pmids: string[] = [];
    idElements.forEach(elem => {
      const text = elem.textContent;
      if (text) pmids.push(text);
    });

    // Extract query translation (Bug #1: null safety)
    const transElem = doc.querySelector("QueryTranslation");
    const query_translation = transElem?.textContent ?? "";

    return { count, pmids, query_translation };
  } catch (error) {
    console.error("Error parsing ESearch XML:", error);
    return { count: 0, pmids: [], query_translation: "" };
  }
}

/**
 * Parse EFetch XML response for PubmedArticle elements
 * Bug fixes applied:
 * - #1: Null safety on all element accesses
 * - #2: Abstract concatenation with space separator
 * - #3: Author name formatting with conditional logic
 * - #4: Publication date edge cases
 */
function parseEFetchXML(xmlText: string): Article[] {
  const articles: Article[] = [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");

    const articleElements = doc.querySelectorAll("PubmedArticle");

    articleElements.forEach(articleElem => {
      try {
        // PMID (Bug #1: null safety)
        const pmidElem = articleElem.querySelector("PMID");
        const pmid = pmidElem?.textContent ?? "";

        // Title (Bug #1: null safety)
        const titleElem = articleElem.querySelector("ArticleTitle");
        const title = titleElem?.textContent ?? "";

        // Authors (Bug #3: handle missing forename)
        const authors: string[] = [];
        const authorElements = articleElem.querySelectorAll("Author");
        authorElements.forEach(author => {
          const lastname = author.querySelector("LastName")?.textContent;
          const forename = author.querySelector("ForeName")?.textContent;

          if (forename && lastname) {
            authors.push(`${forename} ${lastname}`);
          } else if (lastname) {
            authors.push(lastname);
          }
        });

        // Journal (Bug #1: null safety)
        const journalElem = articleElem.querySelector("Journal Title");
        const journal = journalElem?.textContent ?? "";

        // Publication date (Bug #4: handle missing month)
        const yearElem = articleElem.querySelector("PubDate Year");
        const monthElem = articleElem.querySelector("PubDate Month");
        const year = yearElem?.textContent ?? "";
        const month = monthElem?.textContent ?? "";
        const pub_date = month ? `${year}-${month}` : year;

        // Abstract (Bug #2: join with space)
        const abstractParts: string[] = [];
        const abstractElements = articleElem.querySelectorAll("AbstractText");
        abstractElements.forEach(elem => {
          const text = elem.textContent;
          if (text) abstractParts.push(text);
        });
        const abstract = abstractParts.join(" ");

        // DOI (Bug #1: null safety)
        let doi = "";
        const articleIdElements = articleElem.querySelectorAll("ArticleId");
        articleIdElements.forEach(elem => {
          if (elem.getAttribute("IdType") === "doi") {
            doi = elem.textContent ?? "";
          }
        });

        articles.push({
          pmid,
          title,
          authors,
          journal,
          pub_date,
          abstract,
          doi
        });
      } catch (error) {
        console.error("Error parsing individual article:", error);
      }
    });

    return articles;
  } catch (error) {
    console.error("Error parsing EFetch XML:", error);
    return [];
  }
}

/**
 * Parse ELink XML response for citation links
 * Bug fixes applied:
 * - #1: Null safety on element accesses
 */
function parseELinkXML(xmlText: string): string[] {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");

    const citingPmids: string[] = [];
    const linkIdElements = doc.querySelectorAll("Link Id");

    linkIdElements.forEach(elem => {
      const text = elem.textContent;
      if (text) citingPmids.push(text);
    });

    return citingPmids;
  } catch (error) {
    console.error("Error parsing ELink XML:", error);
    return [];
  }
}

// =============================================================================
// HTTP UTILITIES WITH CACHING
// =============================================================================

/**
 * Generate cache key from URL and params
 */
function getCacheKey(url: string, params: Record<string, string>): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join("&");
  return `pubmed:${url}:${sortedParams}`;
}

/**
 * Fetch from NCBI E-utilities with retry logic and caching
 * Bug fixes applied:
 * - #6: Manual URLSearchParams encoding
 * - #11: Proper retry loop (0-indexed)
 * - #12: 404 handling returns empty object
 * - #13: Case-insensitive content-type check
 * - #14: Explicit API key check
 */
async function fetchWithRetry(
  url: string,
  params: Record<string, string>,
  apiKey: string | undefined,
  cache: Cache
): Promise<{ xml?: string; text?: string }> {
  // Add API key if available (Bug #14: explicit check)
  if (apiKey && apiKey.length > 0) {
    params.api_key = apiKey;
  }

  // Check cache first
  const cacheKey = getCacheKey(url, params);
  const cacheUrl = new URL(`https://cache.pubmed.mcp/${cacheKey}`);
  const cachedResponse = await cache.match(cacheUrl);

  if (cachedResponse) {
    console.log("Cache hit:", cacheKey);
    return await cachedResponse.json();
  }

  // Bug #6: Manual URL param encoding
  const urlParams = new URLSearchParams(params);
  const fullUrl = `${url}?${urlParams.toString()}`;

  // Bug #11: Proper 0-indexed retry loop
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`PubMed API request (attempt ${attempt + 1}):`, url);
      console.log("Parameters:", params);

      const response = await fetch(fullUrl, {
        method: "GET",
        headers: {
          "User-Agent": "PubMed-MCP-Server/1.0"
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });

      // Bug #12: Handle 404 gracefully
      if (response.status === 404) {
        console.log("No results found for query");
        return {};
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Bug #13: Case-insensitive content-type check
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      let result: { xml?: string; text?: string };

      if (contentType.includes("xml")) {
        const text = await response.text();
        result = { xml: text };
      } else {
        const text = await response.text();
        result = { text };
      }

      // Cache successful response
      const cacheResponse = new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${CACHE_TTL}`
        }
      });
      await cache.put(cacheUrl, cacheResponse);

      return result;

    } catch (error: any) {
      console.error(`Error on attempt ${attempt + 1}:`, error.message);

      if (attempt === MAX_RETRIES - 1) {
        throw error;
      }

      // Exponential backoff: 2^attempt * 1000ms
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  return {};
}

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

/**
 * TOOL 1: Search Articles by Keywords
 * Bug fixes applied:
 * - #8: Proper spacing in query concatenation
 * - #9: Min/max parameter clamping
 */
async function searchArticles(
  params: {
    query: string;
    max_results?: number;
    min_date?: string;
    max_date?: string;
    sort_by?: string;
  },
  apiKey: string | undefined,
  cache: Cache
): Promise<SearchResult> {
  try {
    const maxResults = params.max_results ?? 20;
    const sortBy = params.sort_by ?? "relevance";

    // Bug #8: Proper spacing in concatenation
    let fullQuery = params.query;
    if (params.min_date) {
      fullQuery += ` AND ${params.min_date}[PDAT]`;
    }
    if (params.max_date) {
      fullQuery += ` AND ${params.max_date}[PDAT]`;
    }

    // Bug #9: Min/max clamping
    const clampedMax = Math.min(Math.max(1, maxResults), 100);

    const urlParams: Record<string, string> = {
      db: "pubmed",
      term: fullQuery,
      retmax: clampedMax.toString(),
      retmode: "xml",
      sort: sortBy === "relevance" ? "relevance" : "pub_date"
    };

    const result = await fetchWithRetry(
      `${EUTILS_BASE}/esearch.fcgi`,
      urlParams,
      apiKey,
      cache
    );

    if (result.xml) {
      return parseESearchXML(result.xml);
    }

    return { count: 0, pmids: [], query_translation: "" };
  } catch (error) {
    console.error("Error in searchArticles:", error);
    return { count: 0, pmids: [], query_translation: "" };
  }
}

/**
 * TOOL 2: Get Article Details
 * Bug fixes applied:
 * - #5: Explicit slice with validation
 * - #7: Comma-joined PMID list without spaces
 */
async function getArticleDetails(
  params: {
    pmids: string[];
    include_abstract?: boolean;
  },
  apiKey: string | undefined,
  cache: Cache
): Promise<Article[]> {
  try {
    if (!params.pmids || params.pmids.length === 0) {
      return [];
    }

    const includeAbstract = params.include_abstract ?? true;

    // Bug #5: Explicit slice with validation
    const limitedPmids = params.pmids.slice(0, 200);

    // Bug #7: Comma-joined without spaces
    const pmidString = limitedPmids.join(",");

    const urlParams: Record<string, string> = {
      db: "pubmed",
      id: pmidString,
      retmode: "xml",
      rettype: includeAbstract ? "abstract" : "medline"
    };

    const result = await fetchWithRetry(
      `${EUTILS_BASE}/efetch.fcgi`,
      urlParams,
      apiKey,
      cache
    );

    if (result.xml) {
      return parseEFetchXML(result.xml);
    }

    return [];
  } catch (error) {
    console.error("Error in getArticleDetails:", error);
    return [];
  }
}

/**
 * TOOL 3: Search by Molecular Compound/Drug Name
 * Bug fixes applied:
 * - #8: Proper spacing in query concatenation
 * - #9: Min/max parameter clamping
 * - #10: UTC-based year calculation
 */
async function searchByCompound(
  params: {
    compound_name: string;
    include_synonyms?: boolean;
    max_results?: number;
    years_back?: number;
  },
  apiKey: string | undefined,
  cache: Cache
): Promise<SearchResult> {
  try {
    const includeSynonyms = params.include_synonyms ?? true;
    const maxResults = params.max_results ?? 20;
    const yearsBack = params.years_back ?? 10;

    // Build search query
    let query: string;
    if (includeSynonyms) {
      query = `"${params.compound_name}"[MeSH Terms] OR "${params.compound_name}"[All Fields]`;
    } else {
      query = `"${params.compound_name}"[All Fields]`;
    }

    // Bug #10: UTC-based year calculation
    if (yearsBack > 0) {
      const currentYear = new Date().getUTCFullYear();
      const startYear = currentYear - yearsBack;
      query += ` AND ${startYear}:${currentYear}[PDAT]`;
    }

    // Bug #9: Min/max clamping
    const clampedMax = Math.min(Math.max(1, maxResults), 100);

    const urlParams: Record<string, string> = {
      db: "pubmed",
      term: query,
      retmax: clampedMax.toString(),
      retmode: "xml",
      sort: "relevance"
    };

    const result = await fetchWithRetry(
      `${EUTILS_BASE}/esearch.fcgi`,
      urlParams,
      apiKey,
      cache
    );

    if (result.xml) {
      return parseESearchXML(result.xml);
    }

    return { count: 0, pmids: [], query_translation: "" };
  } catch (error) {
    console.error("Error in searchByCompound:", error);
    return { count: 0, pmids: [], query_translation: "" };
  }
}

/**
 * TOOL 4: Search Clinical Trials
 * Bug fixes applied:
 * - #8: Proper spacing in query concatenation
 * - #9: Min/max parameter clamping
 */
async function searchClinicalTrials(
  params: {
    condition_or_drug: string;
    trial_phase?: string;
    max_results?: number;
  },
  apiKey: string | undefined,
  cache: Cache
): Promise<SearchResult> {
  try {
    const maxResults = params.max_results ?? 20;

    // Build query for clinical trials
    let query = `(${params.condition_or_drug}) AND ("clinical trial"[Publication Type] OR "clinical trial"[All Fields])`;

    if (params.trial_phase) {
      query += ` AND "${params.trial_phase}"[All Fields]`;
    }

    // Bug #9: Min/max clamping
    const clampedMax = Math.min(Math.max(1, maxResults), 100);

    const urlParams: Record<string, string> = {
      db: "pubmed",
      term: query,
      retmax: clampedMax.toString(),
      retmode: "xml",
      sort: "pub_date"
    };

    const result = await fetchWithRetry(
      `${EUTILS_BASE}/esearch.fcgi`,
      urlParams,
      apiKey,
      cache
    );

    if (result.xml) {
      return parseESearchXML(result.xml);
    }

    return { count: 0, pmids: [], query_translation: "" };
  } catch (error) {
    console.error("Error in searchClinicalTrials:", error);
    return { count: 0, pmids: [], query_translation: "" };
  }
}

/**
 * TOOL 5: Search by Author
 * Bug fixes applied:
 * - #8: Proper spacing in query concatenation
 * - #9: Min/max parameter clamping
 */
async function searchByAuthor(
  params: {
    author_name: string;
    affiliation?: string;
    max_results?: number;
  },
  apiKey: string | undefined,
  cache: Cache
): Promise<SearchResult> {
  try {
    const maxResults = params.max_results ?? 50;

    // Build author query
    let query = `"${params.author_name}"[Author]`;

    if (params.affiliation) {
      query += ` AND "${params.affiliation}"[Affiliation]`;
    }

    // Bug #9: Min/max clamping
    const clampedMax = Math.min(Math.max(1, maxResults), 100);

    const urlParams: Record<string, string> = {
      db: "pubmed",
      term: query,
      retmax: clampedMax.toString(),
      retmode: "xml",
      sort: "pub_date"
    };

    const result = await fetchWithRetry(
      `${EUTILS_BASE}/esearch.fcgi`,
      urlParams,
      apiKey,
      cache
    );

    if (result.xml) {
      return parseESearchXML(result.xml);
    }

    return { count: 0, pmids: [], query_translation: "" };
  } catch (error) {
    console.error("Error in searchByAuthor:", error);
    return { count: 0, pmids: [], query_translation: "" };
  }
}

/**
 * TOOL 6: Advanced Boolean Search
 * Bug fixes applied:
 * - #9: Min/max parameter clamping
 * - #16: Preserves exact query syntax
 */
async function advancedBooleanSearch(
  params: {
    query: string;
    max_results?: number;
    sort_by?: string;
  },
  apiKey: string | undefined,
  cache: Cache
): Promise<SearchResult> {
  try {
    const maxResults = params.max_results ?? 20;
    const sortBy = params.sort_by ?? "relevance";

    // Bug #9: Min/max clamping
    const clampedMax = Math.min(Math.max(1, maxResults), 100);

    const urlParams: Record<string, string> = {
      db: "pubmed",
      term: params.query, // Bug #16: Pass query directly, no preprocessing
      retmax: clampedMax.toString(),
      retmode: "xml",
      sort: sortBy === "relevance" ? "relevance" : "pub_date"
    };

    const result = await fetchWithRetry(
      `${EUTILS_BASE}/esearch.fcgi`,
      urlParams,
      apiKey,
      cache
    );

    if (result.xml) {
      return parseESearchXML(result.xml);
    }

    return { count: 0, pmids: [], query_translation: "" };
  } catch (error) {
    console.error("Error in advancedBooleanSearch:", error);
    return { count: 0, pmids: [], query_translation: "" };
  }
}

/**
 * TOOL 7: Get Article Citations
 */
async function getArticleCitations(
  params: {
    pmid: string;
    max_results?: number;
  },
  apiKey: string | undefined,
  cache: Cache
): Promise<string[]> {
  try {
    const maxResults = params.max_results ?? 50;

    const urlParams: Record<string, string> = {
      dbfrom: "pubmed",
      db: "pubmed",
      id: params.pmid,
      linkname: "pubmed_pubmed_citedin",
      retmode: "xml"
    };

    const result = await fetchWithRetry(
      `${EUTILS_BASE}/elink.fcgi`,
      urlParams,
      apiKey,
      cache
    );

    if (result.xml) {
      const citingPmids = parseELinkXML(result.xml);
      return citingPmids.slice(0, maxResults);
    }

    return [];
  } catch (error) {
    console.error("Error in getArticleCitations:", error);
    return [];
  }
}

// =============================================================================
// MCP PROTOCOL HANDLERS
// =============================================================================

/**
 * Define all available tools
 * Bug fix #16: Manual tool registration matching Python names exactly
 */
const TOOLS: Tool[] = [
  {
    name: "search_articles",
    description: "Search PubMed for research articles using keywords. Ideal for finding papers about specific molecules, scaffolds, drug compounds, or medical topics. Returns PMIDs that can be used with other tools to get full details.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms (e.g., 'molecular scaffolding diabetes', 'lisinopril structure')"
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (1-100)",
          default: 20
        },
        min_date: {
          type: "string",
          description: "Minimum publication date (YYYY/MM/DD format)"
        },
        max_date: {
          type: "string",
          description: "Maximum publication date (YYYY/MM/DD format)"
        },
        sort_by: {
          type: "string",
          description: "Sort order - 'relevance' or 'date'",
          enum: ["relevance", "date"],
          default: "relevance"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "get_article_details",
    description: "Get complete details for specific PubMed articles including title, authors, abstract, journal, publication date, and DOI. Use PMIDs from search_articles results.",
    inputSchema: {
      type: "object",
      properties: {
        pmids: {
          type: "array",
          items: { type: "string" },
          description: "List of PubMed IDs (e.g., ['12345678', '87654321'])"
        },
        include_abstract: {
          type: "boolean",
          description: "Whether to include article abstracts",
          default: true
        }
      },
      required: ["pmids"]
    }
  },
  {
    name: "search_by_compound",
    description: "Search for research articles about a specific molecular compound or drug. Optimized for pharmaceutical research including generic names, brand names, and chemical structures.",
    inputSchema: {
      type: "object",
      properties: {
        compound_name: {
          type: "string",
          description: "Name of compound/drug (e.g., 'lisinopril', 'metformin HCl')"
        },
        include_synonyms: {
          type: "boolean",
          description: "Search using MeSH synonyms for better coverage",
          default: true
        },
        max_results: {
          type: "number",
          description: "Maximum results to return",
          default: 20
        },
        years_back: {
          type: "number",
          description: "Only include articles from last N years (0 for all years)",
          default: 10
        }
      },
      required: ["compound_name"]
    }
  },
  {
    name: "search_clinical_trials",
    description: "Search for clinical trial publications in PubMed. Useful for finding evidence of drug efficacy, safety data, and trial outcomes.",
    inputSchema: {
      type: "object",
      properties: {
        condition_or_drug: {
          type: "string",
          description: "Condition being treated or drug being tested"
        },
        trial_phase: {
          type: "string",
          description: "Filter by phase (e.g., 'Phase 1', 'Phase 2', 'Phase 3', 'Phase 4')"
        },
        max_results: {
          type: "number",
          description: "Maximum results to return",
          default: 20
        }
      },
      required: ["condition_or_drug"]
    }
  },
  {
    name: "search_by_author",
    description: "Find all publications by a specific author. Useful for prior art research when you know key researchers in a field.",
    inputSchema: {
      type: "object",
      properties: {
        author_name: {
          type: "string",
          description: "Author's last name and optionally first initial (e.g., 'Smith J')"
        },
        affiliation: {
          type: "string",
          description: "Filter by institution/affiliation"
        },
        max_results: {
          type: "number",
          description: "Maximum results to return",
          default: 50
        }
      },
      required: ["author_name"]
    }
  },
  {
    name: "advanced_boolean_search",
    description: "Perform complex searches using Boolean operators (AND, OR, NOT) and field tags. Ideal for precise prior art searches combining multiple criteria. Example queries: 'scaffold[Title] AND diabetes[MeSH] NOT review[Publication Type]' or '(lisinopril OR enalapril) AND \"ACE inhibitor\"[MeSH]'. Common field tags: [Title], [Title/Abstract], [Author], [Journal], [MeSH], [All Fields], [PDAT] for publication date.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Advanced search query with Boolean operators and field tags"
        },
        max_results: {
          type: "number",
          description: "Maximum results to return",
          default: 20
        },
        sort_by: {
          type: "string",
          description: "Sort order - 'relevance' or 'date'",
          enum: ["relevance", "date"],
          default: "relevance"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "get_article_citations",
    description: "Find articles that cite a specific PMID. Useful for tracking how research has been used and finding related prior art.",
    inputSchema: {
      type: "object",
      properties: {
        pmid: {
          type: "string",
          description: "PubMed ID to find citations for"
        },
        max_results: {
          type: "number",
          description: "Maximum citing articles to return",
          default: 50
        }
      },
      required: ["pmid"]
    }
  }
];

/**
 * Handle MCP protocol requests
 * Bug fix #17: Explicit JSON-RPC envelope wrapping
 */
async function handleMCP(
  request: MCPRequest,
  apiKey: string | undefined,
  cache: Cache
): Promise<MCPResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              resources: {}
            },
            serverInfo: {
              name: "PubMed Research Tools",
              version: "1.0.0"
            }
          }
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS
          }
        };

      case "tools/call": {
        const toolName = params?.name;
        const toolParams = params?.arguments || {};

        let toolResult: any;

        // Route to appropriate tool
        switch (toolName) {
          case "search_articles":
            toolResult = await searchArticles(toolParams, apiKey, cache);
            break;
          case "get_article_details":
            toolResult = await getArticleDetails(toolParams, apiKey, cache);
            break;
          case "search_by_compound":
            toolResult = await searchByCompound(toolParams, apiKey, cache);
            break;
          case "search_clinical_trials":
            toolResult = await searchClinicalTrials(toolParams, apiKey, cache);
            break;
          case "search_by_author":
            toolResult = await searchByAuthor(toolParams, apiKey, cache);
            break;
          case "advanced_boolean_search":
            toolResult = await advancedBooleanSearch(toolParams, apiKey, cache);
            break;
          case "get_article_citations":
            toolResult = await getArticleCitations(toolParams, apiKey, cache);
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }

        // Bug fix #17: Proper MCP response wrapping
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(toolResult, null, 2)
              }
            ]
          }
        };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  } catch (error: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error.message || "Internal error"
      }
    };
  }
}

/**
 * Handle MCP HTTP requests (simple POST → JSON response)
 * Modern HTTP transport - no SSE needed
 */
async function handleMCPRequest(
  request: Request,
  env: Env,
  cache: Cache
): Promise<Response> {
  try {
    const body = await request.json() as MCPRequest;
    const response = await handleMCP(body, env.NCBI_API_KEY, cache);

    return jsonResponse(response);
  } catch (error: any) {
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: error.message || "Parse error"
      }
    };
    return jsonResponse(errorResponse, 400);
  }
}

/**
 * Create JSON response with CORS headers
 */
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

// =============================================================================
// CLOUDFLARE PAGES MIDDLEWARE
// =============================================================================

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const cache = caches.default;

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  // Route: /mcp endpoint (HTTP transport)
  if (url.pathname === "/mcp") {
    // POST: Handle MCP JSON-RPC requests
    if (request.method === "POST") {
      return handleMCPRequest(request, env, cache);
    }

    // GET: Return server info (for discovery/testing)
    if (request.method === "GET") {
      return jsonResponse({
        name: "PubMed Research Tools",
        version: "1.0.0",
        description: "MCP server for PubMed/NCBI pharmaceutical research",
        transport: "HTTP",
        endpoint: "/mcp",
        tools_count: TOOLS.length,
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description
        }))
      });
    }
  }

  // Root endpoint
  if (url.pathname === "/") {
    return jsonResponse({
      service: "PubMed MCP Server",
      status: "running",
      version: "1.0.0",
      transport: "HTTP",
      endpoints: {
        mcp: "/mcp",
        health: "/health"
      },
      tools_count: TOOLS.length,
      api_key_configured: !!(env.NCBI_API_KEY && env.NCBI_API_KEY.length > 0),
      rate_limit: env.NCBI_API_KEY ? "10 req/s (with API key)" : "3 req/s (without API key)"
    });
  }

  // Health check endpoint
  if (url.pathname === "/health") {
    return jsonResponse({ status: "healthy", timestamp: new Date().toISOString() });
  }

  // 404 for unknown routes
  return jsonResponse({ error: "Not found" }, 404);
};
