// Creates the short lived Azure Communication Services identity the worker joins a meeting with.

import { CommunicationIdentityClient } from '@azure/communication-identity';
import type { CallIdentityIssuer } from './service.js';

export class AcsIdentityIssuer implements CallIdentityIssuer {
  private readonly client: CommunicationIdentityClient;

  constructor(connectionString: string) {
    this.client = new CommunicationIdentityClient(connectionString);
  }

  async issue(validMinutes: number): Promise<{ token: string; userId: string }> {
    // The service accepts token lifetimes between one hour and one day.
    const tokenExpiresInMinutes = Math.min(1440, Math.max(60, Math.round(validMinutes)));
    const result = await this.client.createUserAndToken(['voip'], { tokenExpiresInMinutes });
    return { token: result.token, userId: result.user.communicationUserId };
  }

  async revoke(userId: string): Promise<void> {
    await this.client.deleteUser({ communicationUserId: userId });
  }
}

/** Stand in for local runs with the fake call transport. */
export class FakeIdentityIssuer implements CallIdentityIssuer {
  readonly revoked: string[] = [];

  async issue(): Promise<{ token: string; userId: string }> {
    return { token: 'fake-token', userId: `fake-user-${Date.now()}` };
  }

  async revoke(userId: string): Promise<void> {
    this.revoked.push(userId);
  }
}
