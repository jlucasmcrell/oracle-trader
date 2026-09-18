// Complete read-only pagination. A repeated cursor or malformed page is an error, never a complete dump.
async function cursorPages(get, route, key, pause = async () => {}) {
  const rows = [], seen = new Set();
  let cursor = '', pages = 0;
  do {
    const data = await get(route + (route.includes('?') ? '&' : '?') + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (!Array.isArray(data[key])) throw new Error(`Missing ${key} array in ${route}`);
    rows.push(...data[key]); pages++;
    cursor = data.cursor || '';
    if (cursor && seen.has(cursor)) throw new Error(`Repeated cursor in ${route}`);
    seen.add(cursor);
    if (cursor) await pause();
  } while (cursor);
  return { rows, pages, complete: true };
}
module.exports = { cursorPages };
