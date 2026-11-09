// Industry Threat Packs — policy + detection bundles that compose with the core engine.
// Detection-rule shape mirrors THREAT_RULES in @cxtrust/core/src/detections.ts so
// conversationDetections-style evaluation can consume them unchanged.
//
// All scam patterns are research-grounded public fraud typologies (FTC, FinCEN,
// FBI IC3, state insurance fraud bureaus, HHS OCR) and are informative references
// only — no legal conclusions.

import type { Policy, PolicyRule } from '@cxtrust/core/src/policy.ts';
import type { DetectionCategory } from '@cxtrust/core/src/schema.ts';

/** Same shape as THREAT_RULES entries in cxtrust-core/src/detections.ts. */
export interface PackDetectionRule {
  code: string;
  title: string;
  category: DetectionCategory;
  weight: number;
  patterns: RegExp[];
  evidenceText: string;
}

export type ThreatPackIndustry =
  | 'banking' | 'insurance' | 'healthcare' | 'retail'
  | 'telecom' | 'government' | 'travel' | 'contact-center';

export interface ThreatPack {
  packId: string;
  industry: ThreatPackIndustry;
  name: string;
  description: string;
  /** Standalone PolicyRule set; bundled into a Policy with policyId = packId (e.g. PACK_BANKING_V1). */
  policyRules: PolicyRule[];
  detectionRules: PackDetectionRule[];
  /** Utterances that must NOT trip pack detections (demo-grade benign corpus for FP checks). */
  benignPatterns: string[];
  jurisdictions?: string[];
  refs?: string[];
}

// ---------------------------------------------------------------------------
// BANKING
// ---------------------------------------------------------------------------

const BANKING_PACK: ThreatPack = {
  packId: 'PACK_BANKING_V1',
  industry: 'banking',
  name: 'Banking Fraud Pack',
  description:
    'Wire-fraud escalation, Zelle/P2P social engineering, check fraud, elder-exploitation urgency and account-opening fraud detection for retail banking contact centers.',
  jurisdictions: ['US'],
  refs: [
    'FinCEN Advisories on scam typologies and BEC (FIN-2016-A003, FIN-2022 Alert-2)',
    'FBI IC3 reports on wire fraud, romance/impersonation and P2P payment scams',
    'FinCEN elder financial exploitation advisories (FIN-2020-A002)',
    'PCI DSS v4.0 (informative reference)',
  ],
  policyRules: [
    {
      id: 'BANK_R001_WIRE_ESCALATION',
      description: 'Large urgent wire requested via agent or caller: require human approval before execution',
      match: 'ALL',
      conditions: [
        { field: 'requestedAction', op: 'in', value: ['MONEY_TRANSFER', 'WIRE_TRANSFER'] },
        { field: 'amount', op: 'gt', value: 2500 },
      ],
      actions: ['REQUIRE_APPROVAL', 'STEP_UP_AUTH', 'ALLOW_WITH_MONITORING'],
      severity: 'HIGH',
    },
    {
      id: 'BANK_R002_P2P_REDIRECT',
      description: 'P2P/Zelle account change or send-money request: block and hand off to fraud desk',
      match: 'ALL',
      conditions: [
        { field: 'requestedAction', op: 'in', value: ['CHANGE_BANK_ACCOUNT', 'P2P_TRANSFER'] },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'],
      severity: 'HIGH',
    },
    {
      id: 'BANK_R003_NEW_ACCOUNT_HIGH_RISK',
      description: 'Account-opening request from unknown or synthetic participant: read-only pending verification',
      match: 'ANY',
      conditions: [
        { field: 'classification', op: 'in', value: ['UNKNOWN_AI', 'UNKNOWN_PARTICIPANT', 'SYNTHETIC_IDENTITY'] },
        { field: 'requestedAction', op: 'eq', value: 'OPEN_ACCOUNT' },
      ],
      actions: ['DENY', 'REQUIRE_APPROVAL'],
      severity: 'HIGH',
    },
    {
      id: 'BANK_R004_AGENT_TX_LIMIT_BANK',
      description: 'AI agent-initiated banking transaction over limit: human approval required',
      match: 'ALL',
      conditions: [
        { field: 'agent.agentId', op: 'exists', value: true },
        { field: 'amount', op: 'gt', value: 1000 },
      ],
      actions: ['REQUIRE_APPROVAL', 'ALLOW_WITH_MONITORING'],
      severity: 'HIGH',
    },
    {
      id: 'BANK_R005_UNKNOWN_AI_BANK',
      description: 'Unregistered AI participant in banking channel: read-only',
      match: 'ANY',
      conditions: [
        { field: 'classification', op: 'in', value: ['UNKNOWN_AI', 'MALICIOUS_AUTOMATION', 'SYNTHETIC_IDENTITY', 'UNKNOWN_PARTICIPANT'] },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'],
      severity: 'HIGH',
    },
  ],
  detectionRules: [
    {
      code: 'BANK_WIRE_ESCALATION',
      title: 'Wire fraud escalation language',
      category: 'FRAUD',
      weight: 18,
      patterns: [
        /\bwire (the )?(money|funds|payment|transfer)\b.{0,40}\b(today|right now|immediately|asap)\b/i,
        /\b(bank manager|branch manager|supervisor) (call|approval|authorize)\b.{0,40}\bwire\b/i,
        /\bclosing (is|at) (today|noon|3 ?pm)\b.{0,40}\bwire\b/i,
      ],
      evidenceText: 'Urgent wire-transfer language consistent with business email compromise / title-escrow fraud',
    },
    {
      code: 'BANK_P2P_PRESSURE',
      title: 'Zelle/P2P social engineering',
      category: 'FRAUD',
      weight: 17,
      patterns: [
        /\b(zelle|venmo|cash ?app|apple pay|paypal)\b.{0,60}\b(send|pay|transfer|reversal|refund)\b/i,
        /\bi (accidentally|mistakenly) (zelle|sent|venmo)'?d?\b.{0,60}\b(send it back|return the money)\b/i,
        /\byour account (was|is) (compromised|flagged)\b.{0,60}\bzelle\b.{0,40}\b(move|transfer) your (money|funds)\b/i,
      ],
      evidenceText: 'P2P payment request or fake "accidental payment" reversal play',
    },
    {
      code: 'BANK_CHECK_FRAUD',
      title: 'Check fraud markers',
      category: 'FRAUD',
      weight: 15,
      patterns: [
        /\b(mobile deposit).{0,30}\b(third[- ]party|someone else'?s|unknown) (check|person)\b/i,
        /\b(overpayment|extra) .{0,30}\b(send the difference|wire back the excess)\b/i,
        /\b(cash the check|deposit the check) .{0,40}\b(keep (some|a portion)|send|forward) (the|most of the) (rest|remainder|money)\b/i,
      ],
      evidenceText: 'Overpayment / third-party check deposit pattern typical of check fraud',
    },
    {
      code: 'BANK_ELDER_URGENCY',
      title: 'Elder-exploitation urgency and secrecy markers',
      category: 'CONVERSATION',
      weight: 14,
      patterns: [
        /\b(don'?t|do not) tell (my |the )?(wife|husband|son|daughter|kids|family|anyone)\b/i,
        /\b(sweepstakes|lottery|prize) .{0,60}\b(fee|tax|processing payment)\b/i,
        /\b(bank is in on|government is in on|do not trust the bank)\b/i,
      ],
      evidenceText: 'Secrecy demands and sweepstakes fee pattern flagged in elder financial exploitation advisories',
    },
    {
      code: 'BANK_ACCOUNT_OPENING_FRAUD',
      title: 'Account-opening fraud probing',
      category: 'FRAUD',
      weight: 16,
      patterns: [
        /\bopen (a|an) (account|checking|savings).{0,50}\b(no ssn|without ssn|fake (id|identity)|stolen identity)\b/i,
        /\b(how much|what)? ?(can i|could i) (deposit|open).{0,40}\b(no verification|skip verification|no id)\b/i,
        /\b(mule|drop) account\b/i,
      ],
      evidenceText: 'Identity-light or identity-fraud account opening probing consistent with mule-account recruitment',
    },
  ],
  benignPatterns: [
    'I would like to check my current balance please.',
    'Can you send me a copy of last month\'s statement?',
    'What are your branch hours on Saturday?',
    'I need to order a replacement debit card, mine expired.',
  ],
};

// ---------------------------------------------------------------------------
// INSURANCE
// ---------------------------------------------------------------------------

const INSURANCE_PACK: ThreatPack = {
  packId: 'PACK_INSURANCE_V1',
  industry: 'insurance',
  name: 'Insurance Fraud Pack',
  description:
    'Claims fraud language, ghost-brokering (unlicensed policy sales) and premium-refund diversion detection for P&C and life insurance operations.',
  jurisdictions: ['US'],
  refs: [
    'NAIC anti-fraud frameworks and Coalition Against Insurance Fraud public typologies (informative)',
    'State insurance fraud bureau reporting guidance (informative)',
    'NAIC Unfair Trade Practices model acts (informative)',
  ],
  policyRules: [
    {
      id: 'INS_R001_REFUND_DIVERSION',
      description: 'Premium refund redirected to a different payee: block and require fraud-desk review',
      match: 'ALL',
      conditions: [
        { field: 'requestedAction', op: 'in', value: ['ISSUE_REFUND', 'CHANGE_PAYMENT_METHOD'] },
        { field: 'intent', op: 'contains', value: 'REFUND_REDIRECT' },
      ],
      actions: ['DENY', 'REQUIRE_APPROVAL'],
      severity: 'HIGH',
    },
    {
      id: 'INS_R002_CLAIM_ESCALATION',
      description: 'High-value claim requested by agent: human adjuster approval required',
      match: 'ALL',
      conditions: [
        { field: 'requestedAction', op: 'eq', value: 'FILE_CLAIM' },
        { field: 'amount', op: 'gt', value: 5000 },
      ],
      actions: ['REQUIRE_APPROVAL', 'ALLOW_WITH_MONITORING'],
      severity: 'HIGH',
    },
    {
      id: 'INS_R003_UNKNOWN_AI_INS',
      description: 'Unregistered AI participant in insurance channel: read-only',
      match: 'ANY',
      conditions: [
        { field: 'classification', op: 'in', value: ['UNKNOWN_AI', 'MALICIOUS_AUTOMATION', 'SYNTHETIC_IDENTITY', 'UNKNOWN_PARTICIPANT'] },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'],
      severity: 'HIGH',
    },
    {
      id: 'INS_R004_AGENT_OVER_LIMIT',
      description: 'AI agent action over insurance transaction limit: human approval',
      match: 'ALL',
      conditions: [
        { field: 'agent.agentId', op: 'exists', value: true },
        { field: 'amount', op: 'gt', value: 2000 },
      ],
      actions: ['REQUIRE_APPROVAL', 'ALLOW_WITH_MONITORING'],
      severity: 'HIGH',
    },
  ],
  detectionRules: [
    {
      code: 'INS_CLAIM_FRAUD_MARKERS',
      title: 'Staged/exaggerated claim language',
      category: 'FRAUD',
      weight: 16,
      patterns: [
        /\b(no police report|no witness).{0,50}\b(total(ly)? (destroyed|burned|stolen))\b/i,
        /\b(make (the|it) look|pad the claim|inflate the (claim|damages|value))\b/i,
        /\b(slip and fall|water damage).{0,60}\b(before (the|my) (coverage|policy) (starts|started|lapsed))\b/i,
      ],
      evidenceText: 'Language consistent with staged or inflated claims in public insurance-fraud typologies',
    },
    {
      code: 'INS_GHOST_BROKERING',
      title: 'Ghost-broking (unlicensed policy sales)',
      category: 'FRAUD',
      weight: 18,
      patterns: [
        /\b(cheap|discounted) (car|auto|health) insurance\b.{0,60}\b(no broker license|not licensed|off the books)\b/i,
        /\b(i'?ll (get|find) you a (policy|quote)).{0,50}\b(cash|cash app|zelle) (only|payment)\b/i,
        /\b(policy is in someone else'?s name|fronted policy|borrowed policy)\b/i,
      ],
      evidenceText: 'Ghost-broking pattern: unlicensed intermediation and off-channel payments',
    },
    {
      code: 'INS_PREMIUM_REFUND_DIVERSION',
      title: 'Premium-refund diversion play',
      category: 'FRAUD',
      weight: 17,
      patterns: [
        /\b(send|put) (the |my )?(refund|premium refund)\b.{0,50}\b(different|other|new) (account|card|paypal|venmo)\b/i,
        /\b(cancel the policy).{0,60}\b(refund (to )?my (cousin|friend|girlfriend|boyfriend|agent)'?s? .{0,30}(account|card))\b/i,
        /\b(overpaid my premium).{0,60}\b(send the (difference|extra) to)\b/i,
      ],
      evidenceText: 'Redirect of premium refunds to alternate payees — diversion red flag',
    },
    {
      code: 'INS_IDENTITY_LOAN_PROBE',
      title: 'Policy-identity loan/cash-out probing',
      category: 'FRAUD',
      weight: 14,
      patterns: [
        /\b(borrow|take a loan) against (the|my|a) policy\b.{0,60}\b(without the owner knowing|owner won'?t know|no signature)\b/i,
        /\b(cash (out|surrender))\b.{0,50}\b(someone else'?s|my (late|deceased)) (policy|mom|father|husband|wife)'?s? policy\b/i,
      ],
      evidenceText: 'Attempt to monetize a policy outside owner-verified channels',
    },
  ],
  benignPatterns: [
    'I want to update my mailing address for policy documents.',
    'When does my auto policy renew this year?',
    'Can you email me my proof of insurance card?',
    'What is the deductible on my homeowner policy?',
  ],
};

// ---------------------------------------------------------------------------
// HEALTHCARE
// ---------------------------------------------------------------------------

const HEALTHCARE_PACK: ThreatPack = {
  packId: 'PACK_HEALTHCARE_V1',
  industry: 'healthcare',
  name: 'Healthcare Fraud & Privacy Pack',
  description:
    'Benefit/insurance fraud language, PHI probing and medical-identity-theft markers for provider and payer contact centers.',
  jurisdictions: ['US'],
  refs: [
    'HIPAA Privacy & Security Rules — PHI minimum-necessary principle (informative)',
    'HHS/OIG health-care fraud public typologies (informative)',
    'CMS Medicare fraud & abuse prevention materials (informative)',
  ],
  policyRules: [
    {
      id: 'HC_R001_PHI_PROBE_BLOCK',
      description: 'Request for another person\'s medical record or PHI: deny and hand off to privacy office',
      match: 'ALL',
      conditions: [
        { field: 'requestedAction', op: 'in', value: ['READ_MEDICAL_RECORD', 'REQUEST_PHI'] },
        { field: 'resource', op: 'contains', value: 'OTHER_PATIENT' },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'],
      severity: 'CRITICAL',
    },
    {
      id: 'HC_R002_BENEFIT_CHANGE_GATE',
      description: 'Benefit-plan or coverage change request: step-up verification required',
      match: 'ALL',
      conditions: [
        { field: 'requestedAction', op: 'in', value: ['CHANGE_BENEFITS', 'CHANGE_COVERAGE'] },
      ],
      actions: ['STEP_UP_AUTH', 'REQUIRE_APPROVAL'],
      severity: 'HIGH',
    },
    {
      id: 'HC_R003_UNKNOWN_AI_HC',
      description: 'Unregistered AI participant in healthcare channel: read-only',
      match: 'ANY',
      conditions: [
        { field: 'classification', op: 'in', value: ['UNKNOWN_AI', 'MALICIOUS_AUTOMATION', 'SYNTHETIC_IDENTITY', 'UNKNOWN_PARTICIPANT'] },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'],
      severity: 'HIGH',
    },
    {
      id: 'HC_R004_AGENT_OVER_LIMIT',
      description: 'AI agent action over healthcare-ops limit (claims volume/value): human approval',
      match: 'ALL',
      conditions: [
        { field: 'agent.agentId', op: 'exists', value: true },
        { field: 'amount', op: 'gt', value: 3000 },
      ],
      actions: ['REQUIRE_APPROVAL', 'ALLOW_WITH_MONITORING'],
      severity: 'HIGH',
    },
  ],
  detectionRules: [
    {
      code: 'HC_BENEFIT_FRAUD',
      title: 'Benefit/claims fraud language',
      category: 'FRAUD',
      weight: 16,
      patterns: [
        /\b(bill (it|this) (as|under)).{0,50}\b(different (procedure|diagnosis|code))\b/i,
        /\b(double[- ]bill|bill twice|split the claim)\b.{0,50}\b(cover|get paid more)\b/i,
        /\b(use (my )?(cousin|sister|brother|friend)'?s (insurance|card|medicaid))\b/i,
      ],
      evidenceText: 'Upcoding/double-billing or borrowed-coverage language from public healthcare-fraud typologies',
    },
    {
      code: 'HC_PHI_PROBING',
      title: 'PHI probing for third parties',
      category: 'DATA_EXPOSURE',
      weight: 17,
      patterns: [
        /\b(what (medications|treatments|diagnoses|tests))\b.{0,50}\b(my (ex|neighbor|coworker|employee))\b/i,
        /\b(is (she|he|they) (pregnant|hiv|hiv[- ]positive|cancer|on (antidepressants|suboxone)))\b.{0,30}\?/i,
        /\b(pull|look up) (the|their) (record|chart|file) (for|of) (someone|a person) (not|n't) (here|present|registered)\b/i,
      ],
      evidenceText: 'Attempt to obtain protected health information of a non-consenting third party',
    },
    {
      code: 'HC_MED_IDENTITY_THEFT',
      title: 'Medical identity theft markers',
      category: 'FRAUD',
      weight: 18,
      patterns: [
        /\b(use (my|someone else'?s|his|her) (insurance|medicare|medicaid) (number|card|id))\b.{0,40}\b(not mine|isn'?t mine|borrowed)\b/i,
        /\b(i (lost|don'?t have) my card).{0,60}\b(use my (mom|mother|wife|husband|brother)'?s)\b/i,
        /\b(free (equipment|supplies|genetic test|dna test)).{0,50}\b(need your (medicare|insurance) number)\b/i,
      ],
      evidenceText: 'Borrowed insurance identity or free-equipment Medicare-number harvesting play',
    },
    {
      code: 'HC_PHISH_PRESCRIPTION',
      title: 'Prescription/pharmacy social engineering',
      category: 'FRAUD',
      weight: 15,
      patterns: [
        /\b(refill (a )?prescription).{0,50}\b(for someone (else|other))\b.{0,40}\b(doctor won'?t call back|no doctor visit)\b/i,
        /\b(controlled substance|opioid|oxycodone|adderall).{0,60}\b(early refill|extra quantity|lost prescription)\b/i,
      ],
      evidenceText: 'Prescription refill diversion / controlled-substance social engineering markers',
    },
  ],
  benignPatterns: [
    'I need to reschedule my appointment for next Tuesday.',
    'Can you tell me what my copay is for a specialist visit?',
    'Please update my insurance information on file — here is my member card.',
    'Where can I pick up my prescription refill?',
  ],
};

// ---------------------------------------------------------------------------
// TELECOM
// ---------------------------------------------------------------------------

const TELECOM_PACK: ThreatPack = {
  packId: 'PACK_TELECOM_V1',
  industry: 'telecom',
  name: 'Telecom Fraud Pack',
  description:
    'SIM-swap social engineering, IMEI/ESN probing and premium-rate/Wangiri fraud detection for carrier care and retail channels.',
  jurisdictions: ['US'],
  refs: [
    'FCC SIM-swap and port-out fraud consumer guidance (informative)',
    'CTIA messaging principles and Robocall / STIR-SHAKEN materials (informative)',
    'GSMA fraud typology reports (informative)',
  ],
  policyRules: [
    {
      id: 'TEL_R001_SIM_SWAP_GATE',
      description: 'SIM swap or carrier-transfer request: deny until high-assurance verification completes',
      match: 'ALL',
      conditions: [
        { field: 'requestedAction', op: 'in', value: ['SIM_SWAP', 'PORT_NUMBER', 'CHANGE_SIM'] },
        { field: 'participant.identityConfidence', op: 'lt', value: 0.7 },
      ],
      actions: ['DENY', 'STEP_UP_AUTH', 'HANDOFF_TO_HUMAN'],
      severity: 'CRITICAL',
    },
    {
      id: 'TEL_R002_IMEI_CHANGE_READ_ONLY',
      description: 'Device IMEI/ESN change from low-trust participant: read-only pending verification',
      match: 'ANY',
      conditions: [
        { field: 'classification', op: 'in', value: ['UNKNOWN_AI', 'UNKNOWN_PARTICIPANT', 'HUMAN_UNKNOWN'] },
        { field: 'requestedAction', op: 'eq', value: 'CHANGE_DEVICE_IMEI' },
      ],
      actions: ['DENY', 'REQUIRE_APPROVAL'],
      severity: 'HIGH',
    },
    {
      id: 'TEL_R003_UNKNOWN_AI_TEL',
      description: 'Unregistered AI participant in telecom channel: read-only',
      match: 'ANY',
      conditions: [
        { field: 'classification', op: 'in', value: ['UNKNOWN_AI', 'MALICIOUS_AUTOMATION', 'SYNTHETIC_IDENTITY', 'UNKNOWN_PARTICIPANT'] },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'],
      severity: 'HIGH',
    },
    {
      id: 'TEL_R004_AGENT_OVER_LIMIT',
      description: 'AI agent account change over telecom value limit: human approval',
      match: 'ALL',
      conditions: [
        { field: 'agent.agentId', op: 'exists', value: true },
        { field: 'amount', op: 'gt', value: 500 },
      ],
      actions: ['REQUIRE_APPROVAL', 'ALLOW_WITH_MONITORING'],
      severity: 'HIGH',
    },
  ],
  detectionRules: [
    {
      code: 'TEL_SIM_SWAP_PRESSURE',
      title: 'SIM-swap social engineering',
      category: 'FRAUD',
      weight: 19,
      patterns: [
        /\bmy phone (is )?(lost|dead|broken|no signal)\b.{0,60}\b(activate|move|swap) (my )?(sim|number|line)\b.{0,40}\b(now|today|right now)\b/i,
        /\b(sim swap|swap my sim|transfer my number)\b.{0,60}\b(don'?t (send|need) (a )?(text|code|confirmation))\b/i,
        /\b(port (out |my )?number)\b.{0,50}\b(new carrier|different carrier)\b.{0,40}\b(emergency|immediately|asap)\b/i,
      ],
      evidenceText: 'SIM swap / port-out request with signal-loss cover story and bypass of confirmation steps',
    },
    {
      code: 'TEL_IMEI_PROBING',
      title: 'IMEI/ESN and provisioning probing',
      category: 'CONVERSATION',
      weight: 14,
      patterns: [
        /\b(check|look up|verify) (an |a |this )?(imei|esn|meid|serial)\b.{0,40}\b(blacklist|stolen|clean)\b/i,
        /\b(flash|clone|reprogram) (a|the|this) (phone|device|imei)\b/i,
        /\b(unlock (a|this|the) (phone|device)).{0,50}\b(not in my name|someone else'?s|found)\b/i,
      ],
      evidenceText: 'Device-identifier probing or reprogramming consistent with handset fraud',
    },
    {
      code: 'TEL_PREMIUM_RATE_FRAUD',
      title: 'Premium-rate / Wangiri fraud play',
      category: 'FRAUD',
      weight: 16,
      patterns: [
        /\b(call (this|that) number|dial).{0,30}\b(one (ring|missed call)|premium (rate|number)|9[01][0-9])\b.{0,40}\b(win|prize|claim)\b/i,
        /\b(international|premium) (number|line)\b.{0,50}\b(keep (me|the line) on|long call|conference)\b/i,
        /\b(charge|billed).{0,40}\b(9[00]\d|premium sms|ring tone subscription)\b.{0,40}\b(i didn'?t sign up|never ordered)\b/i,
      ],
      evidenceText: 'Premium-rate callback / Wangiri or cramming complaint pattern',
    },
    {
      code: 'TEL_OTP_INTERCEPT',
      title: 'SMS/OTP interception behavior',
      category: 'FRAUD',
      weight: 17,
      patterns: [
        /\b(read|tell|forward) (me )?(the|any) (text|sms|code).{0,40}\b(bank|paypal|amazon|instagram|whatsapp)\b/i,
        /\bi'?m not getting (the|any) (text|code)s?\b.{0,40}(send|activate) (to|on) (a )?new (sim|device)\b/i,
        /\b(set up call forwarding).{0,40}\b(all calls|before i can answer|to a different number)\b/i,
      ],
      evidenceText: 'Attempt to intercept SMS one-time codes or reroute the line',
    },
  ],
  benignPatterns: [
    'I want to upgrade my phone to the newest model.',
    'How much data is left in my plan this month?',
    'Can I add a second line for my daughter?',
    'My internet speed seems slow, can you run a line test?',
  ],
};

export const THREAT_PACKS: ThreatPack[] = [
  BANKING_PACK,
  INSURANCE_PACK,
  HEALTHCARE_PACK,
  TELECOM_PACK,
];

/** Standalone Policy built from a pack's rules (composable via compilePolicy). */
export function packPolicy(pack: ThreatPack): Policy {
  return {
    policyId: pack.packId,
    name: pack.name,
    version: 1,
    rules: pack.policyRules,
    failMode: 'CLOSED',
  };
}

/** The pack's Policy object (industry alias of packPolicy). */
export function getPack(packId: string): ThreatPack | undefined {
  return THREAT_PACKS.find(p => p.packId === packId);
}
