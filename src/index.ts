import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const agent = await createAgent({
  name: 'trends-aggregator',
  version: '1.0.0',
  description: 'Real-time trending topics aggregated from X, HackerNews, and CoinGecko. Multi-source social signals for AI agents.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON with error handling ===
async function fetchJSON(url: string, options?: RequestInit) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'TrendsAggregator/1.0 (AI Agent)',
      ...options?.headers,
    },
  });
  if (!response.ok) throw new Error(`API error: ${response.status} ${response.statusText}`);
  return response.json();
}

// === DATA FETCHERS ===

async function fetchXTrends(): Promise<Array<{ rank: number; topic: string; category: string; related: string[] }>> {
  // Scrape X trends from the explore page
  try {
    const response = await fetch('https://x.com/explore/tabs/trending', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    const html = await response.text();
    
    // Extract trends from the HTML using regex patterns
    const trends: Array<{ rank: number; topic: string; category: string; related: string[] }> = [];
    const trendMatches = html.matchAll(/data-testid="trend"[^>]*>([^<]+)/g);
    let rank = 1;
    for (const match of trendMatches) {
      if (rank <= 20) {
        trends.push({
          rank,
          topic: match[1].trim(),
          category: 'trending',
          related: [],
        });
        rank++;
      }
    }
    
    // If scraping fails, return placeholder indicating live fetch attempted
    if (trends.length === 0) {
      return [{ rank: 1, topic: 'X API requires authentication', category: 'notice', related: [] }];
    }
    return trends;
  } catch (error) {
    return [{ rank: 1, topic: 'X trends temporarily unavailable', category: 'error', related: [] }];
  }
}

async function fetchHackerNews(limit: number = 30): Promise<Array<{ rank: number; title: string; score: number; url: string; id: number }>> {
  const topIds = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json') as number[];
  const storyIds = topIds.slice(0, limit);
  
  const stories = await Promise.all(
    storyIds.map(async (id, index) => {
      const story = await fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`) as {
        title: string;
        score: number;
        url?: string;
        id: number;
      };
      return {
        rank: index + 1,
        title: story.title,
        score: story.score,
        url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
        id: story.id,
      };
    })
  );
  
  return stories;
}

async function fetchCoinGeckoTrending(): Promise<{
  coins: Array<{ name: string; symbol: string; rank: number; thumb: string }>;
  nfts: Array<{ name: string; symbol: string; thumb: string }>;
}> {
  const data = await fetchJSON('https://api.coingecko.com/api/v3/search/trending') as {
    coins: Array<{ item: { name: string; symbol: string; market_cap_rank: number; thumb: string } }>;
    nfts: Array<{ name: string; symbol: string; thumb: string }>;
  };
  
  return {
    coins: data.coins.map(c => ({
      name: c.item.name,
      symbol: c.item.symbol,
      rank: c.item.market_cap_rank,
      thumb: c.item.thumb,
    })),
    nfts: (data.nfts || []).slice(0, 5).map(n => ({
      name: n.name,
      symbol: n.symbol,
      thumb: n.thumb,
    })),
  };
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - top 3 trends from each source (X, HackerNews, CoinGecko)',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [xTrends, hnStories, crypto] = await Promise.all([
      fetchXTrends(),
      fetchHackerNews(3),
      fetchCoinGeckoTrending(),
    ]);
    
    return {
      output: {
        x: xTrends.slice(0, 3),
        hackernews: hnStories.slice(0, 3),
        crypto: {
          coins: crypto.coins.slice(0, 3),
          nfts: crypto.nfts.slice(0, 3),
        },
        fetchedAt: new Date().toISOString(),
        sources: ['X/Twitter', 'HackerNews', 'CoinGecko'],
      },
    };
  },
});

// === PAID ENDPOINT 1: HackerNews ($0.001) ===
addEntrypoint({
  key: 'hackernews',
  description: 'Top HackerNews stories with scores and URLs',
  input: z.object({
    limit: z.number().min(1).max(50).optional().default(20),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const stories = await fetchHackerNews(ctx.input.limit);
    return {
      output: {
        stories,
        count: stories.length,
        fetchedAt: new Date().toISOString(),
        source: 'https://news.ycombinator.com',
      },
    };
  },
});

// === PAID ENDPOINT 2: Crypto Trending ($0.002) ===
addEntrypoint({
  key: 'crypto',
  description: 'Trending cryptocurrencies and NFTs from CoinGecko',
  input: z.object({}),
  price: { amount: 2000 },
  handler: async () => {
    const trending = await fetchCoinGeckoTrending();
    return {
      output: {
        coins: trending.coins,
        nfts: trending.nfts,
        totalCoins: trending.coins.length,
        totalNfts: trending.nfts.length,
        fetchedAt: new Date().toISOString(),
        source: 'https://www.coingecko.com',
      },
    };
  },
});

// === PAID ENDPOINT 3: X Trends ($0.002) ===
addEntrypoint({
  key: 'twitter',
  description: 'Current X/Twitter trending topics',
  input: z.object({
    limit: z.number().min(1).max(50).optional().default(20),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const trends = await fetchXTrends();
    return {
      output: {
        trends: trends.slice(0, ctx.input.limit),
        count: Math.min(trends.length, ctx.input.limit),
        fetchedAt: new Date().toISOString(),
        source: 'X/Twitter',
      },
    };
  },
});

// === PAID ENDPOINT 4: All Sources ($0.003) ===
addEntrypoint({
  key: 'all',
  description: 'Complete trends from all sources aggregated',
  input: z.object({
    limit: z.number().min(1).max(30).optional().default(20),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const [xTrends, hnStories, crypto] = await Promise.all([
      fetchXTrends(),
      fetchHackerNews(ctx.input.limit),
      fetchCoinGeckoTrending(),
    ]);
    
    return {
      output: {
        x: {
          trends: xTrends.slice(0, ctx.input.limit),
          count: Math.min(xTrends.length, ctx.input.limit),
        },
        hackernews: {
          stories: hnStories,
          count: hnStories.length,
        },
        crypto: {
          coins: crypto.coins,
          nfts: crypto.nfts,
          totalCoins: crypto.coins.length,
          totalNfts: crypto.nfts.length,
        },
        fetchedAt: new Date().toISOString(),
        sources: ['X/Twitter', 'HackerNews', 'CoinGecko'],
      },
    };
  },
});

// === PAID ENDPOINT 5: Cross-Platform Analysis ($0.005) ===
addEntrypoint({
  key: 'analyze',
  description: 'Cross-platform trend analysis - find topics trending on multiple sources',
  input: z.object({
    keywords: z.array(z.string()).optional().default([]),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const [xTrends, hnStories, crypto] = await Promise.all([
      fetchXTrends(),
      fetchHackerNews(30),
      fetchCoinGeckoTrending(),
    ]);
    
    // Extract keywords from each source
    const xKeywords = xTrends.map(t => t.topic.toLowerCase());
    const hnKeywords = hnStories.flatMap(s => s.title.toLowerCase().split(' '));
    const cryptoKeywords = crypto.coins.map(c => c.name.toLowerCase());
    
    // Find overlapping topics
    const allKeywords = [...xKeywords, ...hnKeywords, ...cryptoKeywords];
    const keywordCounts = new Map<string, { count: number; sources: string[] }>();
    
    for (const kw of allKeywords) {
      if (kw.length < 3) continue;
      const existing = keywordCounts.get(kw) || { count: 0, sources: [] };
      existing.count++;
      if (xKeywords.includes(kw) && !existing.sources.includes('X')) existing.sources.push('X');
      if (hnKeywords.includes(kw) && !existing.sources.includes('HN')) existing.sources.push('HN');
      if (cryptoKeywords.includes(kw) && !existing.sources.includes('Crypto')) existing.sources.push('Crypto');
      keywordCounts.set(kw, existing);
    }
    
    // Sort by multi-platform presence
    const crossPlatform = Array.from(keywordCounts.entries())
      .filter(([_, v]) => v.sources.length > 1)
      .sort((a, b) => b[1].sources.length - a[1].sources.length || b[1].count - a[1].count)
      .slice(0, 10)
      .map(([keyword, data]) => ({ keyword, ...data }));
    
    // Top trending by source
    const summary = {
      topX: xTrends.slice(0, 5).map(t => t.topic),
      topHN: hnStories.slice(0, 5).map(s => s.title),
      topCrypto: crypto.coins.slice(0, 5).map(c => `${c.name} (${c.symbol})`),
    };
    
    // Filter by user-provided keywords if any
    let filtered = null;
    if (ctx.input.keywords.length > 0) {
      filtered = ctx.input.keywords.map(kw => {
        const kwLower = kw.toLowerCase();
        return {
          keyword: kw,
          onX: xTrends.some(t => t.topic.toLowerCase().includes(kwLower)),
          onHN: hnStories.some(s => s.title.toLowerCase().includes(kwLower)),
          onCrypto: crypto.coins.some(c => c.name.toLowerCase().includes(kwLower) || c.symbol.toLowerCase().includes(kwLower)),
        };
      });
    }
    
    return {
      output: {
        crossPlatformTopics: crossPlatform,
        summary,
        keywordAnalysis: filtered,
        fetchedAt: new Date().toISOString(),
        methodology: 'Keywords extracted and compared across X, HackerNews, and CoinGecko trending data',
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🔥 Trends Aggregator running on port ${port}`);
console.log(`📊 Endpoints: overview (free), hackernews, crypto, twitter, all, analyze`);

export default { port, fetch: app.fetch };
