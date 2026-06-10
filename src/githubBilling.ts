/**
 * githubBilling.ts
 * -----------------------------------------------------------------------------
 * The closest Copilot analog to Token Optimizer's "usage limits" panel: pull the
 * authoritative Copilot premium-request spend straight from GitHub's enhanced
 * billing usage API, so the dollar estimate can be calibrated automatically
 * instead of by hand.
 *
 *   GET /users/{username}/settings/billing/usage?year=&month=
 *
 * Needs a fine-grained PAT with the **Plan** account permission (read-only).
 * Network + auth only happen when the user explicitly runs the command — there's
 * no background polling. Uses Node's https (zero dependencies).
 */

import * as https from 'https';

interface HttpResult {
  status: number;
  body: string;
}

const COMMON_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'token-coach-vscode',
};

function getJson(url: string, token: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers: { ...COMMON_HEADERS, Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Friendlier error text for the common failure modes. */
function describeError(status: number, body: string): string {
  const snippet = body ? ` — ${body.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  if (status === 401) {
    return 'GitHub rejected the token (401). Check that it is valid and not expired.';
  }
  if (status === 403) {
    return 'GitHub denied access (403). The token needs the fine-grained "Plan" account permission (read-only).';
  }
  if (status === 404) {
    return 'Usage not found (404). Check the username, or that enhanced billing is enabled for this account.';
  }
  return `GitHub billing API returned ${status}${snippet}`;
}

/** Resolve the login for a token (so the user doesn't have to type their username). */
export async function fetchGitHubLogin(token: string): Promise<string> {
  const res = await getJson('https://api.github.com/user', token);
  if (res.status !== 200) {
    throw new Error(describeError(res.status, res.body));
  }
  const data = JSON.parse(res.body) as { login?: string };
  if (!data.login) {
    throw new Error('Could not read the GitHub login from that token.');
  }
  return data.login;
}

export interface CopilotUsage {
  /**
   * Gross AI credits consumed in the period — the authoritative "how much you
   * used" number (e.g. the `1,701.7 / 5,000` GitHub shows). This is what we sync
   * to, NOT the net/billed amount: while you're under your included allowance,
   * net is ~$0 but gross is your real consumption. 1 credit = 1 AIU = $0.01.
   */
  grossCredits: number;
  /** Gross USD for Copilot credit usage (= grossCredits × $0.01). */
  grossUsd: number;
  /** Credits covered by the plan's included allowance (the discount). */
  discountCredits: number;
  /** Net (paid overage) USD after the included allowance. ~0 while under budget. */
  netUsd: number;
  /** How many Copilot credit line items contributed. */
  items: number;
}

/** One row of the billing usage report (the fields we care about). */
interface UsageItem {
  product?: string;
  sku?: string;
  unitType?: string;
  quantity?: number;
  grossAmount?: number;
  discountAmount?: number;
  netAmount?: number;
}

/** Is this usage row Copilot AI-credit consumption (vs seats, storage, …)? */
function isCopilotCredits(it: UsageItem): boolean {
  const product = (it.product ?? '').toLowerCase();
  if (!product.includes('copilot')) {
    return false;
  }
  const unit = (it.unitType ?? '').toLowerCase();
  const sku = (it.sku ?? '').toLowerCase();
  // Prefer the explicit credits unit; fall back to the SKU naming, and finally to
  // any Copilot row that carries a quantity (older/edge response shapes).
  return unit.includes('credit') || sku.includes('credit') || typeof it.quantity === 'number';
}

/** Sum Copilot credit consumption from a parsed usage report. */
function sumCopilotCredits(body: string): CopilotUsage {
  let parsed: { usageItems?: UsageItem[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('GitHub billing API returned a response we could not parse.');
  }

  const usage: CopilotUsage = {
    grossCredits: 0,
    grossUsd: 0,
    discountCredits: 0,
    netUsd: 0,
    items: 0,
  };
  for (const it of parsed.usageItems ?? []) {
    if (!isCopilotCredits(it)) {
      continue;
    }
    const qty = typeof it.quantity === 'number' ? it.quantity : 0;
    usage.grossCredits += qty;
    usage.grossUsd += typeof it.grossAmount === 'number' ? it.grossAmount : 0;
    usage.netUsd += typeof it.netAmount === 'number' ? it.netAmount : 0;
    const discAmt = typeof it.discountAmount === 'number' ? it.discountAmount : 0;
    // discountAmount is in $; credits = $ / 0.01. (No discountQuantity in the schema.)
    usage.discountCredits += discAmt / 0.01;
    usage.items += 1;
  }
  return usage;
}

/**
 * Pull Copilot AI-credit consumption for a given month.
 *
 * For Business / Enterprise seats whose license is billed through an org, the
 * per-user endpoint returns nothing — GitHub's docs are explicit that managed
 * usage isn't in user-level endpoints. Pass an `org` to hit the organization
 * endpoint instead (needs a token with org billing read access).
 */
export async function fetchCopilotMonthUsage(
  token: string,
  account: { username?: string; org?: string },
  year: number,
  month: number
): Promise<CopilotUsage> {
  const base = account.org
    ? `https://api.github.com/organizations/${encodeURIComponent(account.org)}/settings/billing/usage`
    : `https://api.github.com/users/${encodeURIComponent(account.username ?? '')}/settings/billing/usage`;
  const res = await getJson(`${base}?year=${year}&month=${month}`, token);
  if (res.status !== 200) {
    throw new Error(describeError(res.status, res.body));
  }
  return sumCopilotCredits(res.body);
}
