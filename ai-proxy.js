/**
 * DETAILS Financials — AI Proxy Function
 * Runs on Netlify's servers. API key NEVER reaches the browser.
 * Deploy: this file goes in /netlify/functions/ai-proxy.js
 */

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers — only allow requests from your own domain
  const allowedOrigins = [
    process.env.ALLOWED_ORIGIN || '*',  // Set ALLOWED_ORIGIN in Netlify env vars to your domain
  ];
  const origin = event.headers.origin || '';
  const corsOrigin = allowedOrigins.includes('*') || allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const headers = {
    'Access-Control-Allow-Origin': corsOrigin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { prompt, maxTokens, model } = body;

    if (!prompt) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No prompt provided' }) };
    }

    // API key from Netlify environment — never in browser source
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI service not configured. Add ANTHROPIC_API_KEY to Netlify environment variables.' }) };
    }

    // Call Anthropic — server-side, no CORS issues
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens || 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      // 401 = bad key, 429 = rate limit
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: 'AI API error ' + response.status + ': ' + errText.slice(0, 200) }),
      };
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, text }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Proxy error: ' + err.message }),
    };
  }
};
