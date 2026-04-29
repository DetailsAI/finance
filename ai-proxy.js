/**
 * DETAILS Financials — Google Apps Script Proxy Function
 * Proxies calls to your GAS backend so the GAS URL never appears in browser source.
 */

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const gasUrl = process.env.GAS_URL;
  if (!gasUrl) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GAS_URL not configured in Netlify env vars' }) };
  }

  try {
    let response;

    if (event.httpMethod === 'POST') {
      let bodyObj = JSON.parse(event.body || '{}');
      // Inject the API key from environment (client doesn't need to send it)
      if(process.env.GAS_API_KEY) bodyObj.key = process.env.GAS_API_KEY;
      const body = JSON.stringify(bodyObj);
      response = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: body,
        redirect: 'follow',
      });
    } else {
      // GET — forward query string
      const qs = event.rawQuery ? '?' + event.rawQuery : '';
      response = await fetch(gasUrl + qs, { redirect: 'follow' });
    }

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
