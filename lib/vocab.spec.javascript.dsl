// @jev-block:names:begin
变量 validate: Any
// @jev-block:names:end
// vocab.js — Vocabulary candidate validator
// Conforms to JevAgent Design Spec Section 9

// @jev-block:vocab_validator_001:begin
导出 类 VocabValidator:                                   // node:/javascript/class/define
  static ALLOWED_CATEGORIES = new Set([                               // node:/javascript/data/assign
    'operation',
    'control',
    'type',
    'data',
    'io',
    'error',
    'domain'
  ])

  静态 方法 validate(candidate, existingVocab = null, loadedTables = null):             // node:/javascript/function/define
    设 issues = []          // node:/javascript/data/declare
    设 suggestions = []          // node:/javascript/data/declare

    如果 !candidate || typeof candidate !== 'object':                             // node:/javascript/control/if
      返回 {                               // node:/javascript/function/return
        valid: false,
        issues: [{ type: 'schema_error', message: '候选词表必须是 JSON 对象' }],
        suggestions: ['提供包含 vocab_id 与 words 列表的合法 JSON 对象']
      }

    设 vocabId = candidate.vocab_id || candidate.candidate_vocab_id || 'unknown_vocab'          // node:/javascript/data/declare
    设 words = Array.isArray(candidate.words) ? candidate.words : (candidate.word_id ? [candidate] : [])          // node:/javascript/data/declare

    如果 words.length === 0:                             // node:/javascript/control/if
      issues.push({ type: 'empty_vocab', message: '候选词表不包含任何词条' });

    设 seenWordIds = new Set()          // node:/javascript/data/declare
    设 seenSynonyms = new Set()          // node:/javascript/data/declare

    对于 w 中的 words:           // node:/javascript/control/for
      如果 !w.word_id || typeof w.word_id !== 'string':                             // node:/javascript/control/if
        issues.push({ type: 'missing_field', word_id: null, field: 'word_id', severity: 'high' });
        继续                                       // node:/javascript/control/loop/continue

      如果 seenWordIds.has(w.word_id):                             // node:/javascript/control/if
        issues.push({ type: 'duplicate_word_id', word_id: w.word_id, severity: 'high' });
      seenWordIds.add(w.word_id)                               // node:/javascript/function/call

      如果 !w.canonical:                             // node:/javascript/control/if
        issues.push({ type: 'missing_canonical', word_id: w.word_id, severity: 'medium' });

      如果 !Array.isArray(w.synonyms) || w.synonyms.length === 0:                             // node:/javascript/control/if
        issues.push({ type: 'empty_synonyms', word_id: w.word_id, severity: 'medium' });
      否则:                                     // node:/javascript/control/else
        对于 syn 中的 w.synonyms:           // node:/javascript/control/for
          如果 seenSynonyms.has(syn):                             // node:/javascript/control/if
            issues.push({
              type: 'synonym_collision',
              word_id: w.word_id,
              synonym: syn,
              severity: 'medium',
              message: `同义词 '${syn}' 在候选词表中发生内部碰撞`
            });
            suggestions.push(`为词条 ${w.word_id} 精简同义词，移除歧义项 '${syn}'`)                               // node:/javascript/function/call
          seenSynonyms.add(syn)                               // node:/javascript/function/call

      如果 w.category && !this.ALLOWED_CATEGORIES.has(w.category):                             // node:/javascript/control/if
        issues.push({
          type: 'invalid_category',
          word_id: w.word_id,
          category: w.category,
          severity: 'low',
          message: `类别 '${w.category}' 不在允许的封闭集合中: ${Array.from(this.ALLOWED_CATEGORIES).join(', ')}`
        });

      如果 w.semantic_layer && !['common', 'language_specific'].includes(w.semantic_layer):                             // node:/javascript/control/if
        issues.push({
          type: 'invalid_semantic_layer',
          word_id: w.word_id,
          layer: w.semantic_layer,
          severity: 'medium'
        });

    返回 {                               // node:/javascript/function/return
      candidate_vocab_id: vocabId,
      valid: issues.filter(i => i.severity === 'high').length === 0,
      total_words: words.length,
      issues,
      suggestions
    }

// @jev-block:vocab_validator_001:end
