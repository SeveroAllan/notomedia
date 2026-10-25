export const PROMPT_STANDARD = {
  instructionLanguage: 'en',
  conversationLocale: 'pt-BR',
  writingStandard: 'ASD-STE100 Issue 9',
  ste100Application: 0.8,
  conversationStyle: 'natural_professional',
  forbiddenVisiblePunctuation: [';'],
  principles: [
    'use_short_direct_sentences',
    'use_active_voice',
    'use_one_instruction_per_sentence',
    'use_consistent_terms',
    'avoid_ambiguous_synonyms',
    'keep_human_natural_tone'
  ]
} as const;
