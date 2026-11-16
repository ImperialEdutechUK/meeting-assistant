import { describe, expect, it } from 'vitest';
import { WakeMatcher } from '../src/core/wake.js';
import { TurnAssembler, type TurnAction } from '../src/core/turn.js';
import type { CaptionEvent } from '../src/core/types.js';

describe('WakeMatcher', () => {
  const m = new WakeMatcher(['claude']);

  it('matches greeting forms and returns the remainder', () => {
    expect(m.match('Hey Claude, what did I explain to Jordan?')?.remainder).toBe('what did I explain to Jordan?');
    expect(m.match('So, hey Claude can you recap the last five minutes')?.remainder).toBe('can you recap the last five minutes');
    expect(m.match('Okay Claude. Who owns the Moodle pilot?')?.remainder).toBe('Who owns the Moodle pilot?');
    expect(m.match('Hey, Claude.')?.remainder).toBe('');
  });

  it('accepts common mishearings only after a strong greeting', () => {
    expect(m.match('Hey cloud, what is our refund policy?')?.remainder).toBe('what is our refund policy?');
    expect(m.match('hi Claud summarise the decisions')?.remainder).toBe('summarise the decisions');
    expect(m.match('Okay, cloud costs are going up this month')).toBeNull();
    expect(m.match('We moved the OPERA Cloud course to the new site')).toBeNull();
    expect(m.match('The cloud migration is what we discussed')).toBeNull();
  });

  it('matches the bare name at the start of a caption when a question follows', () => {
    expect(m.match('Claude, repeat what I mentioned.')?.remainder).toBe('repeat what I mentioned.');
    expect(m.match('Claude what did we decide')?.remainder).toBe('what did we decide');
    expect(m.match('Claude?')?.remainder).toBe('');
    expect(m.match('I asked Claude what to do yesterday')).toBeNull();
    expect(m.match('Claudette, what do you think?')).toBeNull();
  });

  it('recognises stop commands', () => {
    expect(m.isStop('Claude, stop.')).toBe(true);
    expect(m.isStop('Thanks Claude')).toBe(true);
    expect(m.isStop('okay Claude that is enough')).toBe(true);
    expect(m.isStop('We should stop the campaign')).toBe(false);
  });

  it('supports a custom name', () => {
    const nova = new WakeMatcher(['nova']);
    expect(nova.match('Hey Nova, list the action items')?.remainder).toBe('list the action items');
    expect(nova.match('Hey Claude, list the action items')).toBeNull();
  });
});

function cap(speakerId: string, text: string, final: boolean, at: number): CaptionEvent {
  return { speakerId, speakerName: speakerId === 's1' ? 'Alex Morgan' : 'Jordan', text, final, at };
}

describe('TurnAssembler', () => {
  const make = () => new TurnAssembler({ wakeNames: ['claude'], selfId: 'bot', selfName: 'Claude (AI assistant)' });

  it('assembles a question spoken in one caption', () => {
    const t = make();
    const out: TurnAction[] = [];
    out.push(...t.onCaption(cap('s1', 'Hey Claude what did', false, 1000)));
    out.push(...t.onCaption(cap('s1', 'Hey Claude, what did I explain to Jordan?', true, 2000)));
    expect(t.tick(2500)).toEqual([]);
    out.push(...t.tick(3600));
    expect(out.map((a) => a.type)).toEqual(['wake', 'question']);
    expect(out[1]).toMatchObject({ type: 'question', speakerName: 'Alex Morgan', text: 'what did I explain to Jordan?' });
    expect(t.isListening).toBe(false);
  });

  it('joins a question that spans several captions and ignores other speakers', () => {
    const t = make();
    t.onCaption(cap('s1', 'Hey Claude.', true, 1000));
    t.onCaption(cap('s2', 'Sorry, go on.', true, 1500));
    t.onCaption(cap('s1', 'Can you list', false, 2500));
    expect(t.tick(3000)).toEqual([]);
    t.onCaption(cap('s1', 'Can you list the decisions', true, 3200));
    t.onCaption(cap('s1', 'and who', false, 3900));
    expect(t.tick(4600)).toEqual([]);
    t.onCaption(cap('s1', 'and who owns each one?', true, 5000));
    const out = t.tick(6600);
    expect(out).toEqual([
      { type: 'question', speakerId: 's1', speakerAadId: undefined, speakerName: 'Alex Morgan', text: 'Can you list the decisions and who owns each one?' },
    ]);
  });

  it('needs no wake phrase in a private call, but still strips one if it is used', () => {
    const t = new TurnAssembler({ wakeNames: ['claude'], selfId: 'bot', selfName: 'Claude (AI assistant)', alwaysListening: true });
    t.onCaption(cap('s1', 'What did we decide yesterday?', true, 1000));
    expect(t.tick(2000)[0]).toMatchObject({ type: 'question', text: 'What did we decide yesterday?' });
    t.onCaption(cap('s1', 'Hey Claude, who owns the fee check?', true, 5000));
    expect(t.tick(6000)[0]).toMatchObject({ type: 'question', text: 'who owns the fee check?' });
    // Its own voice is never taken as a question.
    t.onCaption({ ...cap('bot', 'You decided to publish on Monday.', true, 8000), speakerName: 'Claude (AI assistant)' });
    expect(t.tick(10_000)).toEqual([]);
  });

  it('nudges when only the wake phrase is heard, then takes the follow up', () => {
    const t = make();
    t.onCaption(cap('s1', 'Claude?', true, 1000));
    expect(t.tick(3000)).toEqual([]);
    expect(t.tick(6100)).toEqual([{ type: 'nudge', speakerId: 's1', speakerName: 'Alex Morgan' }]);
    t.onCaption(cap('s1', 'What is the refund policy?', true, 8000));
    expect(t.tick(9600)[0]).toMatchObject({ type: 'question', text: 'What is the refund policy?' });
  });

  it('gives up quietly if nothing follows the nudge', () => {
    const t = make();
    t.onCaption(cap('s1', 'Hey Claude', true, 1000));
    t.tick(6100);
    expect(t.tick(15200)).toEqual([]);
    expect(t.isListening).toBe(true);
    expect(t.tick(21200)).toEqual([]);
    expect(t.isListening).toBe(false);
  });

  it('starts the follow up window only after the nudge has finished playing', () => {
    const t = make();
    t.onCaption(cap('s1', 'Hey Claude', true, 1000));
    expect(t.tick(6100)[0]).toMatchObject({ type: 'nudge' });
    // Making and playing "Yes?" takes a while; time spent speaking does not count.
    t.setSpeaking(true);
    t.tick(10_000);
    t.setSpeaking(false);
    t.tick(10_100);
    // The caption of the reply arrives 13 seconds after the nudge was decided, 3 after it ended.
    t.onCaption(cap('s1', 'What did I just say?', true, 19_000));
    expect(t.tick(20_600)[0]).toMatchObject({ type: 'question', text: 'What did I just say?' });
  });

  it('drops a wake phrase that the recogniser later revises away', () => {
    const t = make();
    expect(t.onCaption(cap('s1', 'hey cloud', false, 1000)).map((a) => a.type)).toEqual(['wake']);
    expect(t.onCaption(cap('s1', 'A cloud region outage hit us', true, 1800))).toEqual([]);
    expect(t.isListening).toBe(false);
    expect(t.tick(5000)).toEqual([]);
  });

  it('ignores its own captions and handles stop and barge in while speaking', () => {
    const t = make();
    expect(t.onCaption({ speakerId: 'bot', speakerName: 'Claude (AI assistant)', text: 'Hey Claude, what', final: true, at: 1 })).toEqual([]);
    t.setSpeaking(true);
    expect(t.onCaption(cap('s2', 'Claude, stop.', true, 100))).toEqual([{ type: 'stop' }]);
    const out = t.onCaption(cap('s2', 'Hey Claude, one more thing', true, 200));
    expect(out.map((a) => a.type)).toEqual(['stop', 'wake']);
  });

  it('accepts a partial that never becomes final', () => {
    const t = make();
    t.onCaption(cap('s1', 'Hey Claude, who is presenting next', false, 1000));
    expect(t.tick(4000)).toEqual([]);
    expect(t.tick(5100)[0]).toMatchObject({ type: 'question', text: 'who is presenting next' });
  });
});
