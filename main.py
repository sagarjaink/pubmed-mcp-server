"""
PubMed MCP Server optimized for pharmaceutical patent research.
Focus: Molecular scaffolding and prior art discovery.
Transport: HTTP (Streamable) for Claude.ai compatibility
Endpoint: /mcp
"""

import os
import httpx
import logging
from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field
from fastmcp import FastMCP

# Configure logging for Cloud Run
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s %(message)s'
)
log = logging.getLogger("pubmed_mcp")

# FastMCP setup
mcp = FastMCP(
    "PubMed Research Tools",
    instructions="Search and retrieve biomedical research articles from PubMed/NCBI for pharmaceutical patent research and molecular scaffolding analysis"
)

# Configuration
EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
API_KEY = os.environ.get("NCBI_API_KEY", "")
TIMEOUT = 30
MAX_RETRIES = 3

# Rate limiting: 10 req/sec with API key, 3 req/sec without
RATE_LIMIT = "api_key=" + API_KEY if API_KEY else ""

class Article(BaseModel):
    pmid: str
    title: str
    authors: List[str]
    journal: str
    pub_date: str
    abstract: str = ""
    doi: str = ""
    
class SearchResult(BaseModel):
    count: int
    pmids: List[str]
    query_translation: str = ""

async def _fetch_with_retry(url: str, params: dict) -> dict:
    """Fetch from NCBI E-utilities with retry logic"""
    if API_KEY:
        params["api_key"] = API_KEY
    
    for attempt in range(MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                log.info(f"PubMed API request (attempt {attempt + 1}): {url}")
                log.info(f"Parameters: {params}")
                
                response = await client.get(url, params=params)
                
                if response.status_code == 404:
                    log.info(f"No results found for query")
                    return {}
                
                response.raise_for_status()
                
                # Handle XML response
                if 'xml' in response.headers.get('content-type', ''):
                    return {"xml": response.text}
                
                # Try JSON response
                try:
                    return response.json()
                except:
                    return {"text": response.text}
                    
        except httpx.TimeoutException:
            log.warning(f"Timeout on attempt {attempt + 1}")
            if attempt == MAX_RETRIES - 1:
                raise
        except Exception as e:
            log.error(f"Error on attempt {attempt + 1}: {str(e)}")
            if attempt == MAX_RETRIES - 1:
                raise
    
    return {}

def _parse_esearch_xml(xml_text: str) -> SearchResult:
    """Parse ESearch XML response"""
    import xml.etree.ElementTree as ET
    
    try:
        root = ET.fromstring(xml_text)
        
        count = int(root.find('.//Count').text or 0)
        pmids = [id_elem.text for id_elem in root.findall('.//Id')]
        
        query_trans = ""
        trans_elem = root.find('.//QueryTranslation')
        if trans_elem is not None:
            query_trans = trans_elem.text or ""
        
        return SearchResult(
            count=count,
            pmids=pmids,
            query_translation=query_trans
        )
    except Exception as e:
        log.error(f"Error parsing ESearch XML: {e}")
        return SearchResult(count=0, pmids=[], query_translation="")

def _parse_efetch_xml(xml_text: str) -> List[Article]:
    """Parse EFetch XML response for PubmedArticle"""
    import xml.etree.ElementTree as ET
    
    articles = []
    
    try:
        root = ET.fromstring(xml_text)
        
        for article_elem in root.findall('.//PubmedArticle'):
            try:
                # PMID
                pmid_elem = article_elem.find('.//PMID')
                pmid = pmid_elem.text if pmid_elem is not None else ""
                
                # Title
                title_elem = article_elem.find('.//ArticleTitle')
                title = title_elem.text if title_elem is not None else ""
                
                # Authors
                authors = []
                for author in article_elem.findall('.//Author'):
                    lastname = author.find('.//LastName')
                    forename = author.find('.//ForeName')
                    if lastname is not None and forename is not None:
                        authors.append(f"{forename.text} {lastname.text}")
                    elif lastname is not None:
                        authors.append(lastname.text)
                
                # Journal
                journal_elem = article_elem.find('.//Journal/Title')
                journal = journal_elem.text if journal_elem is not None else ""
                
                # Publication date
                year_elem = article_elem.find('.//PubDate/Year')
                month_elem = article_elem.find('.//PubDate/Month')
                year = year_elem.text if year_elem is not None else ""
                month = month_elem.text if month_elem is not None else ""
                pub_date = f"{year}-{month}" if month else year
                
                # Abstract
                abstract_parts = []
                for abstract_text in article_elem.findall('.//AbstractText'):
                    if abstract_text.text:
                        abstract_parts.append(abstract_text.text)
                abstract = " ".join(abstract_parts)
                
                # DOI
                doi = ""
                for article_id in article_elem.findall('.//ArticleId'):
                    if article_id.get('IdType') == 'doi':
                        doi = article_id.text
                        break
                
                articles.append(Article(
                    pmid=pmid,
                    title=title,
                    authors=authors,
                    journal=journal,
                    pub_date=pub_date,
                    abstract=abstract,
                    doi=doi
                ))
                
            except Exception as e:
                log.error(f"Error parsing individual article: {e}")
                continue
        
        return articles
        
    except Exception as e:
        log.error(f"Error parsing EFetch XML: {e}")
        return []

# =============================================================================
# TOOL 1: Search Articles by Keywords
# =============================================================================
@mcp.tool(
    name="search_articles",
    description="Search PubMed for research articles using keywords. Ideal for finding papers about specific molecules, scaffolds, drug compounds, or medical topics. Returns PMIDs that can be used with other tools to get full details."
)
async def search_articles(
    query: str,
    max_results: int = 20,
    min_date: Optional[str] = None,
    max_date: Optional[str] = None,
    sort_by: str = "relevance"
) -> SearchResult:
    """
    Search PubMed articles by keywords.
    
    Args:
        query: Search terms (e.g., "molecular scaffolding diabetes", "lisinopril structure")
        max_results: Maximum number of results to return (1-100)
        min_date: Minimum publication date (YYYY/MM/DD format)
        max_date: Maximum publication date (YYYY/MM/DD format)
        sort_by: Sort order - "relevance" or "date"
    
    Returns:
        SearchResult with count, PMIDs, and query translation
    """
    # Build query with date filters
    full_query = query
    if min_date:
        full_query += f" AND {min_date}[PDAT]"
    if max_date:
        full_query += f" AND {max_date}[PDAT]"
    
    params = {
        "db": "pubmed",
        "term": full_query,
        "retmax": min(max(1, max_results), 100),
        "retmode": "xml",
        "sort": "relevance" if sort_by == "relevance" else "pub_date"
    }
    
    result = await _fetch_with_retry(f"{EUTILS_BASE}/esearch.fcgi", params)
    
    if "xml" in result:
        return _parse_esearch_xml(result["xml"])
    
    return SearchResult(count=0, pmids=[], query_translation="")

# =============================================================================
# TOOL 2: Get Article Details
# =============================================================================
@mcp.tool(
    name="get_article_details",
    description="Get complete details for specific PubMed articles including title, authors, abstract, journal, publication date, and DOI. Use PMIDs from search_articles results."
)
async def get_article_details(
    pmids: List[str],
    include_abstract: bool = True
) -> List[Article]:
    """
    Retrieve full article details for one or more PMIDs.
    
    Args:
        pmids: List of PubMed IDs (e.g., ["12345678", "87654321"])
        include_abstract: Whether to include article abstracts
    
    Returns:
        List of Article objects with full details
    """
    if not pmids:
        return []
    
    # Limit to 200 PMIDs per request
    pmids = pmids[:200]
    
    params = {
        "db": "pubmed",
        "id": ",".join(pmids),
        "retmode": "xml",
        "rettype": "abstract" if include_abstract else "medline"
    }
    
    result = await _fetch_with_retry(f"{EUTILS_BASE}/efetch.fcgi", params)
    
    if "xml" in result:
        return _parse_efetch_xml(result["xml"])
    
    return []

# =============================================================================
# TOOL 3: Search by Molecular Compound/Drug Name
# =============================================================================
@mcp.tool(
    name="search_by_compound",
    description="Search for research articles about a specific molecular compound or drug. Optimized for pharmaceutical research including generic names, brand names, and chemical structures."
)
async def search_by_compound(
    compound_name: str,
    include_synonyms: bool = True,
    max_results: int = 20,
    years_back: int = 10
) -> SearchResult:
    """
    Search PubMed for articles about a specific compound/drug.
    
    Args:
        compound_name: Name of compound/drug (e.g., "lisinopril", "metformin HCl")
        include_synonyms: Search using MeSH synonyms for better coverage
        max_results: Maximum results to return
        years_back: Only include articles from last N years (0 for all years)
    
    Returns:
        SearchResult with PMIDs related to the compound
    """
    # Build search query
    if include_synonyms:
        # Use MeSH term search for synonyms
        query = f'"{compound_name}"[MeSH Terms] OR "{compound_name}"[All Fields]'
    else:
        query = f'"{compound_name}"[All Fields]'
    
    # Add date filter if specified
    if years_back > 0:
        current_year = datetime.now().year
        start_year = current_year - years_back
        query += f" AND {start_year}:{current_year}[PDAT]"
    
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": min(max(1, max_results), 100),
        "retmode": "xml",
        "sort": "relevance"
    }
    
    result = await _fetch_with_retry(f"{EUTILS_BASE}/esearch.fcgi", params)
    
    if "xml" in result:
        return _parse_esearch_xml(result["xml"])
    
    return SearchResult(count=0, pmids=[], query_translation="")

# =============================================================================
# TOOL 4: Search Clinical Trials
# =============================================================================
@mcp.tool(
    name="search_clinical_trials",
    description="Search for clinical trial publications in PubMed. Useful for finding evidence of drug efficacy, safety data, and trial outcomes."
)
async def search_clinical_trials(
    condition_or_drug: str,
    trial_phase: Optional[str] = None,
    max_results: int = 20
) -> SearchResult:
    """
    Search for clinical trial publications.
    
    Args:
        condition_or_drug: Condition being treated or drug being tested
        trial_phase: Filter by phase (e.g., "Phase 1", "Phase 2", "Phase 3", "Phase 4")
        max_results: Maximum results to return
    
    Returns:
        SearchResult with PMIDs of clinical trial publications
    """
    # Build query for clinical trials
    query = f'({condition_or_drug}) AND ("clinical trial"[Publication Type] OR "clinical trial"[All Fields])'
    
    if trial_phase:
        query += f' AND "{trial_phase}"[All Fields]'
    
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": min(max(1, max_results), 100),
        "retmode": "xml",
        "sort": "pub_date"
    }
    
    result = await _fetch_with_retry(f"{EUTILS_BASE}/esearch.fcgi", params)
    
    if "xml" in result:
        return _parse_esearch_xml(result["xml"])
    
    return SearchResult(count=0, pmids=[], query_translation="")

# =============================================================================
# TOOL 5: Search by Author
# =============================================================================
@mcp.tool(
    name="search_by_author",
    description="Find all publications by a specific author. Useful for prior art research when you know key researchers in a field."
)
async def search_by_author(
    author_name: str,
    affiliation: Optional[str] = None,
    max_results: int = 50
) -> SearchResult:
    """
    Search for articles by author name.
    
    Args:
        author_name: Author's last name and optionally first initial (e.g., "Smith J")
        affiliation: Filter by institution/affiliation
        max_results: Maximum results to return
    
    Returns:
        SearchResult with author's publications
    """
    # Build author query
    query = f'"{author_name}"[Author]'
    
    if affiliation:
        query += f' AND "{affiliation}"[Affiliation]'
    
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": min(max(1, max_results), 100),
        "retmode": "xml",
        "sort": "pub_date"
    }
    
    result = await _fetch_with_retry(f"{EUTILS_BASE}/esearch.fcgi", params)
    
    if "xml" in result:
        return _parse_esearch_xml(result["xml"])
    
    return SearchResult(count=0, pmids=[], query_translation="")

# =============================================================================
# TOOL 6: Advanced Boolean Search
# =============================================================================
@mcp.tool(
    name="advanced_boolean_search",
    description="Perform complex searches using Boolean operators (AND, OR, NOT) and field tags. Ideal for precise prior art searches combining multiple criteria."
)
async def advanced_boolean_search(
    query: str,
    max_results: int = 20,
    sort_by: str = "relevance"
) -> SearchResult:
    """
    Advanced PubMed search with Boolean operators and field tags.
    
    Query Examples:
    - 'scaffold[Title] AND diabetes[MeSH] NOT review[Publication Type]'
    - '(lisinopril OR enalapril) AND "ACE inhibitor"[MeSH]'
    - 'molecular structure[Title/Abstract] AND 2015:2020[PDAT]'
    
    Common Field Tags:
    - [Title] - Search in article title
    - [Title/Abstract] - Search in title or abstract
    - [Author] - Search by author name
    - [Journal] - Search by journal name
    - [MeSH] - Medical Subject Headings (controlled vocabulary)
    - [All Fields] - Search all fields
    - [PDAT] - Publication date (format: YYYY or YYYY:YYYY for range)
    
    Args:
        query: Advanced search query with Boolean operators and field tags
        max_results: Maximum results to return
        sort_by: Sort order - "relevance" or "date"
    
    Returns:
        SearchResult with PMIDs matching the complex query
    """
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": min(max(1, max_results), 100),
        "retmode": "xml",
        "sort": "relevance" if sort_by == "relevance" else "pub_date"
    }
    
    result = await _fetch_with_retry(f"{EUTILS_BASE}/esearch.fcgi", params)
    
    if "xml" in result:
        return _parse_esearch_xml(result["xml"])
    
    return SearchResult(count=0, pmids=[], query_translation="")

# =============================================================================
# TOOL 7: Get Article Citations (Links)
# =============================================================================
@mcp.tool(
    name="get_article_citations",
    description="Find articles that cite a specific PMID. Useful for tracking how research has been used and finding related prior art."
)
async def get_article_citations(
    pmid: str,
    max_results: int = 50
) -> List[str]:
    """
    Find articles that cite a given PMID using PubMed's citation network.
    
    Args:
        pmid: PubMed ID to find citations for
        max_results: Maximum citing articles to return
    
    Returns:
        List of PMIDs that cite the original article
    """
    # Use ELink to find citing articles
    params = {
        "dbfrom": "pubmed",
        "db": "pubmed",
        "id": pmid,
        "linkname": "pubmed_pubmed_citedin",
        "retmode": "xml"
    }
    
    result = await _fetch_with_retry(f"{EUTILS_BASE}/elink.fcgi", params)
    
    if "xml" in result:
        import xml.etree.ElementTree as ET
        try:
            root = ET.fromstring(result["xml"])
            citing_pmids = [id_elem.text for id_elem in root.findall('.//Link/Id')]
            return citing_pmids[:max_results]
        except Exception as e:
            log.error(f"Error parsing citation links: {e}")
    
    return []

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    log.info(f"Starting PubMed MCP server on port {port}")
    log.info(f"API Key configured: {'Yes' if API_KEY else 'No - Rate limited to 3 req/sec'}")
    
    mcp.run(
        transport="streamable-http",
        host="0.0.0.0",
        port=port,
        path="/mcp",
        log_level="info"
    )