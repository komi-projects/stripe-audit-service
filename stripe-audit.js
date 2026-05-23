/**
 * Stripe Payment Recovery Audit Tool
 * Analyzes Stripe subscription data to find revenue leaks from failed payments
 * Usage: node stripe-audit.js --key sk_test_xxx [--days 30]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

class StripeAudit {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseHost = 'api.stripe.com';
  }

  async request(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const path = queryString ? `${endpoint}?${queryString}` : endpoint;
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseHost,
        path: path,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  async getAllPages(endpoint, params = {}) {
    const results = [];
    let hasMore = true;
    let startingAfter = null;

    while (hasMore) {
      const pageParams = { ...params, limit: 100 };
      if (startingAfter) pageParams.starting_after = startingAfter;

      const response = await this.request(endpoint, pageParams);
      results.push(...response.data);
      
      hasMore = response.has_more;
      if (hasMore && response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }
    }

    return results;
  }

  async runAudit(days = 30) {
    const cutoffDate = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
    
    console.log(`🔍 Running Stripe Payment Recovery Audit (last ${days} days)...\n`);

    try {
      // Get failed invoices
      const invoices = await this.getAllPages('/v1/invoices', {
        status: 'open',
        created: { gte: cutoffDate }
      });

      // Get all subscriptions to find past_due ones
      const subscriptions = await this.getAllPages('/v1/subscriptions', {
        status: 'past_due',
        created: { gte: cutoffDate }
      });

      // Get payment intents with failed status
      const paymentIntents = await this.getAllPages('/v1/payment_intents', {
        created: { gte: cutoffDate }
      });

      const failedPayments = paymentIntents.filter(pi => 
        pi.status === 'requires_payment_method' || 
        pi.status === 'canceled'
      );

      // Analyze data
      const analysis = this.analyze(invoices, subscriptions, failedPayments, days);
      
      // Generate report
      const report = this.generateReport(analysis, days);
      
      // Save report
      const reportPath = path.join(__dirname, `stripe-audit-report-${Date.now()}.md`);
      fs.writeFileSync(reportPath, report);
      
      console.log(report);
      console.log(`\n💾 Report saved to: ${reportPath}`);
      
      return analysis;
    } catch (error) {
      console.error('❌ Audit failed:', error.message);
      throw error;
    }
  }

  analyze(invoices, subscriptions, failedPayments, days) {
    const failedInvoiceAmount = invoices.reduce((sum, inv) => sum + (inv.amount_due || 0), 0);
    const pastDueAmount = subscriptions.reduce((sum, sub) => {
      const latestInvoice = sub.latest_invoice;
      return sum + (latestInvoice?.amount_due || 0);
    }, 0);

    const failedPaymentAmount = failedPayments.reduce((sum, pi) => sum + (pi.amount || 0), 0);
    
    // Calculate retry stats
    const retryAttempts = failedPayments.map(pi => (pi.charges?.data || []).length);
    const avgRetries = retryAttempts.length > 0 
      ? (retryAttempts.reduce((a, b) => a + b, 0) / retryAttempts.length).toFixed(1)
      : 0;

    // Estimate recovery potential (industry avg: 45-70% of failed payments recover with proper dunning)
    const recoveryRateLow = 0.45;
    const recoveryRateHigh = 0.70;
    const totalAtRisk = (failedInvoiceAmount + pastDueAmount + failedPaymentAmount) / 100;
    
    return {
      period: days,
      metrics: {
        openInvoices: invoices.length,
        openInvoiceAmount: failedInvoiceAmount / 100,
        pastDueSubscriptions: subscriptions.length,
        pastDueAmount: pastDueAmount / 100,
        failedPayments: failedPayments.length,
        failedPaymentAmount: failedPaymentAmount / 100,
        totalAtRisk: totalAtRisk,
        avgRetryAttempts: avgRetries
      },
      recovery: {
        conservativeEstimate: totalAtRisk * recoveryRateLow,
        optimisticEstimate: totalAtRisk * recoveryRateHigh,
        monthlyRunRate: (totalAtRisk / days) * 30
      },
      recommendations: this.generateRecommendations(invoices.length, subscriptions.length, avgRetries)
    };
  }

  generateRecommendations(openInvoices, pastDueSubs, avgRetries) {
    const recs = [];
    
    if (openInvoices > 5) {
      recs.push('🔴 HIGH PRIORITY: You have multiple open invoices. Set up automated dunning emails immediately.');
    }
    
    if (pastDueSubs > 3) {
      recs.push('🔴 HIGH PRIORITY: Multiple subscriptions in past_due state. Review your retry logic.');
    }
    
    if (avgRetries < 2) {
      recs.push('🟡 You\'re only retrying ~' + avgRetries + ' times. Stripe defaults to 4 retries — but smart timing can improve recovery by 20-40%.');
    }
    
    recs.push('🟢 Implement smart retry schedule: retry on days 1, 3, 7, 14 (not Stripe\'s default 2, 5, 10, 15).');
    recs.push('🟢 Send dunning emails BEFORE the first retry, not after 2 failures.');
    recs.push('🟢 Include a one-click update-payment-link in every dunning email.');
    recs.push('🟢 Consider offering a 7-day grace period for long-term customers.');
    
    return recs;
  }

  generateReport(analysis, days) {
    const m = analysis.metrics;
    const r = analysis.recovery;
    
    return `# Stripe Payment Recovery Audit Report
*Generated: ${new Date().toISOString()}*
*Period: Last ${days} days*

## 💰 Executive Summary

**Total Revenue at Risk: $${m.totalAtRisk.toFixed(2)}**

| Metric | Value |
|--------|-------|
| Open Invoices | ${m.openInvoices} ($${m.openInvoiceAmount.toFixed(2)}) |
| Past Due Subscriptions | ${m.pastDueSubscriptions} ($${m.pastDueAmount.toFixed(2)}) |
| Failed Payment Intents | ${m.failedPayments} ($${m.failedPaymentAmount.toFixed(2)}) |
| Avg Retry Attempts | ${m.avgRetryAttempts} |

## 📈 Recovery Potential

With proper payment recovery (smart retries + dunning emails):

- **Conservative estimate**: $${r.conservativeEstimate.toFixed(2)} recoverable
- **Optimistic estimate**: $${r.optimisticEstimate.toFixed(2)} recoverable
- **Monthly run rate**: ~$${r.monthlyRunRate.toFixed(2)}/month at risk

## 🎯 Recommendations

${analysis.recommendations.map(rec => `- ${rec}`).join('\n')}

## 🛠️ Next Steps

1. Export this report and share with your team
2. Set up Stripe webhooks for failed payment events
3. Implement smart retry logic (see: SimpleRecover)
4. Write 3 dunning email templates
5. Set up a dashboard to track recovery rate

---
*This audit was generated by the Stripe Payment Recovery Audit Tool.*
*For automated recovery, check out SimpleRecover (placeholder link).*
`;
  }
}

// CLI
function main() {
  const args = process.argv.slice(2);
  const keyIndex = args.indexOf('--key');
  const daysIndex = args.indexOf('--days');
  
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : process.env.STRIPE_SECRET_KEY;
  const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1]) : 30;

  if (!apiKey) {
    console.log(`
Stripe Payment Recovery Audit Tool

Usage:
  node stripe-audit.js --key sk_test_xxx [--days 30]
  
Environment variable:
  STRIPE_SECRET_KEY=sk_test_xxx node stripe-audit.js

Options:
  --key    Stripe secret key (test or live)
  --days   Number of days to analyze (default: 30)
`);
    process.exit(1);
  }

  const audit = new StripeAudit(apiKey);
  audit.runAudit(days).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = StripeAudit;
