// vocab.js — Vocabulary candidate validator
// Conforms to JevAgent Design Spec Section 9

export class VocabValidator {
  static ALLOWED_CATEGORIES = new Set([
    'operation',
    'control',
    'type',
    'data',
    'io',
    'error',
    'domain'
  ]);

  static validate(candidate, existingVocab = null, loadedTables = null) {
    const issues = [];
    const suggestions = [];

    if (!candidate || typeof candidate !== 'object') {
      return {
        valid: false,
        issues: [{ type: 'schema_error', message: '候选词表必须是 JSON 对象' }],
        suggestions: ['提供包含 vocab_id 与 words 列表的合法 JSON 对象']
      };
    }

    const vocabId = candidate.vocab_id || candidate.candidate_vocab_id || 'unknown_vocab';
    const words = Array.isArray(candidate.words) ? candidate.words : (candidate.word_id ? [candidate] : []);

    if (words.length === 0) {
      issues.push({ type: 'empty_vocab', message: '候选词表不包含任何词条' });
    }

    const seenWordIds = new Set();
    const seenSynonyms = new Set();

    for (const w of words) {
      if (!w.word_id || typeof w.word_id !== 'string') {
        issues.push({ type: 'missing_field', word_id: null, field: 'word_id', severity: 'high' });
        continue;
      }

      if (seenWordIds.has(w.word_id)) {
        issues.push({ type: 'duplicate_word_id', word_id: w.word_id, severity: 'high' });
      }
      seenWordIds.add(w.word_id);

      if (!w.canonical) {
        issues.push({ type: 'missing_canonical', word_id: w.word_id, severity: 'medium' });
      }

      if (!Array.isArray(w.synonyms) || w.synonyms.length === 0) {
        issues.push({ type: 'empty_synonyms', word_id: w.word_id, severity: 'medium' });
      } else {
        for (const syn of w.synonyms) {
          if (seenSynonyms.has(syn)) {
            issues.push({
              type: 'synonym_collision',
              word_id: w.word_id,
              synonym: syn,
              severity: 'medium',
              message: `同义词 '${syn}' 在候选词表中发生内部碰撞`
            });
            suggestions.push(`为词条 ${w.word_id} 精简同义词，移除歧义项 '${syn}'`);
          }
          seenSynonyms.add(syn);
        }
      }

      if (w.category && !this.ALLOWED_CATEGORIES.has(w.category)) {
        issues.push({
          type: 'invalid_category',
          word_id: w.word_id,
          category: w.category,
          severity: 'low',
          message: `类别 '${w.category}' 不在允许的封闭集合中: ${Array.from(this.ALLOWED_CATEGORIES).join(', ')}`
        });
      }

      if (w.semantic_layer && !['common', 'language_specific'].includes(w.semantic_layer)) {
        issues.push({
          type: 'invalid_semantic_layer',
          word_id: w.word_id,
          layer: w.semantic_layer,
          severity: 'medium'
        });
      }
    }

    return {
      candidate_vocab_id: vocabId,
      valid: issues.filter(i => i.severity === 'high').length === 0,
      total_words: words.length,
      issues,
      suggestions
    };
  }
}
