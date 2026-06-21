require('dotenv').config();
const express = require("express");
const { createClient } = require("redis");
const { LRUCache } = require("lru-cache");
const HashRing = require("hashring");
const { Pool } = require("pg"); 
const app = express();

app.use(express.json());

const port = 3000;

const localLRUCache = new LRUCache({
  max: 1000,
  ttl: 1000 * 30,
});

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_LOCAL,
  port: 5432
});

const TRENDING_KEY = "cache:global:trending";

const redisNodes = ['redis1:6379', 'redis2:6379', 'redis3:6379'];

const clusterClients = {}; 

const getRedisClient = (key) => clusterClients[hashring.get(key)];

const hashring = new HashRing(redisNodes);

app.get("/api/suggest", async (req, res) => {
  
  const prefix = req.query.q?.toLowerCase();

  const userId = req.header("X-User-Id");
  
  if(!prefix || prefix.length < 3) {
    
    const userTrendingKey = `trending:${userId}:${prefix || ''}`;

    const localCacheResult = localLRUCache.get(userTrendingKey);

    if(localCacheResult) return res.json(localCacheResult);

    const trendingNode = hashring.get(userTrendingKey);

    const trendingClient = clusterClients[trendingNode];

    try {

      const redisCacheResult = await trendingClient.get(userTrendingKey);
      
      if(redisCacheResult) {

        const parsedResult = JSON.parse(redisCacheResult);

        localLRUCache.set(userTrendingKey, parsedResult);

        return res.json(parsedResult);
      }

      const dbResult = await getPersonlizedSuggestions(userId, prefix);

      if(dbResult && dbResult.length > 0) {

        await trendingClient.set(
          userTrendingKey,
          JSON.stringify(dbResult),
          {
            EX: 300 // Cache personalized trending for only 5 minutes
          }
        );

        localLRUCache.set(userTrendingKey, dbResult);

      }

      return res.json(dbResult);

    } catch (error) {
      
      console.log("Cache Routing Failed ", error);
      
      return res.status(500).json({ error: "Internal Server Error" });
    }    
     
  }
    
  const localCacheResult = localLRUCache.get(prefix);
  
  if(localCacheResult) return res.json(localCacheResult);

  const cacheKey = `prefix:${prefix}`;
  
  const cacheNode = hashring.get(cacheKey);

  const cacheClient = clusterClients[cacheNode];

  try {

    const cacheResult = await cacheClient.get(cacheKey);

    if(cacheResult && cacheResult.length > 0) {

      const parsedResult = JSON.parse(cacheResult);

      localLRUCache.set(prefix, parsedResult);

      return res.json(parsedResult);
    }

    const dbResult = await querySuggestDatabase(prefix);
    
    if(dbResult) {

      await cacheClient.set(
        cacheKey,
        JSON.stringify(dbResult),
        {
          EX: 3600
        }
      );

      localLRUCache.set(prefix, dbResult);

      return res.json(dbResult);
    }

  } catch (error) {
    console.log("Error while fetching data...", error);
  }

  return res.json([]);

});

app.post("/api/search", async (req, res) => {
  
  const { query } = req.body;
  
  const normalizedQuery = query?.toLowerCase().trim();

  if(!normalizedQuery) return res.status(400).json({ error: "Search Query cannot be empty" });
  
  try {
    
    await getRedisClient("search_deltas").hIncrBy(
      "search_deltas",
      normalizedQuery,
      1
    );
    
    const userId = req.header("X-User-Id");
    const redisKey = `user:${userId}:searches`;
    const redis = getRedisClient(redisKey);
    await redis.zIncrBy(redisKey, 1, normalizedQuery);
    await redis.expire(redisKey, 30 * 24 * 60 * 60); // 30 day ttl

    return res.status(200).json({ success: true });

  } catch (error) {

    console.log(`Error while incrementing Redis Counter, ${error}`);
  
  }
});

async function initializeServers() {
  
  for (const node of redisNodes) {
    const client = createClient({ url: `redis://${node}`});
    client.on('error', err => console.log(`Redis Client: ${node} error`, err));
    await client.connect();
    clusterClients[node] = client;
  }

}

async function querySuggestDatabase(prefix) {

  try {

    const result = await pool.query(
      `
        SELECT final_search_term AS value, MAX(popularity) AS popularity FROM queries 
        WHERE prefixes ? $1
        GROUP BY final_search_term
        ORDER BY popularity DESC LIMIT 10;
      `, [prefix]
    );

    return result.rows;
    
  } catch (error) {

    console.log("Error fetching query from DB ", error);

  }
}

async function queryTrendingDatabase() {

  try {

    const result = await pool.query(
      `
        SELECT final_search_term AS value, MAX(popularity) AS popularity FROM queries 
        GROUP BY final_search_term
        ORDER BY popularity DESC LIMIT 10;
      `
    );

    return result.rows;

  } catch (error) {
    
    console.log("Error fetching query from DB ", error);

  } 
}

async function processSearchLogs() {

  let client;

  try {
    
    console.time("batch"); 

    const deltas = await getRedisClient("search_deltas").hGetAll("search_deltas");
    
    client = await pool.connect(); 
 
    await client.query('BEGIN');

    for (const [term, delta] of Object.entries(deltas)) {
      await client.query(`
        UPDATE queries 
        SET popularity = popularity + $1
        WHERE final_search_term = $2
      `, [delta, term]);
    }

    await client.query('COMMIT');

    await getRedisClient("search_deltas").del("search_deltas");

  } catch (error) {

    if(client) await client.query('ROLLBACK');

  } finally {

    if(client) client.release();

    console.timeEnd("batch");

  }
   
}

async function getPersonlizedSuggestions(userId, prefix) {
  try {
    let globalItems = [];
    if(!prefix) {
      const dbResult = await pool.query(
        `
        SELECT final_search_term AS value, MAX(popularity) AS popularity
        FROM queries 
        GROUP BY final_search_term
        ORDER BY popularity DESC LIMIT 50;
        `
      );
      globalItems = dbResult.rows;
    } else {
      const dbResult = await pool.query(
        `
        SELECT final_search_term AS value, MAX(popularity) AS popularity
        FROM queries 
        WHERE final_search_term ILIKE $1 || '%'
        GROUP BY final_search_term
        ORDER BY popularity DESC LIMIT 50
        `, [prefix]
      );
      globalItems = dbResult.rows;
    }

    const redisKey = `user:${userId}:searches`;
    const redis = getRedisClient(redisKey);
    let userItems = [];
    try {
      userItems = await redis.zRangeWithScores(redisKey, 0, 49, { REV: true }) || [];
    } catch (err) {
      console.log("Error reading user history from Redis: ", err);
    }
  
    // If user has no matching history at all, return top 10 global items
    if(userItems.length === 0) return globalItems.slice(0, 10);

    if(prefix && userItems.length > 0) {
      userItems = userItems.filter(item => item.value?.toLowerCase().startsWith(prefix));
    }
    
    // map for global popularity and user popularity
    const itemMap = new Map();
    globalItems.forEach(item => {
      itemMap.set(item.value, {
        global: Number(item.popularity),
        user: 0
      });
    });

    userItems.forEach(item => {
      if (itemMap.has(item.value)) {
        itemMap.get(item.value).user = Number(item.score);
      } else {
        itemMap.set(item.value, {
          global: 0,
          user: Number(item.score)
        });
      }
    });

    let maxGlobal = 0;
    let maxUser = 0;

    for (const stats of itemMap.values()) {
      if (stats.global > maxGlobal) maxGlobal = stats.global;
      if (stats.user > maxUser) maxUser = stats.user;
    }

    // calculate the normalized scores 
    const unionList = [];
    for (const [value, stats] of itemMap.entries()) {
      const normGlobal = maxGlobal > 0 ? stats.global / maxGlobal : 0;
      const normUser = maxUser > 0 ? stats.user / maxUser : 0;
      const score = 0.8 * normGlobal + 0.2 * normUser;
      unionList.push({ value, score });
    }

    unionList.sort((a, b) => b.score - a.score);

    return unionList.slice(0, 10).map(item => ({
      value: item.value,
      popularity: Math.round(item.score * 100000)
    }));
  } catch (error) {
    console.log("Error generating personlized suggestions: ", error);
    return [];
  }
}




(async () => {

  try {

    console.log("Starting application components...");

    await initializeServers();

    console.log("Application online");

    // Updates Every 5 minutes
    async function scheduleNextSearchLogs() {
      try {
        await processSearchLogs();
      } finally {
        setTimeout(scheduleNextSearchLogs, 1000 * 60 * 5); 
      }
    }

    scheduleNextSearchLogs();

    app.listen(port, () => {
      console.log(`Server started at port: ${port}`);
    });

  } catch (error) {
    
    console.error("Critical Initializion Failure", error);

    process.exit(1);

  }

})()
