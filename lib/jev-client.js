// jev-client.js — Dual API client for typed Jev decision model
// Conforms to JevAgent Design Spec Section 4.1, Engineering Spec Section 14

export function extractFirstJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

export class JevClient {
  constructor(config = {}) {
    this.decisionCount = 0;
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    const envEnabled = process.env.JEV_ENABLED;
    this.enabled = config.jev_enabled !== undefined
      ? Boolean(config.jev_enabled)
      : (envEnabled !== undefined ? (envEnabled === '1' || envEnabled.toLowerCase() === 'true') : true);

    if (config.jev_base_url !== undefined) {
      this.baseUrl = String(config.jev_base_url).trim().replace(/\/+$/, '');
    } else {
      this.baseUrl = (process.env.JEV_API_BASE_URL || '').trim().replace(/\/+$/, '');
    }
    this.apiKey = (config.jev_api_key !== undefined ? config.jev_api_key : (process.env.JEV_API_KEY || '')).trim();
    this.model = (config.jev_model || process.env.JEV_MODEL || 'jevk5-4b-v0.3-Q4_K_M').trim();
    this.timeoutMs = (Number(config.jev_timeout_s) || 60) * 1000;
    this.tablesDir = config.tables_dir || '';
  }

  getConfig(maskKey = true) {
    return {
      jev_enabled: this.enabled,
      jev_base_url: this.baseUrl,
      jev_api_key: maskKey && this.apiKey ? (this.apiKey.slice(0, 3) + '***' + this.apiKey.slice(-4)) : (this.apiKey ? 'configured' : ''),
      jev_model: this.model,
      jev_timeout_s: this.timeoutMs / 1000,
      decision_count: this.decisionCount
    };
  }


  async checkConnection(timeoutMs = 1500) {
    if (!this.enabled) {
      return {
        connected: false,
        enabled: false,
        status: 'disabled',
        notice: '💡 Jev 决策服务器已禁用（当前处于本地确定性离线模式）。如需启用 4B 模型决策，请设置 jev_enabled: true。'
      };
    }
    if (!this.baseUrl) {
      return {
        connected: false,
        enabled: true,
        status: 'unconfigured',
        notice: '⚠️ 未配置 Jev 决策服务器端点 (jev_base_url)。当前降级使用本地确定性规则。'
      };
    }

    const now = Date.now();
    if (this._connCache && (now - this._connCache.timestamp) < 5000) {
      return this._connCache.result;
    }

    const cleanBase = this.baseUrl.replace(/\/+$/, '');
    const pingUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
    const t0 = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(pingUrl, {
        method: 'GET',
        headers: {
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
        },
        signal: controller.signal
      }).catch(async () => {
        return await fetch(cleanBase, { method: 'GET', signal: controller.signal });
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - t0;

      if (res && (res.ok || res.status < 500)) {
        const result = {
          connected: true,
          enabled: true,
          status: 'connected',
          endpoint: this.baseUrl,
          model: this.model,
          latency_ms: latencyMs,
          notice: `✅ Jev 决策服务器已连接 [${this.baseUrl}] (模型: ${this.model}, 延迟: ${latencyMs}ms)`
        };
        this._connCache = { timestamp: now, result };
        return result;
      }

      const result = {
        connected: false,
        enabled: true,
        status: 'error',
        endpoint: this.baseUrl,
        notice: `⚠️ Jev 决策服务器响应异常 (HTTP ${res ? res.status : '无响应'})，已自动降级为本地确定性规则。`
      };
      this._connCache = { timestamp: now, result };
      return result;
    } catch (err) {
      const result = {
        connected: false,
        enabled: true,
        status: 'unreachable',
        endpoint: this.baseUrl,
        notice: `⚠️ 未能连接到 Jev 决策服务器 [${this.baseUrl}] (${err.message})，已自动降级为本地确定性规则。`
      };
      this._connCache = { timestamp: now, result };
      return result;
    }
  }

  async decide(state, question) {
    this.decisionCount++;
    const qType = (question.type || 'choice').toLowerCase();

    // Independent toggle check: if enabled and baseUrl configured, try remote Jev API
    if (this.enabled && this.baseUrl) {
      try {
        const response = await this.callRemoteJev(state, question);
        if (response && response.decision) {
          return {
            ...response.decision,
            provider: 'remote_jev_api',
            endpoint_used: response.endpoint
          };
        }
      } catch (err) {
        console.warn(`[jev-client] Remote Jev API call failed: ${err.message}. Falling back to local heuristic.`);
        const fallback = this.localHeuristicDecision(state, question, qType);
        return {
          ...fallback,
          degraded: true,
          remote_error: err.message || String(err),
          provider: 'local_heuristic_fallback'
        };
      }
    }

    return this.localHeuristicDecision(state, question, qType);
  }

  async callRemoteJev(state, question) {
    const qType = (question.type || 'choice').toLowerCase();
    const cleanBase = this.baseUrl.replace(/\/+$/, '');

    // Resolve candidate endpoints:
    // If base ends with /v1, it is standard OpenAI path -> try chat/completions first
    let endpoints = [];
    if (cleanBase.endsWith('/chat/completions') || cleanBase.endsWith('/decide')) {
      endpoints.push(cleanBase);
    } else if (cleanBase.endsWith('/v1')) {
      endpoints.push(`${cleanBase}/chat/completions`);
      endpoints.push(`${cleanBase}/decide`);
    } else {
      endpoints.push(`${cleanBase}/decide`);
      endpoints.push(`${cleanBase}/v1/chat/completions`);
      endpoints.push(`${cleanBase}/chat/completions`);
    }

    let lastError = null;
    const errors = [];

    for (const url of endpoints) {
      try {
        const isChatCompletion = url.endsWith('/chat/completions');
        if (isChatCompletion) {
          const decision = await this.callChatCompletions(url, state, question, qType);
          return { decision, endpoint: url };
        } else {
          const decision = await this.callNativeDecide(url, state, question);
          return { decision, endpoint: url };
        }
      } catch (err) {
        console.warn(`[jev-client] Endpoint ${url} attempt failed: ${err.message}`);
        errors.push(`${url}: ${err.message}`);
        lastError = err;
        // Continue to try next endpoint if 404 or connection failure
      }
    }

    throw new Error(errors.length > 0 ? errors.join(' | ') : (lastError ? lastError.message : `No available Jev API endpoint responded at ${cleanBase}`));
  }

  async callNativeDecide(url, state, question) {
    const payload = {
      model: this.model,
      state: state || '',
      question: question
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`Jev native decide HTTP error: ${res.status}`);
      }

      const json = await res.json();
      if (json && json.decision) {
        return json.decision;
      }
      throw new Error(`Invalid native decide response format`);
    } finally {
      clearTimeout(timer);
    }
  }

  async callChatCompletions(url, state, question, qType) {
    const candidates = Array.isArray(question.candidates) ? question.candidates : [];
    const prompt = question.prompt || question.instructions || '';

    let systemPrompt = '';
    let userContent = '';

    if (qType === 'choice') {
      systemPrompt = 'You are a decision classifier. You must pick one string from the candidates array. Output ONLY JSON: {"choice": "exact_candidate_string"}.';
      userContent = `Candidates: ${JSON.stringify(candidates)}\nTask: ${prompt || "Select the most appropriate candidate"}${state ? `\nContext: ${state}` : ""}`;
    } else if (qType === 'score') {
      systemPrompt = 'You are a ranking classifier. Rank the candidates from best to worst. Output ONLY JSON: {"rankings": [{"candidate": "candidate_name", "score": 0.9}]}.';
      userContent = `Candidates: ${JSON.stringify(candidates)}${state ? `\nContext: ${state}` : ""}`;
    } else {
      systemPrompt = 'You are a gate classifier. Output ONLY JSON: {"gate": "continue", "confidence": 0.98}.';
      userContent = `Task: ${prompt}${state ? `\nContext: ${state}` : ""}`;
    }

    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0,
      max_tokens: 1024
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Jev chat/completions HTTP ${res.status}: ${errorText.slice(0, 120)}`);
      }

      const json = await res.json();
      const message = json?.choices?.[0]?.message || {};
      const rawText = (message.content || '').trim() || (message.reasoning_content || '').trim();
      if (!rawText) {
        throw new Error('Jev API returned empty message content');
      }

      // Robust JSON extraction from content or reasoning output
      let jsonStr = extractFirstJsonObject(rawText);
      let parsed = null;
      if (jsonStr) {
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          parsed = null;
        }
      }

      if (!parsed) {
        // Fallback for truncated outputs (e.g. model output choice before token limit)
        if (qType === 'choice') {
          const choiceMatch = rawText.match(/"choice"\s*:\s*"([^"]+)"/);
          if (choiceMatch) {
            parsed = { type: 'choice', choice: choiceMatch[1], confidence: 0.95 };
          }
        } else if (qType === 'noul') {
          const gateMatch = rawText.match(/"gate"\s*:\s*"([^"]+)"/);
          if (gateMatch) {
            parsed = { type: 'noul', gate: gateMatch[1], confidence: 0.98 };
          }
        }
      }

      if (!parsed) {
        throw new Error(`Could not find valid JSON object in model response: ${rawText.slice(0, 100)}`);
      }

      // Validate choice belongs to candidates if candidates provided
      if (qType === 'choice' && candidates.length > 0) {
        const chosen = parsed.choice;
        const matched = candidates.find(c => {
          const cStr = typeof c === 'string' ? c : (c.id || c.name || JSON.stringify(c));
          return cStr === chosen || cStr.toLowerCase() === String(chosen).toLowerCase() || String(chosen).includes(cStr);
        });
        if (!matched) {
          throw new Error(`Jev model returned choice '${chosen}' which is not in candidate set: ${candidates.join(', ')}`);
        }
        parsed.choice = typeof matched === 'string' ? matched : (matched.id || matched.name);
      }

      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  localHeuristicDecision(state, question, qType) {
    const candidates = Array.isArray(question.candidates) ? question.candidates : [];

    if (qType === 'choice') {
      if (candidates.length === 0) {
        return {
          type: 'choice',
          choice: null,
          confidence: 0,
          provider: 'local_heuristic_fallback',
          degraded: true,
          reason: 'no_candidates'
        };
      }

      const stateStr = String(state || '').toLowerCase();
      let best = null;
      let bestScore = 0;

      for (const cand of candidates) {
        const id = typeof cand === 'string' ? cand : (cand.id || cand.name || JSON.stringify(cand));
        // Split on both path slashes and common punctuation
        const words = id.toLowerCase().split(/[/_\s\-\(\)\.,:;]/).filter(w => w.length >= 2);
        let score = 0;
        for (const w of words) {
          if (stateStr.includes(w)) {
            score += 1;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }

      // BUG-02 Fix: Zero match must NOT return candidates[0] with high confidence!
      if (bestScore === 0 || !best) {
        return {
          type: 'choice',
          choice: null,
          confidence: 0,
          degraded: true,
          reason: 'no_candidate_matched_state',
          provider: 'local_heuristic_fallback'
        };
      }

      const chosenId = typeof best === 'string' ? best : (best.id || best.name || best);
      return {
        type: 'choice',
        choice: chosenId,
        confidence: 0.95,
        provider: 'local_heuristic'
      };
    }

    if (qType === 'score') {
      const scored = candidates.map((cand, idx) => ({
        candidate: cand,
        score: Math.max(0.1, 1.0 - idx * 0.15)
      }));
      return {
        type: 'score',
        rankings: scored,
        confidence: 0.9,
        provider: 'local_heuristic'
      };
    }

    if (qType === 'noul') {
      const prompt = (question.prompt || question.instructions || '').toLowerCase();
      let result = 'continue';
      if (prompt.includes('结束') || prompt.includes('完成') || prompt.includes('stop')) {
        result = 'stop';
      }
      return {
        type: 'noul',
        gate: result,
        confidence: 0.98,
        provider: 'local_heuristic'
      };
    }

    return { result: 'ok', provider: 'local_heuristic' };
  }
}
