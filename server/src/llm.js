// LLM client. Calls the student system's OpenAI-compatible gateway
// ({CP_URL}/api/llm-gw/{provider}/v1/chat/completions) with the tenant's own
// credentials, so usage is billed to the tenant like any other app on it.
// Credentials are read from HR_LLM_ENV_FILE (the student system's .env) or
// from HR_LLM_* env vars; nothing is copied into this repo.
import fs from 'node:fs';

let creds = null;

function loadCreds() {
  if (creds) return creds;
  const env = { ...process.env };
  const file = process.env.HR_LLM_ENV_FILE;
  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^(TENANT_ID|TENANT_API_TOKEN|CP_URL)=(.*)$/);
      if (m && !env['HR_LLM_' + m[1]]) env['HR_LLM_' + m[1]] = m[2].trim().replace(/^"|"$/g, '');
    }
  }
  creds = {
    base: (env.HR_LLM_BASE || env.HR_LLM_CP_URL || '').replace(/\/+$/, ''),
    tenant: env.HR_LLM_TENANT_ID || '',
    token: env.HR_LLM_TENANT_API_TOKEN || '',
    // direct OpenAI-compatible endpoint (e.g. own API key provided later)
    directUrl: env.HR_LLM_DIRECT_URL || '',
    directKey: env.HR_LLM_DIRECT_KEY || '',
  };
  return creds;
}

export function llmConfigured() {
  const c = loadCreds();
  return !!((c.base && c.tenant && c.token) || (c.directUrl && c.directKey));
}

async function callOnce(provider, model, messages, { maxTokens = 600, temperature = 0.3, timeoutMs = 25000 } = {}) {
  const c = loadCreds();
  let url, auth;
  if (c.directUrl && c.directKey) { url = c.directUrl; auth = c.directKey; }
  else { url = `${c.base}/api/llm-gw/${provider}/v1/chat/completions`; auth = `${c.tenant}:${c.token}`; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`LLM ${provider}/${model} HTTP ${r.status}: ${txt.slice(0, 200)}`);
    const data = JSON.parse(txt);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM empty response');
    return { content, model: data.model || model, provider };
  } finally { clearTimeout(t); }
}

/** Chat with fallback provider. Throws if both fail. */
export async function chat(ai, messages, opts) {
  if (!ai.enabled) throw new Error('AI disabled in settings');
  if (!llmConfigured()) throw new Error('LLM not configured');
  try { return await callOnce(ai.provider, ai.model, messages, opts); }
  catch (e1) {
    if (!ai.fallbackProvider) throw e1;
    try { return await callOnce(ai.fallbackProvider, ai.fallbackModel, messages, opts); }
    catch (e2) { throw new Error(`${e1.message} | fallback: ${e2.message}`); }
  }
}

/** Extract the first JSON object/array from a model reply. */
export function parseJson(text) {
  const t = String(text).replace(/```(?:json)?/g, '').trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in reply');
  const open = t[start], close = open === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  return JSON.parse(t.slice(start, end + 1));
}
