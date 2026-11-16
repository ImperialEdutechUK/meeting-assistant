// The Teams side: receives chat messages through the Teams SDK and passes them to the service.

import { App, ExpressAdapter } from '@microsoft/teams.apps';
import type { ControlConfig } from '../core/config.js';
import { errorMessage, logger } from '../core/log.js';
import type { ChatMessage, ControlService, Notifier } from './service.js';

const log = logger('teams');

export function createTeamsApp(config: ControlConfig, adapter: ExpressAdapter): App {
  return new App({
    clientId: config.teamsClientId,
    clientSecret: config.teamsClientSecret,
    tenantId: config.tenantId,
    httpServerAdapter: adapter,
  });
}

/** Lets the service post messages on its own initiative, such as the recap. */
export function teamsNotifier(app: App): Notifier {
  return {
    async send(conversationId: string, markdown: string): Promise<void> {
      await app.send(conversationId, markdown);
    },
  };
}

interface MentionLike {
  type?: string;
  text?: string;
  mentioned?: { id?: string };
}

/**
 * Removes the "@Assistant" mention of the bot itself from the message text. Mentions of other
 * people are kept as plain names, because they are part of the question.
 */
export function stripBotMention(text: string, entities: unknown[] | undefined, botId: string): string {
  let out = text;
  for (const entity of (entities ?? []) as MentionLike[]) {
    if (entity?.type === 'mention' && entity.mentioned?.id === botId && typeof entity.text === 'string' && entity.text) {
      out = out.split(entity.text).join(' ');
    }
  }
  return out
    .replace(/<at>([^<]*)<\/at>/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wireTeams(app: App, service: ControlService): void {
  // Teams delivers a message again if the bot is slow to acknowledge it. Remember recent
  // message ids so a retry is never answered twice.
  const seen = new Set<string>();
  const firstTime = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 1000) seen.delete(seen.values().next().value as string);
    return true;
  };

  app.on('message', async (ctx) => {
    const activity = ctx.activity;
    const aadObjectId = activity.from.aadObjectId;
    if (!aadObjectId) return; // Only signed in Teams users can talk to the assistant.
    if (activity.id && !firstTime(activity.id)) return;
    const kind = activity.conversation.conversationType;
    const meetingId = activity.channelData?.meeting?.id;
    const conversationId = activity.conversation.id;
    const message: ChatMessage = {
      text: stripBotMention(activity.text ?? '', activity.entities, activity.recipient.id),
      user: { aadObjectId, name: activity.from.name ?? 'Colleague' },
      tenantId: activity.conversation.tenantId ?? activity.channelData?.tenant?.id ?? '',
      conversationId,
      conversationType: kind === 'personal' ? 'personal' : kind === 'channel' ? 'channel' : 'groupChat',
      ...(meetingId
        ? {
            resolveMeeting: async () => {
              // Needs the OnlineMeeting.ReadBasic.Chat permission from the app manifest.
              const info = await app.api.meetings.getById(meetingId);
              const joinUrl = info.details?.joinUrl;
              return joinUrl ? { joinUrl, title: info.details?.title } : null;
            },
          }
        : {}),
    };
    await ctx.send({ type: 'typing' }).catch(() => undefined);

    // Answering can take longer than Teams waits for an acknowledgement, so finish this
    // handler straight away and post the replies when they are ready.
    void (async () => {
      try {
        for (const reply of await service.handleChat(message)) await app.send(conversationId, reply);
      } catch (err) {
        log.error('Failed to handle a message', { error: errorMessage(err) });
        await app.send(conversationId, 'Sorry, something went wrong. Please try again.').catch(() => undefined);
      }
    })();
  });

  app.on('install.add', async (ctx) => {
    const activity = ctx.activity;
    // When the app is installed for a person (by them, or for everyone through a Teams setup
    // policy), remember them as staff straight away, so they can call the assistant and receive
    // recaps without having to message it first.
    if (activity.conversation.conversationType === 'personal' && activity.from.aadObjectId) {
      await service
        .registerInstall({
          aadObjectId: activity.from.aadObjectId,
          name: activity.from.name ?? 'Colleague',
          tenantId: activity.conversation.tenantId ?? activity.channelData?.tenant?.id ?? '',
          conversationId: activity.conversation.id,
        })
        .catch((err) => log.warn('Could not record the installation', { error: errorMessage(err) }));
    }
    await ctx.send(service.helpText()).catch((err) => log.warn('Could not send the welcome message', { error: errorMessage(err) }));
  });

  // If Teams tells us the meeting is over, make sure the assistant leaves too.
  app.on('meetingEnd', async (ctx) => {
    await service.requestLeaveForConversation(ctx.activity.conversation.id).catch((err) => log.debug('meetingEnd handling failed', { error: errorMessage(err) }));
  });
}
