// Azure cost alert for the resource group. Deployed separately from base.bicep so that a
// subscription type without budget support does not block the main deployment.
// An Azure budget only sends alerts; it does not stop anything. The hard stops are the
// assistant's own budget guard (MONTHLY_BUDGET_USD) and the spend limit in the Claude Console.

@description('Monthly Azure spend for this resource group that triggers alerts, in the billing currency.')
param amount int = 25

@description('First day of the current month. Leave the default.')
param startDate string = utcNow('yyyy-MM-01')

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'meeting-assistant-monthly'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    // Alerts go to the people who hold Owner or Contributor on the resource group,
    // so no email address needs to be written into this file.
    notifications: {
      actual50: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 50, thresholdType: 'Actual', contactEmails: [], contactRoles: ['Owner', 'Contributor'] }
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: [], contactRoles: ['Owner', 'Contributor'] }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: [], contactRoles: ['Owner', 'Contributor'] }
    }
  }
}
