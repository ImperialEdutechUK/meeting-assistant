// The assistant's own Teams account. Once an admin has connected it, the assistant can be called
// like a colleague and added to Teams calls, through Azure Communication Services "Teams users".
//
// How the sign in works:
// 1. An admin sends "connect assistant account" in a personal chat with the app.
// 2. The service starts a Microsoft device sign in and posts a code. The admin opens
//    https://microsoft.com/devicelogin and signs in AS THE ASSISTANT ACCOUNT. Any other account is
//    refused and removed.
// 3. The resulting sign in (a refresh token) is encrypted with a key derived from the service's
//    shared secret and stored in the private storage account. It renews itself while in use.
// 4. Workers ask the service for a short lived calling token, made by exchanging the account's
//    Entra token at Azure Communication Services.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { CommunicationIdentityClient } from '@azure/communication-identity';
import { type AccountInfo, type ICachePlugin, PublicClientApplication, type TokenCacheContext } from '@azure/msal-node';
import { errorMessage, logger } from '../core/log.js';
import type { Store } from '../core/store.js';

const log = logger('teams-identity');

/** Delegated permissions of the Azure Communication Services API for Teams users. */
export const TEAMS_USER_SCOPES = [
  'https://auth.msft.communication.azure.com/Teams.ManageCalls',
  'https://auth.msft.communication.azure.com/Teams.ManageChats',
];

export interface TeamsToken {
  /** Calling token for the Azure Communication Services SDK, signed in as the assistant. */
  token: string;
  /** Epoch milliseconds. */
  expiresOn: number;
  /** Entra object id of the assistant account, which is also its id in calls and captions. */
  userId: string;
}

export interface TeamsIdentityOptions {
  clientId: string;
  tenantId: string;
  /** Sign in name of the assistant account, for example claude.assistant@example.com. */
  upn: string;
  acsConnectionString: string;
  store: Store;
  /** Secret used to derive the key that encrypts the stored sign in. */
  secret: string;
}

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'claude-meeting-assistant', 'teams-signin-cache', 32));
}

export function encryptCache(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptCache(encoded: string, secret: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export class TeamsIdentity {
  private readonly app: PublicClientApplication;
  private cached: TeamsToken | null = null;
  private signingIn = false;

  constructor(private readonly o: TeamsIdentityOptions) {
    const store = o.store;
    const secret = o.secret;
    const plugin: ICachePlugin = {
      async beforeCacheAccess(context: TokenCacheContext) {
        const encrypted = await store.loadIdentityCache();
        if (encrypted) context.tokenCache.deserialize(decryptCache(encrypted, secret));
      },
      async afterCacheAccess(context: TokenCacheContext) {
        if (context.cacheHasChanged) await store.saveIdentityCache(encryptCache(context.tokenCache.serialize(), secret));
      },
    };
    this.app = new PublicClientApplication({
      auth: { clientId: o.clientId, authority: `https://login.microsoftonline.com/${o.tenantId}` },
      cache: { cachePlugin: plugin },
    });
  }

  private async account(): Promise<AccountInfo | null> {
    const accounts = await this.app.getTokenCache().getAllAccounts();
    return accounts.find((a) => a.username.toLowerCase() === this.o.upn) ?? null;
  }

  async status(): Promise<{ connected: boolean; account: string }> {
    return { connected: (await this.account()) !== null, account: this.o.upn };
  }

  /**
   * Starts the device sign in. `onCode` receives the instructions to show the admin. Resolves when
   * the admin has finished (or the code expired), with a message saying what happened.
   */
  async connect(onCode: (instructions: string) => Promise<void>): Promise<string> {
    if (this.signingIn) return 'A sign in is already in progress. Finish that one first.';
    this.signingIn = true;
    try {
      const result = await this.app.acquireTokenByDeviceCode({
        scopes: TEAMS_USER_SCOPES,
        deviceCodeCallback: (response) => {
          void onCode(
            `To connect the assistant's Teams account, open ${response.verificationUri} in a private browser window, enter the code **${response.userCode}**, and sign in as **${this.o.upn}** (not as yourself). The code expires in about 15 minutes.`,
          );
        },
      });
      const signedIn = result?.account;
      if (!signedIn) return 'The sign in did not complete. Please try again.';
      if (signedIn.username.toLowerCase() !== this.o.upn) {
        // Never keep any other account: the service would act as that person.
        await this.app.getTokenCache().removeAccount(signedIn);
        log.warn('A different account was used to connect and has been removed', { expected: this.o.upn });
        return `That sign in was for a different account, so it was discarded. Sign in as **${this.o.upn}**.`;
      }
      this.cached = null;
      log.info('Assistant Teams account connected', { account: this.o.upn });
      return `Connected. People can now call **${this.o.upn}** while the call receiver is running.`;
    } catch (err) {
      log.warn('Connecting the assistant account failed', { error: errorMessage(err) });
      return `Connecting failed: ${errorMessage(err).split('\n')[0]}`;
    } finally {
      this.signingIn = false;
    }
  }

  /** A calling token for the assistant account, renewed a few minutes before it expires. */
  async getToken(): Promise<TeamsToken> {
    if (this.cached && this.cached.expiresOn - Date.now() > 5 * 60_000) return this.cached;
    const account = await this.account();
    if (!account) throw new Error('The assistant Teams account is not connected');
    const entra = await this.app.acquireTokenSilent({ account, scopes: TEAMS_USER_SCOPES });
    const acs = new CommunicationIdentityClient(this.o.acsConnectionString);
    const exchanged = await acs.getTokenForTeamsUser({ teamsUserAadToken: entra.accessToken, clientId: this.o.clientId, userObjectId: account.localAccountId });
    this.cached = { token: exchanged.token, expiresOn: exchanged.expiresOn.getTime(), userId: account.localAccountId };
    return this.cached;
  }
}
