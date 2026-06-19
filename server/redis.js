import axios from 'axios';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (REDIS_URL && REDIS_TOKEN) {
  console.log('[+] Redis configuration found. Cloud database storage is ENABLED.');
} else {
  console.log('[!] No Redis environment variables found. Falling back to local file storage.');
}

/**
 * Fetch a value from Upstash Redis via REST API
 * @param {string} key 
 * @returns {Promise<any|null>} Parsed JSON object, or null if key does not exist or Redis is unconfigured
 */
export async function getRedisKey(key) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return null;
  }
  
  try {
    const cleanUrl = REDIS_URL.replace(/\/$/, "");
    const res = await axios.get(`${cleanUrl}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      timeout: 10000
    });
    
    if (res.data && res.data.result !== undefined) {
      if (res.data.result === null) {
        return null;
      }
      // Upstash REST API returns values as strings. If it was double stringified, we parse it.
      return JSON.parse(res.data.result);
    }
  } catch (err) {
    console.error(`[-] Redis GET error for key "${key}":`, err.message);
  }
  return null;
}

/**
 * Set a key value in Upstash Redis via REST API
 * @param {string} key 
 * @param {any} value 
 * @returns {Promise<boolean>} Success status
 */
export async function setRedisKey(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return false;
  }
  
  try {
    const cleanUrl = REDIS_URL.replace(/\/$/, "");
    const payload = JSON.stringify(value);
    
    const res = await axios.post(`${cleanUrl}/set/${key}`, payload, {
      headers: { 
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    
    return res.data && res.data.result === 'OK';
  } catch (err) {
    console.error(`[-] Redis SET error for key "${key}":`, err.message);
    return false;
  }
}
