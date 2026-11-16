# Setting up the assistant's own Teams account

Written 16 November 2026. For the Microsoft 365 / Entra administrator, with one part for whoever
deploys the service.

When this is done, staff can:

* **Call the assistant** like a colleague (search "Claude Assistant" in Teams and press Call) to
  catch up on meetings they attended. It is a private call: it only discusses meetings the caller
  attended, and stops if anyone else joins.
* **Add the assistant to a call**, including a one-to-one call. Teams turns the call into a group
  call, the assistant joins without a lobby, and it works as in meetings: "Hey Claude", a recap
  afterwards (sent to the person who added it), and up to 20 general knowledge questions.

The code is already deployed and switched off. Nothing changes for staff until step 6.

## What you need first

* The new Microsoft 365 account for the assistant, with a licence that includes Teams. Below it is
  called `claude.assistant@imperiallearning.co.uk`; use the real name.
* Global Administrator, or Cloud Application Administrator plus Teams Administrator.
* About 30 minutes.

## Step 1. Prepare the assistant account

1. Go to https://admin.microsoft.com, then **Users**, then **Active users**, and open the account.
2. Under **Licenses and apps**, confirm that a licence with **Microsoft Teams** is assigned and that
   the Teams app is switched on.
3. Set **Display name** to `Claude Assistant`. Staff will search for this name.
4. Sign in as the account once at https://teams.microsoft.com in a private browser window, so that
   Teams finishes setting it up, and complete the multi-factor registration. Sign out afterwards.
5. Write down the account's **Object ID**: https://entra.microsoft.com, then **Users**, open the
   account, and copy **Object ID** from the Overview page.

## Step 2. Create the sign-in app registration

This app is only used to sign the assistant account in. It is separate from the bot's app.

1. Go to https://entra.microsoft.com, then **App registrations**, then **New registration**.
2. **Name**: `Claude Assistant Teams Sign-in`.
3. **Supported account types**: *Accounts in this organizational directory only*.
4. **Redirect URI**: leave empty. Select **Register**.
5. On the new app's **Overview** page, copy the **Application (client) ID**. You need it in step 5.
6. Open **Authentication**. Under **Advanced settings**, set **Allow public client flows** to
   **Yes**, and select **Save**. The sign-in in step 6 uses a device code, which needs this.
7. Open **API permissions**, then **Add a permission**, then the **APIs my organization uses** tab.
   Search for **Azure Communication Services** (application ID
   `1fd5118e-2576-4263-8130-9503064c837a`) and open it.
8. Choose **Delegated permissions**, tick **Teams.ManageCalls** and **Teams.ManageChats**, and
   select **Add permissions**. (Leave `TeamsExtension.ManageCalls` unticked.)
9. Select **Grant admin consent for Imperial Learning Ltd** and confirm. Both permissions should show
   a green tick.

## Step 3. Allow only the assistant account to use that app

This stops anyone else from signing in through it.

1. In https://entra.microsoft.com, go to **Enterprise applications** and open
   **Claude Assistant Teams Sign-in**.
2. Open **Properties**, set **Assignment required?** to **Yes**, and select **Save**.
3. Open **Users and groups**, select **Add user/group**, choose the assistant account, and select
   **Assign**.

## Step 4. Check Conditional Access and Teams settings

Imperial Learning Ltd has no Microsoft Entra ID P1 licence (checked 16 November 2026), so
Conditional Access is not available and points 1 and 2 do not apply today. Do point 3, and point 4
if relevant.

1. **Device code sign-in.** If a Conditional Access policy blocks the *device code flow*
   (Conditional Access, Policies, look for "Authentication flows"), exclude the assistant account
   from it. If you prefer, exclude it only for the day you do step 6, then put it back. The
   assistant keeps its sign-in afterwards without device code.
2. **Sign-in frequency.** A policy that forces re-sign-in every few hours or days also applies to
   the assistant. Exclude the assistant account from it, or accept that an admin repeats step 6 at
   that interval. The assistant says "not connected" in the service logs when this is needed.
3. **Teams calling.** In https://admin.teams.microsoft.com, go to **Users**, then **Manage users**,
   open the assistant account, then **Policies**. Its **Calling policy** must allow private calls
   (the Global default does). Optional: use a calling policy that turns **Voicemail** off for this
   account, so calls outside working hours do not leave voicemails nobody reads.
4. **Information barriers** (only if your organisation uses them): make sure staff are allowed to
   call the assistant account.

## Step 5. Switch the feature on in Azure (whoever deploys the service)

Collect:

* The **Application (client) ID** from step 2.5.
* The assistant account's **sign-in name**, for example `claude.assistant@imperiallearning.co.uk`.
* The **Object IDs of the people** who may connect the account in step 6 (from Entra, Users,
  Overview), separated by commas. They do not need to be Microsoft administrators.

Redeploy the services template with these parameters (plus the usual ones, as in `docs/SETUP.md`):

```
teamsIdentityClientId=<client id from step 2>
teamsAssistantUpn=<assistant sign-in name>
adminAadIds=<admin object id>,<another admin object id>
receiverEnabled=true
imageTag=0.4.0
```

`receiverEnabled=true` creates the call receiver: from 07:00 UTC on weekdays until 18:00 UK time it
is signed in as the assistant and answers calls. It costs roughly $35 to $45 a month for those
hours (1 vCPU and 2 GiB for the whole window, plus the control service staying awake). Outside those
hours the assistant appears offline and calls are not answered. Change the hours with
`standbyStartCron` and `standbyUntil`.

## Step 6. Connect the account (anyone listed in step 5, about 5 minutes)

This needs no Microsoft admin role. It needs someone whose Object ID is in `adminAadIds` (step 5)
and who has the assistant account's password and multi-factor method, because they sign in as the
assistant once.

1. In Teams, open your personal chat with **Claude Meeting Assistant** and send:
   `connect assistant account`
2. It replies with a link (https://microsoft.com/devicelogin) and a code.
3. Open the link in a **private browser window**, enter the code, and sign in **as the assistant
   account**, not as yourself. Complete multi-factor sign-in if asked, and accept.
4. Back in Teams the assistant replies **Connected**. If you signed in with the wrong account it says
   so and discards that sign-in; try again with the assistant account.
5. Send `assistant account status` at any time to check.

The sign-in is stored encrypted (AES-256-GCM, key derived from the service's secret, which lives
only in Azure's secret store) in the private storage account. It renews itself while it is used.

## Step 7. Test it

Do this during the receiver hours, after step 6.

1. **Recognition.** Callers must have used the app once: each tester sends `help` to
   **Claude Meeting Assistant** in Teams first. Calls from anyone else are declined.
2. **Direct call.** Search **Claude Assistant** in Teams and press **Call** (audio). It answers and
   says "Hi, it's Claude. Which meeting would you like to catch up on?" Ask: "Summarise my last
   meeting." No "Hey Claude" is needed in a direct call.
3. **Added to a one-to-one call.** Two testers call each other. One of them selects **People**, then
   **Add people**, and adds **Claude Assistant**. It joins, says "Claude assistant has joined. I'm
   transcribing this meeting." Say "Hey Claude, what have we covered so far?". Hang up; the recap
   arrives in the personal chat of the person who added it.
4. **General knowledge.** In a call or meeting, ask "Hey Claude, what does SCORM stand for?" It
   answers and says it is general knowledge. After 20 such answers in one meeting it says the
   allowance is used.

Tell the developer the results. If the assistant does not answer, the service logs show why: look
for "Incoming call", "Declining a call" or "not connected".

## Turning it off or disconnecting

* **Stop answering calls:** redeploy with `receiverEnabled=false`.
* **Remove its access immediately:** Entra, Users, the assistant account, **Revoke sessions**. This
  invalidates the stored sign-in. Then block sign-in on the account if needed.
* **Remove the permission:** Entra, Enterprise applications, Claude Assistant Teams Sign-in,
  Permissions, revoke, or delete the app registration.

## Limits to know

* One call at a time. If the assistant is already in a call, further calls ring out.
* Only during the receiver hours.
* Not yet tested end to end: the code is built and its logic is tested, but answering real calls as
  a Teams user can only be proven after steps 1 to 6. Plan a short test session for step 7.
* Check with your Microsoft licensing partner that a licensed account may be used by an automated
  assistant.
