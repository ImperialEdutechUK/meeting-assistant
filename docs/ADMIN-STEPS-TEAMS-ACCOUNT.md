# Admin steps: the Claude Assistant Teams account

For: the Microsoft 365 / Entra administrator at Imperial Learning Ltd.
From: Nandika Anupama, Course Development.
Date: 16 November 2026. Time needed: about 20 minutes.

## What this is for

Our Claude meeting assistant already joins Teams meetings. We are giving it its own Teams account
(**Claude Assistant**) so that staff can **call it** to catch up on meetings they attended, and
**add it to calls**, including one-to-one calls. Everything else is already built and deployed in our
Azure subscription. Only the steps below need administrator rights.

The app registration has already been created by Nandika:

| | |
| --- | --- |
| App name | **Claude Assistant Teams Sign-in** |
| Application (client) ID | `70f0d1c9-aff8-469c-99da-004cea4c7ea4` |
| Permissions requested | Azure Communication Services, **delegated**: `Teams.ManageCalls`, `Teams.ManageChats` |
| Public client flows | Yes (for a one-time device code sign-in) |
| Assignment required | Yes. Only accounts assigned to the app can sign in through it |

**Why these permissions are limited:** they are delegated, so the app can only act as the account
that signs in, and with assignment required only the Claude Assistant account can sign in. It lets
that one account make and receive Teams calls and use chat. It gives no access to anyone else's
calls, chats, mail or files.

## Step 1. Approve the permissions

Either:

1. Go to https://entra.microsoft.com, then **App registrations**, then **All applications**, and open
   **Claude Assistant Teams Sign-in**.
2. Open **API permissions** and select **Grant admin consent for Imperial Learning Ltd**. Confirm.
3. Both `Teams.ManageCalls` and `Teams.ManageChats` should show **Granted** with a green tick.

Or open this link while signed in as an administrator and select **Accept**:

```
https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=70f0d1c9-aff8-469c-99da-004cea4c7ea4&scope=https://auth.msft.communication.azure.com/.default
```

## Step 2. Prepare the Claude Assistant account

1. Go to https://admin.microsoft.com, then **Users**, then **Active users**, and open the assistant
   account.
2. **Licenses and apps**: make sure a licence that includes **Microsoft Teams** is assigned and the
   Teams app is switched on. **Office 365 A1 for faculty** includes Teams, and on 16 November 2026
   there were spare seats (950 bought, 667 assigned). Set the **usage location** if it is empty.
3. **Display name**: `Claude Assistant`. This is the name staff will search for in Teams.
4. Hand the account over to Nandika with a **temporary password** (step 2a below). She sets the
   real password and the multi-factor method herself at her first sign-in, so only she holds them.

## Step 2a. Temporary password for Nandika

1. In https://admin.microsoft.com, go to **Users**, then **Active users**, select the
   **Claude Assistant** account, and choose **Reset password**.
2. Let it **auto-generate** a password, and keep **Require this user to change their password when
   they first sign in** ticked. Do **not** tick "Email the sign-in info". Select **Reset password**
   and copy the temporary password shown.
3. In https://entra.microsoft.com, go to **Users**, open the **Claude Assistant** account, then
   **Authentication methods**. If any method is already registered (for example your own phone),
   delete it, then select **Require re-register multifactor authentication**. Nandika will then
   register her own method at first sign-in.
4. Give Nandika the **sign-in name** and the **temporary password**:
   * Best: in person or on a phone call.
   * If it has to be written: send it in a direct Teams chat or text message and ask her to confirm
     once she has signed in, so that the message can be deleted. Because the password must be
     changed at first sign-in, an old message is of no use afterwards.
   * Never by email to a shared mailbox or in a group chat.

Nandika then signs in once at https://teams.microsoft.com in a private browser window, sets the new
password, and registers Microsoft Authenticator on her phone when prompted. Optional but
recommended: she adds a second method (for example the department's phone number) so the account
is not lost if her phone is.

## Step 3. Assign the account to the app

Nandika may be able to do this as the app's owner. If she cannot:

1. Go to https://entra.microsoft.com, then **Enterprise applications**, and open
   **Claude Assistant Teams Sign-in**.
2. Open **Users and groups**, select **Add user/group**, choose the **Claude Assistant** account,
   and select **Assign**.

## Step 4. Conditional Access: nothing to do

Checked on 16 November 2026: our licences (Office 365 A1 and A3 for faculty and students, Teams
Premium for Faculty, and others) do not include Microsoft Entra ID P1, so Conditional Access is not
available and there are no policies to change. Skip this step.

Only keep multi-factor authentication on for the assistant account (security defaults already
require it). It is only used at the one-time sign-in.

If the organisation later buys Entra ID P1 (for example Microsoft 365 A3 or A5) and adds
Conditional Access policies, exclude the **Claude Assistant** account from any policy that blocks
the **device code flow** or sets a **sign-in frequency**.

## Step 5. Teams settings for the account

Go to https://admin.teams.microsoft.com, then **Users**, then **Manage users**, open the
**Claude Assistant** account, and open **Policies**.

1. **Calling policy**: it must allow **private calls** (the Global default does).
2. Optional: assign a calling policy with **Voicemail** turned off for this account, so that calls
   outside working hours do not leave voicemails that nobody reads.
3. Only if information barriers are used: make sure staff are allowed to call this account.

## Step 6. Licensing check

Please confirm with our Microsoft licensing partner that a licensed Microsoft 365 account may be
used by an automated assistant.

## When you are done

Send Nandika:

* "Steps 1, 2, 3 and 5 done" (step 4 needs nothing) and the result of step 6 when you have it.
* The Claude Assistant account's **sign-in name**, for example `claude.assistant@imperiallearning.co.uk`.
* The **temporary password** from step 2a, in person or by phone if possible.

Nandika then switches the feature on and connects the account. No further admin work is needed.

## If you ever need to switch it off

* **Revoke its access at once:** Entra, **Users**, the Claude Assistant account, **Revoke sessions**.
  The stored sign-in stops working immediately.
* **Block it:** set **Block sign in** on the account.
* **Remove the permissions:** Entra, **Enterprise applications**, Claude Assistant Teams Sign-in,
  **Permissions**, revoke; or delete the app registration.
