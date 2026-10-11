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
// one quick retry for rate limits / gateway hiccups (several replies can be generated at once)
async function callRetry(provider, model, messages, opts) {
  try { return await callOnce(provider, model, messages, opts); }
  catch (e) {
    if (!/HTTP (429|5\d\d)|fetch failed|ECONNRESET|socket/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
    return callOnce(provider, model, messages, opts);
  }
}

export async function chat(ai, messages, opts) {
  if (!ai.enabled) throw new Error('AI disabled in settings');
  if (!llmConfigured()) throw new Error('LLM not configured');
  try { return await callRetry(ai.provider, ai.model, messages, opts); }
  catch (e1) {
    if (!ai.fallbackProvider) throw e1;
    try { return await callOnce(ai.fallbackProvider, ai.fallbackModel, messages, opts); }
    catch (e2) { throw new Error(`${e1.message} | fallback: ${e2.message}`); }
  }
}

/** Extract the first JSON object/array from a model reply. */
// Models sometimes put text such as "[卡片]" before the JSON, so every { / [
// position is tried until one parses.
export function parseJson(text) {
  const t = String(text).replace(/```(?:json)?/g, '').trim();
  let lastErr = null, tries = 0;
  for (let i = 0; i < t.length && tries < 200; i++) {
    const open = t[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    for (let end = t.lastIndexOf(close); end > i && tries < 200; end = t.lastIndexOf(close, end - 1)) {
      tries++;
      try { return JSON.parse(t.slice(i, end + 1)); } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('no JSON in reply');
}
