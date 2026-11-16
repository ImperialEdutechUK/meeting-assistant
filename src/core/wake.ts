// Wake phrase and stop command matching on live caption text.
//
// Speech recognition often mishears a name, so each configured name expands to a set of
// variants. The loose variants (for example "cloud" for "Claude") only count after a greeting
// such as "hey" or "okay", which keeps ordinary sentences from waking the assistant.

const GREETINGS = ['hey', 'hi', 'hello', 'yo', 'excuse me'];
const WEAK_GREETINGS = ['ok', 'okay'];

const QUESTION_STARTERS = [
  'what', 'who', 'when', 'where', 'why', 'how', 'which', 'can', 'could', 'would', 'will', 'please',
  'tell', 'give', 'summarise', 'summarize', 'recap', 'remind', 'list', 'is', 'are', 'do', 'does',
  'did', 'explain', 'repeat', 'show', 'find', 'search', 'check', 'look', 'say', 'read', 'note',
];

const STOP_WORDS = [
  'stop', "that's enough", 'thats enough', 'that is enough', 'be quiet', 'quiet', 'cancel',
  'never mind', 'nevermind', 'shut up', 'enough',
];

/** Known mishearings. Strict variants may be used without a greeting, loose ones may not. */
const KNOWN_VARIANTS: Record<string, { strict: string[]; loose: string[] }> = {
  claude: {
    strict: ['claude', 'claud', 'clawed', 'clawd'],
    loose: ['cloud', 'clod', 'klaud', 'claudia', 'clyde', 'clode'],
  },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alternation(words: string[]): string {
  return words
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRegex(w).replace(/\s+/g, '\\s+'))
    .join('|');
}

export interface WakeMatch {
  /** The words that follow the wake phrase in the same caption, trimmed. May be empty. */
  remainder: string;
}

export class WakeMatcher {
  private readonly greetingForm: RegExp;
  private readonly bareQuestionForm: RegExp;
  private readonly bareAloneForm: RegExp;
  private readonly stopForms: RegExp[];

  constructor(names: string[]) {
    const cleaned = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
    if (cleaned.length === 0) throw new Error('At least one wake name is required');
    const strict: string[] = [];
    const loose: string[] = [];
    for (const name of cleaned) {
      const known = KNOWN_VARIANTS[name];
      if (known) {
        strict.push(...known.strict);
        loose.push(...known.loose);
      } else {
        strict.push(name);
      }
    }
    const all = alternation([...strict, ...loose]);
    const strictAlt = alternation(strict);
    const greet = alternation(GREETINGS);
    const starters = alternation(QUESTION_STARTERS);
    const sep = "[\\s,.!?:;]*";

    // "Hey Claude, ..." anywhere in the caption. "Ok" and "okay" are common sentence openers,
    // so they only count in front of a strict variant ("okay Claude", never "okay, cloud costs").
    const weak = alternation(WEAK_GREETINGS);
    this.greetingForm = new RegExp(
      `(?:^|[^\\p{L}])(?:(?:${greet})[\\s,]+(?:there[\\s,]+)?(?:${all})|(?:${weak})[\\s,]+(?:${strictAlt}))(?![\\p{L}])${sep}`,
      'iu',
    );
    // "Claude, what did I ..." only at the start of the caption and only for strict variants.
    this.bareQuestionForm = new RegExp(`^\\s*(?:${strictAlt})(?![\\p{L}])[\\s,.!?:;]+(?=(?:${starters})(?![\\p{L}]))`, 'iu');
    // The name on its own, for example "Claude?".
    this.bareAloneForm = new RegExp(`^\\s*(?:${strictAlt})\\s*[.!?]*\\s*$`, 'iu');

    const stops = alternation(STOP_WORDS);
    this.stopForms = [
      new RegExp(`(?:^|[^\\p{L}])(?:${all})(?![\\p{L}])[\\s,.!?]*(?:please[\\s,]*)?(?:${stops})(?![\\p{L}])`, 'iu'),
      new RegExp(`(?:^|[^\\p{L}])(?:${stops})[\\s,]+(?:${all})(?![\\p{L}])`, 'iu'),
      new RegExp(`(?:^|[^\\p{L}])(?:thanks|thank you)[\\s,]+(?:${all})(?![\\p{L}])`, 'iu'),
    ];
  }

  match(text: string): WakeMatch | null {
    const greeting = this.greetingForm.exec(text);
    if (greeting) {
      return { remainder: clean(text.slice(greeting.index + greeting[0].length)) };
    }
    const bare = this.bareQuestionForm.exec(text);
    if (bare) {
      return { remainder: clean(text.slice(bare.index + bare[0].length)) };
    }
    if (this.bareAloneForm.test(text)) {
      return { remainder: '' };
    }
    return null;
  }

  isStop(text: string): boolean {
    return this.stopForms.some((re) => re.test(text));
  }
}

function clean(s: string): string {
  return s.replace(/^[\s,.!?:;]+/, '').replace(/\s+/g, ' ').trim();
}
