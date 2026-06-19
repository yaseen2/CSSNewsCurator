import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL) {
  console.log('[+] Redis TCP connection URL found. Cloud database storage is ENABLED.');
} else {
  console.log('[!] No REDIS_URL environment variable found. Falling back to local file storage.');
}

/**
 * Fetch a value from Redis using standard TCP connection
 * @param {string} key 
 * @returns {Promise<any|null>} Parsed JSON object, or null if key does not exist or Redis is unconfigured
 */
export async function getRedisKey(key) {
  if (!REDIS_URL) {
    return null;
  }
  
  const client = createClient({ url: REDIS_URL });
  client.on('error', () => {}); // Silently ignore connection error logs here
  
  try {
    await client.connect();
    const value = await client.get(key);
    await client.disconnect();
    
    if (value === null) {
      return null;
    }
    return JSON.parse(value);
  } catch (err) {
    console.error(`[-] Redis GET error for key "${key}":`, err.message);
    try {
      await client.disconnect();
    } catch (_) {}
  }
  return null;
}

/**
 * Set a key value in Redis using standard TCP connection
 * @param {string} key 
 * @param {any} value 
 * @returns {Promise<boolean>} Success status
 */
export async function setRedisKey(key, value) {
  if (!REDIS_URL) {
    return false;
  }
  
  const client = createClient({ url: REDIS_URL });
  client.on('error', () => {});
  
  try {
    await client.connect();
    await client.set(key, JSON.stringify(value));
    await client.disconnect();
    return true;
  } catch (err) {
    console.error(`[-] Redis SET error for key "${key}":`, err.message);
    try {
      await client.disconnect();
    } catch (_) {}
    return false;
  }
}
