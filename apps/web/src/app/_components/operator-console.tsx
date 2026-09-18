'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useVetoWallet, type RuleDraft, type VetoWallet } from './use-veto-wallet';
import { formatAnnualizedFee, formatWadPercent } from '@/lib/policy-builder';
import type { dayThreeEvidence } from '@/data/day-three';

type Evidence = typeof dayThreeEvidence;
type View = 'overview' | 'rules' | 'activity' | 'evidence';

const navigation: ReadonlyArray<{ view: View; label: string; icon: string }> = [
  { view: 'overview', label: 'Overview', icon: 'grid' },
  { view: 'rules', label: 'Exit rules', icon: 'route' },
  { view: 'activity', label: 'Activity', icon: 'pulse' },
  { view: 'evidence', label: 'Evidence', icon: 'proof' },
];

function explorerTransaction(hash: string): string {
  return `https://base-sepolia.blockscout.com/tx/${hash}`;
}

function explorerAddress(address: string): string {
  return `https://base-sepolia.blockscout.com/address/${address}`;
}

function shorten(value: string, start = 6, end = 4): string {
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    grid: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />,
    route: <path d="M5 5h6v6H5zM13 13h6v6h-6zM8 11v2a3 3 0 0 0 3 3h2M11 8h5a3 3 0 0 1 3 3v2" />,
    pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    proof: <path d="M6 3h9l3 3v15H6zM14 3v4h4M9 12h6M9 16h6" />,
    arrow: <path d="m9 18 6-6-6-6" />,
    external: <path d="M14 4h6v6M20 4l-9 9M18 13v6H5V6h6" />,
    wallet: <path d="M4 7h15v12H4zM4 7l2-3h11l2 3M15 12h6v4h-6z" />,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </>
    ),
  };

  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
      {paths[name]}
    </svg>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'brand brand-compact' : 'brand'}>
      <Image alt="" height={42} priority src="/brand/veto-mark.png" width={42} />
      <div>
        <strong>VETO</strong>
        {compact ? null : <span>Depositor exit control</span>}
      </div>
    </div>
  );
}

function ExternalLink({ href, children }: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <a className="text-link" href={href} rel="noreferrer" target="_blank">
      {children}
      <Icon name="external" />
    </a>
  );
}

function StatusChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`status-chip status-${tone}`}>{children}</span>;
}

function PolicySummaryView({ config }: { config: Record<string, any> }) {
  const flags = BigInt(String(config.policyFlags ?? '0'));
  const hasMgmt = (flags & 1n) !== 0n;
  const hasPerf = (flags & 2n) !== 0n;
  const hasCap = (flags & 4n) !== 0n;
  const hasAdapter = (flags & 8n) !== 0n;
  const hasGate = (flags & 16n) !== 0n;

  return (
    <div className="active-rule-summary-chips">
      {hasPerf && (
        <span className="summary-chip">
          Performance fee ≤ {formatWadPercent(BigInt(String(config.maxPerformanceFee ?? '0')))}
        </span>
      )}
      {hasMgmt && (
        <span className="summary-chip">
          Management fee ≤ {formatAnnualizedFee(BigInt(String(config.maxManagementFee ?? '0')))}
        </span>
      )}
      {hasCap &&
        Array.isArray(config.relativeCaps) &&
        config.relativeCaps.length > 0 &&
        config.relativeCaps.map((c: any, i: number) => (
          <span className="summary-chip" key={i}>
            Cap {shorten(String(c.riskId), 6, 4)} ≤{' '}
            {formatWadPercent(BigInt(String(c.maxRelativeCap ?? '0')))}
          </span>
        ))}
      {hasAdapter && (
        <span className="summary-chip">
          {Array.isArray(config.approvedAdapters) && config.approvedAdapters.length > 0
            ? `${config.approvedAdapters.length} approved adapters`
            : 'Strict adapter allowlist'}
        </span>
      )}
      {hasGate && <span className="summary-chip">Approved gates</span>}
    </div>
  );
}

function Overview({
  evidence,
  openNewRule,
  wallet,
  setView,
}: {
  evidence: Evidence;
  openNewRule: () => void;
  wallet: VetoWallet;
  setView: (view: View) => void;
}) {
  const liveRule = wallet.rules.find((rule) => rule.state === 'ACTIVE');

  if (!wallet.address) {
    return (
      <div className="view-enter disconnected-hero">
        <span className="brand-badge">VETO</span>
        <h1>Your right to leave before the rules change.</h1>
        <p>
          Set the conditions under which your Morpho position is allowed to stay. If a queued vault
          change crosses your boundary, VETO can execute your pre-authorized exit.
        </p>
        <div className="hero-actions">
          <button className="button button-primary" onClick={wallet.connect} type="button">
            <Icon name="wallet" /> Connect wallet
          </button>
          <button className="button button-ghost" onClick={() => setView('evidence')} type="button">
            View public proof →
          </button>
        </div>
        <span className="hero-subline">
          Built for Morpho Vault V2 · Execution through KeeperHub
        </span>
      </div>
    );
  }

  const shares = wallet.position?.position.sharesFormatted ?? '0';
  const shareSymbol = wallet.position?.position.shareSymbol ?? 'shares';
  const assets = wallet.position?.position.assetsFormatted ?? '0';
  const assetSymbol = wallet.position?.position.assetSymbol ?? 'USDC';
  const vaultName = wallet.position?.position.symbol
    ? `${wallet.position.position.symbol} Vault`
    : 'Supported Morpho Vault';

  return (
    <div className="view-enter connected-overview">
      <article className="surface position-card">
        <div className="position-card-top">
          <div>
            <span className="panel-label">Your position</span>
            <h2>{vaultName}</h2>
          </div>
          <button className="button button-primary" onClick={openNewRule} type="button">
            Set exit rule
          </button>
        </div>
        <div className="position-card-balance">
          <div className="balance-main">
            <strong>{shares}</strong>
            <span>{shareSymbol}</span>
          </div>
          <div className="balance-approx">
            ≈ {assets} {assetSymbol}
          </div>
        </div>
      </article>

      {liveRule ? (
        <article className="surface active-protection-card">
          <div className="surface-heading">
            <div>
              <span className="panel-label">Active protection</span>
              <h2>Protection active</h2>
            </div>
            <StatusChip tone="verified">Watching</StatusChip>
          </div>

          <div style={{ margin: '14px 0' }}>
            {liveRule.policy_config_json ? (
              <PolicySummaryView config={liveRule.policy_config_json} />
            ) : (
              <span className="summary-chip">
                Management fee ≤{' '}
                {liveRule.max_fee_per_second
                  ? formatAnnualizedFee(BigInt(liveRule.max_fee_per_second))
                  : '1.00%'}
              </span>
            )}
          </div>

          <div className="protection-meta-grid">
            <div>
              <span>Shares protected</span>
              <strong>{shares}</strong>
            </div>
            <div>
              <span>Minimum return</span>
              <strong>
                {assets} {assetSymbol}
              </strong>
            </div>
            <div>
              <span>Expires</span>
              <strong>7 days</strong>
            </div>
            <div>
              <span>Status</span>
              <strong style={{ color: 'var(--blue)' }}>Watching</strong>
            </div>
          </div>

          <div style={{ marginTop: '16px' }}>
            <button
              className="button button-danger"
              disabled={wallet.action.stage === 'cancelling'}
              onClick={() => void wallet.cancelRule(liveRule.mandate_id)}
              type="button"
            >
              Cancel rule
            </button>
          </div>
        </article>
      ) : (
        <article className="surface empty-protection-card">
          <h2>No exit rule yet</h2>
          <p>Choose the changes that should trigger your exit.</p>
          <button className="button button-primary" onClick={openNewRule} type="button">
            Set exit rule
          </button>
        </article>
      )}
    </div>
  );
}

function Rules({ openNewRule, wallet }: { openNewRule: () => void; wallet: VetoWallet }) {
  const liveRule = wallet.rules.find((rule) => rule.state === 'ACTIVE');

  if (!wallet.address) {
    return (
      <div className="view-enter">
        <section className="page-intro">
          <div>
            <h1>Exit rules</h1>
            <p>Connect your wallet to view exit rules.</p>
          </div>
        </section>
        <article className="surface empty-protection-card">
          <button className="button button-primary" onClick={wallet.connect} type="button">
            <Icon name="wallet" /> Connect wallet
          </button>
        </article>
      </div>
    );
  }

  if (!liveRule) {
    return (
      <div className="view-enter">
        <section className="page-intro">
          <div>
            <h1>Exit rules</h1>
            <p>You haven&apos;t set an exit rule for this position.</p>
          </div>
        </section>
        <article className="surface empty-protection-card">
          <h2>No exit rule yet</h2>
          <p>Choose the changes that should trigger your exit.</p>
          <button className="button button-primary" onClick={openNewRule} type="button">
            Set exit rule
          </button>
        </article>
      </div>
    );
  }

  const shares = wallet.position?.position.sharesFormatted ?? '10';
  const assets = wallet.position?.position.assetsFormatted ?? '9.5';
  const assetSymbol = wallet.position?.position.assetSymbol ?? 'USD';

  return (
    <div className="view-enter">
      <section className="page-intro page-intro-action">
        <div>
          <h1>Exit rules</h1>
        </div>
        <button className="button button-secondary" onClick={openNewRule} type="button">
          Update exit rule
        </button>
      </section>

      <article className="surface active-protection-card">
        <div className="surface-heading">
          <div>
            <span className="status-chip status-verified">ACTIVE</span>
            <h2 style={{ marginTop: '0.5rem' }}>
              {wallet.position?.position.symbol
                ? `${wallet.position.position.symbol} Vault`
                : 'Demo Vault'}
            </h2>
          </div>
        </div>

        <div style={{ margin: '14px 0' }}>
          {liveRule.policy_config_json ? (
            <PolicySummaryView config={liveRule.policy_config_json} />
          ) : (
            <span className="summary-chip">
              Management fee ≤{' '}
              {liveRule.max_fee_per_second
                ? formatAnnualizedFee(BigInt(liveRule.max_fee_per_second))
                : '1.00%'}
            </span>
          )}
        </div>

        <div className="protection-meta-grid">
          <div>
            <span>Shares protected</span>
            <strong>{shares}</strong>
          </div>
          <div>
            <span>Minimum return</span>
            <strong>
              {assets} {assetSymbol}
            </strong>
          </div>
          <div>
            <span>Expires</span>
            <strong>7 days</strong>
          </div>
        </div>

        <div style={{ marginTop: '16px' }}>
          <button
            className="button button-danger"
            disabled={wallet.action.stage === 'cancelling'}
            onClick={() => void wallet.cancelRule(liveRule.mandate_id)}
            type="button"
          >
            Cancel rule
          </button>
        </div>
      </article>
    </div>
  );
}

function Activity({ wallet, setView }: { wallet: VetoWallet; setView: (view: View) => void }) {
  if (!wallet.address) {
    return (
      <div className="view-enter">
        <section className="page-intro">
          <div>
            <h1>Activity</h1>
            <p>Connect your wallet to view activity.</p>
          </div>
        </section>
        <article className="surface empty-protection-card">
          <button className="button button-primary" onClick={wallet.connect} type="button">
            <Icon name="wallet" /> Connect wallet
          </button>
          <div style={{ marginTop: '16px' }}>
            <button
              className="button button-ghost"
              onClick={() => setView('evidence')}
              type="button"
            >
              View public execution history →
            </button>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="view-enter">
      <section className="page-intro">
        <div>
          <h1>Activity</h1>
          <p>Recent activity for {shorten(wallet.address)}</p>
        </div>
      </section>

      {wallet.rules.length > 0 ? (
        <article className="surface activity-log">
          {wallet.rules.map((rule) => (
            <div className="activity-row" key={rule.mandate_id}>
              <div className="activity-icon event-result">
                <Icon name="check" />
              </div>
              <div className="activity-copy">
                <strong>Exit rule armed</strong>
                <span>
                  Mandate #{rule.mandate_id} · {rule.state}
                </span>
              </div>
              <div className="activity-meta">
                <span>{shorten(rule.arm_transaction_hash, 8, 6)}</span>
              </div>
            </div>
          ))}
        </article>
      ) : (
        <article className="surface empty-protection-card">
          <p>No recent activity for this address.</p>
          <button className="button button-ghost" onClick={() => setView('evidence')} type="button">
            View public execution history →
          </button>
        </article>
      )}
    </div>
  );
}

function EvidenceView({ evidence }: { evidence: Evidence }) {
  return (
    <div className="view-enter">
      <section className="page-intro">
        <div>
          <h1>Evidence</h1>
          <p>Use the onchain receipt as the final source of truth.</p>
        </div>
        <StatusChip tone="verified">Public execution</StatusChip>
      </section>
      <section className="evidence-grid">
        <article className="surface evidence-facts">
          <span className="panel-label">Production compatibility</span>
          <h2>Gauntlet USDC Prime</h2>
          <p>
            VETO operates against real Morpho Vault V2 architecture. Public testnet execution runs
            on Base Sepolia with valueless test tokens, while read and simulation proofs directly
            target the live Gauntlet vault on Base Mainnet.
          </p>
          <dl>
            <div>
              <dt>Live mainnet read</dt>
              <dd>Read-only state verification (0x050c…56f0, timelock 3.0d)</dd>
            </div>
            <div>
              <dt>Pinned fork proof</dt>
              <dd>Simulation of real depositor exit ($3.07M USDC)</dd>
            </div>
            <div>
              <dt>Public testnet execution</dt>
              <dd>Live KeeperHub transaction with test token</dd>
            </div>
            <div>
              <dt>Fund safety</dt>
              <dd>Zero custody: funds redeem directly to owner</dd>
            </div>
          </dl>
          <ExternalLink href="https://basescan.org/address/0x050cE30b927Da55177A4914EC73480238BAD56f0">
            Open Gauntlet USDC Prime on Basescan
          </ExternalLink>
        </article>

        <article className="surface evidence-facts">
          <span className="panel-label">Public execution</span>
          <h2>KeeperHub conditional execution</h2>
          <p>
            Morpho proposal queued above fee ceiling. KeeperHub verified the condition onchain and
            executed VetoExitGuard to redeem shares directly to the owner.
          </p>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>Success ({evidence.result.state})</dd>
            </div>
            <div>
              <dt>KeeperHub execution ID</dt>
              <dd>{evidence.result.executionId}</dd>
            </div>
            <div>
              <dt>Block</dt>
              <dd>{evidence.result.blockNumber}</dd>
            </div>
            <div>
              <dt>Returned assets</dt>
              <dd>
                {evidence.result.assetsReturned} {evidence.position.assetName}
              </dd>
            </div>
            <div>
              <dt>Mandate consumed</dt>
              <dd>Yes (single-use enforced)</dd>
            </div>
          </dl>
          <ExternalLink href={explorerTransaction(evidence.result.transactionHash)}>
            Open Blockscout receipt
          </ExternalLink>
        </article>

        <article className="surface evidence-facts">
          <span className="panel-label">Safe revocation</span>
          <h2>Zero broadcast on curator revocation</h2>
          <p>
            When a proposal was revoked onchain by the curator, KeeperHub read executableAt = 0,
            evaluated condition false, and safely withheld execution with zero financial broadcast.
          </p>
          <dl>
            <div>
              <dt>KeeperHub action</dt>
              <dd>Execution withheld (executed: false)</dd>
            </div>
            <div>
              <dt>Financial broadcast</dt>
              <dd>None (0 financial transactions)</dd>
            </div>
            <div>
              <dt>Owner shares</dt>
              <dd>{evidence.revokedProposal.ownerShares} unchanged</dd>
            </div>
            <div>
              <dt>Guard balance</dt>
              <dd>{evidence.revokedProposal.guardAssets}</dd>
            </div>
            <div>
              <dt>Mandate</dt>
              <dd>{evidence.revokedProposal.mandateStillActive ? 'Still active' : 'Consumed'}</dd>
            </div>
          </dl>
          <ExternalLink href={explorerTransaction(evidence.revokedProposal.curatorRevocationTx)}>
            Open curator revocation tx
          </ExternalLink>
        </article>

        <article className="surface evidence-facts">
          <span className="panel-label">Historical proof</span>
          <h2>Canonical Morpho runtime</h2>
          <p>
            Unmodified Morpho Vault V2 release {evidence.source.release}, pinned to commit{' '}
            {shorten(evidence.source.commit, 12, 8)}. The factory runtime hash exactly matches
            Morpho&apos;s canonical Base deployment.
          </p>
          <dl>
            <div>
              <dt>Factory</dt>
              <dd>{shorten(evidence.position.factory, 12, 8)}</dd>
            </div>
            <div>
              <dt>Vault</dt>
              <dd>{shorten(evidence.position.vault, 12, 8)}</dd>
            </div>
            <div>
              <dt>Historical V1 proof</dt>
              <dd>{evidence.result.historicalDirectExecutionId}</dd>
            </div>
          </dl>
          <ExternalLink href={explorerAddress(evidence.position.vault)}>
            Open Morpho V2 vault
          </ExternalLink>
        </article>
      </section>
    </div>
  );
}

function RuleDrawer({
  mode,
  close,
  wallet,
}: {
  mode: 'review' | 'new';
  close: () => void;
  wallet: VetoWallet;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const initialShares =
    wallet.position?.position.sharesFormatted && wallet.position.position.sharesFormatted !== '0'
      ? wallet.position.position.sharesFormatted
      : '10';
  const initialMinAssets =
    wallet.position?.position.assetsFormatted && wallet.position.position.assetsFormatted !== '0'
      ? wallet.position.position.assetsFormatted
      : '9.5';

  const [draft, setDraft] = useState<RuleDraft>({
    feePercent: '1.00',
    shares: initialShares,
    minimumReturn: initialMinAssets,
    expiresHours: '168', // 7 days
    safetyMinutes: '5',
    managementFeeEnabled: false,
    performanceFeeEnabled: true, // Performance fee checked by default for demo!
    performanceFeePercent: '10',
    relativeCapEnabled: false,
    relativeCaps: [],
    adapterAllowlistEnabled: false,
    approvedAdapters: [],
    redemptionGateAllowlistEnabled: false,
    approvedSendSharesGates: [],
    approvedReceiveAssetsGates: [],
  });

  const [relativeCapRiskId, setRelativeCapRiskId] = useState('');
  const [relativeCapPercent, setRelativeCapPercent] = useState('20');
  const [adapterInput, setAdapterInput] = useState('');
  const [sendGateInput, setSendGateInput] = useState('');
  const [receiveGateInput, setReceiveGateInput] = useState('');

  const working = ['approving', 'arming', 'registering'].includes(wallet.action.stage);
  const complete = wallet.action.stage === 'complete';
  const error = wallet.action.stage === 'error';

  const shareSymbol = wallet.position?.position.shareSymbol ?? 'shares';
  const assetSymbol = wallet.position?.position.assetSymbol ?? 'USDC';

  const hasAnyPolicyEnabled = Boolean(
    draft.managementFeeEnabled ||
    draft.performanceFeeEnabled ||
    draft.relativeCapEnabled ||
    draft.adapterAllowlistEnabled ||
    draft.redemptionGateAllowlistEnabled,
  );

  function handleAddRelativeCap() {
    if (!relativeCapRiskId.trim()) return;
    setDraft((cur) => ({
      ...cur,
      relativeCaps: [
        ...(cur.relativeCaps ?? []),
        { riskId: relativeCapRiskId.trim(), maxRelativeCapPercent: relativeCapPercent },
      ],
    }));
    setRelativeCapRiskId('');
  }

  function handleAddAdapter() {
    if (!adapterInput.trim()) return;
    setDraft((cur) => ({
      ...cur,
      approvedAdapters: [...(cur.approvedAdapters ?? []), adapterInput.trim()],
    }));
    setAdapterInput('');
  }

  function handleAddSendGate() {
    if (!sendGateInput.trim()) return;
    setDraft((cur) => ({
      ...cur,
      approvedSendSharesGates: [...(cur.approvedSendSharesGates ?? []), sendGateInput.trim()],
    }));
    setSendGateInput('');
  }

  function handleAddReceiveGate() {
    if (!receiveGateInput.trim()) return;
    setDraft((cur) => ({
      ...cur,
      approvedReceiveAssetsGates: [
        ...(cur.approvedReceiveAssetsGates ?? []),
        receiveGateInput.trim(),
      ],
    }));
    setReceiveGateInput('');
  }

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
      role="presentation"
    >
      <section
        aria-labelledby="drawer-title"
        aria-modal="true"
        className="rule-drawer"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="drawer-title">Set exit rule</h2>
          </div>
          <button
            aria-label="Close"
            autoFocus
            className="icon-button"
            onClick={close}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>

        {/* 3-Step Pill Bar */}
        <div className="drawer-step-indicator">
          <div className={`step-pill ${step === 1 ? 'active' : step > 1 ? 'completed' : ''}`}>
            1 Protection
          </div>
          <div className={`step-pill ${step === 2 ? 'active' : step > 2 ? 'completed' : ''}`}>
            2 Exit details
          </div>
          <div className={`step-pill ${step === 3 ? 'active' : ''}`}>3 Review</div>
        </div>

        {/* STEP 1: Choose protection */}
        {step === 1 && (
          <div className="step-container">
            <h3
              style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 4px', color: 'var(--ink)' }}
            >
              What changes should make you exit?
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--muted)', margin: '0 0 16px' }}>
              5 policy families supported
            </p>

            {/* Performance Fee (Demo-First) */}
            <div
              className={`policy-card-selectable ${draft.performanceFeeEnabled ? 'selected' : ''}`}
              onClick={() =>
                setDraft((cur) => ({ ...cur, performanceFeeEnabled: !cur.performanceFeeEnabled }))
              }
            >
              <div className="policy-card-header">
                <input
                  type="checkbox"
                  checked={draft.performanceFeeEnabled ?? false}
                  onChange={(e) =>
                    setDraft((cur) => ({ ...cur, performanceFeeEnabled: e.target.checked }))
                  }
                  onClick={(e) => e.stopPropagation()}
                />
                <div>
                  <div className="policy-card-title">Performance fee</div>
                  <div className="policy-card-desc">
                    Exit if the performance fee goes above your limit.
                  </div>
                </div>
              </div>
              {draft.performanceFeeEnabled && (
                <div className="policy-card-input" onClick={(e) => e.stopPropagation()}>
                  <label
                    style={{ fontSize: '12px', fontWeight: 600, color: 'var(--aubergine-soft)' }}
                  >
                    Maximum performance fee (%)
                    <input
                      inputMode="decimal"
                      value={draft.performanceFeePercent ?? '10'}
                      onChange={(e) =>
                        setDraft((cur) => ({ ...cur, performanceFeePercent: e.target.value }))
                      }
                      style={{ marginTop: '6px' }}
                      placeholder="10"
                    />
                  </label>
                </div>
              )}
            </div>

            {/* Management Fee */}
            <div
              className={`policy-card-selectable ${draft.managementFeeEnabled ? 'selected' : ''}`}
              onClick={() =>
                setDraft((cur) => ({ ...cur, managementFeeEnabled: !cur.managementFeeEnabled }))
              }
            >
              <div className="policy-card-header">
                <input
                  type="checkbox"
                  checked={draft.managementFeeEnabled ?? false}
                  onChange={(e) =>
                    setDraft((cur) => ({ ...cur, managementFeeEnabled: e.target.checked }))
                  }
                  onClick={(e) => e.stopPropagation()}
                />
                <div>
                  <div className="policy-card-title">Management fee</div>
                  <div className="policy-card-desc">
                    Exit if the annual management fee goes above your limit.
                  </div>
                </div>
              </div>
              {draft.managementFeeEnabled && (
                <div className="policy-card-input" onClick={(e) => e.stopPropagation()}>
                  <label
                    style={{ fontSize: '12px', fontWeight: 600, color: 'var(--aubergine-soft)' }}
                  >
                    Maximum annual fee (%)
                    <input
                      inputMode="decimal"
                      value={draft.feePercent ?? '1.00'}
                      onChange={(e) => setDraft((cur) => ({ ...cur, feePercent: e.target.value }))}
                      style={{ marginTop: '6px' }}
                      placeholder="1.00"
                    />
                    <small style={{ color: 'var(--muted)', display: 'block', marginTop: '4px' }}>
                      Strictly less than 5.00% protocol maximum.
                    </small>
                  </label>
                </div>
              )}
            </div>

            {/* Advanced Policies Toggle */}
            <details className="advanced-policies-toggle">
              <summary>Advanced policies (relative caps, adapters, gates)</summary>
              <div className="advanced-policies-content">
                {/* Relative Cap */}
                <div style={{ marginBottom: '14px' }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontWeight: 600,
                      fontSize: '13px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={draft.relativeCapEnabled ?? false}
                      onChange={(e) =>
                        setDraft((cur) => ({ ...cur, relativeCapEnabled: e.target.checked }))
                      }
                    />
                    <span>Relative cap ceiling</span>
                  </label>
                  <p style={{ fontSize: '11px', color: 'var(--muted)', margin: '2px 0 8px 24px' }}>
                    Exit if a configured market allocation exceeds your ceiling.
                  </p>
                  {draft.relativeCapEnabled && (
                    <div style={{ paddingLeft: '24px' }}>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                        <input
                          placeholder="Risk ID (bytes32 hex)"
                          value={relativeCapRiskId}
                          onChange={(e) => setRelativeCapRiskId(e.target.value)}
                          style={{ flex: 2 }}
                        />
                        <input
                          placeholder="Cap %"
                          value={relativeCapPercent}
                          onChange={(e) => setRelativeCapPercent(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          className="button button-secondary"
                          onClick={handleAddRelativeCap}
                          type="button"
                        >
                          Add
                        </button>
                      </div>
                      {(draft.relativeCaps ?? []).map((c, i) => (
                        <div key={i} style={{ fontSize: '11px', color: 'var(--ink)' }}>
                          {shorten(c.riskId, 8, 6)} ≤ {c.maxRelativeCapPercent}%
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Adapter Allowlist */}
                <div style={{ marginBottom: '14px' }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontWeight: 600,
                      fontSize: '13px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={draft.adapterAllowlistEnabled ?? false}
                      onChange={(e) =>
                        setDraft((cur) => ({ ...cur, adapterAllowlistEnabled: e.target.checked }))
                      }
                    />
                    <span>Adapter allowlist</span>
                  </label>
                  <p style={{ fontSize: '11px', color: 'var(--muted)', margin: '2px 0 8px 24px' }}>
                    Exit if an unapproved adapter contract is queued.
                  </p>
                  {draft.adapterAllowlistEnabled && (
                    <div style={{ paddingLeft: '24px' }}>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                        <input
                          placeholder="0x... adapter address"
                          value={adapterInput}
                          onChange={(e) => setAdapterInput(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          className="button button-secondary"
                          onClick={handleAddAdapter}
                          type="button"
                        >
                          Add
                        </button>
                      </div>
                      {(draft.approvedAdapters ?? []).map((a, i) => (
                        <div key={i} style={{ fontSize: '11px', color: 'var(--ink)' }}>
                          {shorten(a, 8, 6)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Gates */}
                <div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontWeight: 600,
                      fontSize: '13px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={draft.redemptionGateAllowlistEnabled ?? false}
                      onChange={(e) =>
                        setDraft((cur) => ({
                          ...cur,
                          redemptionGateAllowlistEnabled: e.target.checked,
                        }))
                      }
                    />
                    <span>Redemption gates</span>
                  </label>
                  <p style={{ fontSize: '11px', color: 'var(--muted)', margin: '2px 0 8px 24px' }}>
                    Exit if an unapproved redemption gate is proposed.
                  </p>
                  {draft.redemptionGateAllowlistEnabled && (
                    <div style={{ paddingLeft: '24px' }}>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                        <input
                          placeholder="0x... gate address"
                          value={sendGateInput}
                          onChange={(e) => setSendGateInput(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          className="button button-secondary"
                          onClick={handleAddSendGate}
                          type="button"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </details>

            <div className="drawer-actions-row">
              <button
                className="button button-primary"
                disabled={!hasAnyPolicyEnabled}
                onClick={() => setStep(2)}
                style={{ width: '100%' }}
                type="button"
              >
                Next: Exit details →
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: Exit details */}
        {step === 2 && (
          <div className="step-container">
            <h3
              style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 16px', color: 'var(--ink)' }}
            >
              How much should VETO protect?
            </h3>

            <div style={{ display: 'grid', gap: '16px' }}>
              <label style={{ display: 'grid', gap: '6px', fontSize: '12px', fontWeight: 600 }}>
                Shares to protect ({shareSymbol})
                <input
                  inputMode="decimal"
                  value={draft.shares}
                  onChange={(e) => setDraft((cur) => ({ ...cur, shares: e.target.value }))}
                />
              </label>

              <label style={{ display: 'grid', gap: '6px', fontSize: '12px', fontWeight: 600 }}>
                Minimum return ({assetSymbol})
                <input
                  inputMode="decimal"
                  value={draft.minimumReturn}
                  onChange={(e) => setDraft((cur) => ({ ...cur, minimumReturn: e.target.value }))}
                />
              </label>

              <div className="form-grid">
                <label style={{ display: 'grid', gap: '6px', fontSize: '12px', fontWeight: 600 }}>
                  Rule expires (hours)
                  <input
                    inputMode="numeric"
                    value={draft.expiresHours}
                    onChange={(e) => setDraft((cur) => ({ ...cur, expiresHours: e.target.value }))}
                  />
                  <small style={{ color: 'var(--muted)' }}>168 hrs = 7 days</small>
                </label>

                <label style={{ display: 'grid', gap: '6px', fontSize: '12px', fontWeight: 600 }}>
                  Safety buffer (minutes)
                  <input
                    inputMode="numeric"
                    value={draft.safetyMinutes}
                    onChange={(e) => setDraft((cur) => ({ ...cur, safetyMinutes: e.target.value }))}
                  />
                  <small style={{ color: 'var(--muted)' }}>Lead time before timelock</small>
                </label>
              </div>
            </div>

            <div
              style={{
                marginTop: '20px',
                padding: '14px',
                background: 'var(--lavender)',
                borderRadius: '10px',
                fontSize: '12px',
                lineHeight: 1.5,
                color: 'var(--aubergine-soft)',
              }}
            >
              Assets are redeemed directly to your wallet. VETO and KeeperHub never receive the
              funds.
            </div>

            <div className="drawer-actions-row">
              <button className="button button-secondary" onClick={() => setStep(1)} type="button">
                ← Back
              </button>
              <button
                className="button button-primary"
                onClick={() => setStep(3)}
                style={{ flex: 1 }}
                type="button"
              >
                Next: Review rule →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Review & Progress */}
        {step === 3 && (
          <div className="step-container">
            <h3
              style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 16px', color: 'var(--ink)' }}
            >
              Review your rule
            </h3>

            <div className="rule-summary-card">
              {draft.performanceFeeEnabled && (
                <div className="summary-row">
                  <span>Performance fee</span>
                  <strong>Exit above {draft.performanceFeePercent}%</strong>
                </div>
              )}
              {draft.managementFeeEnabled && (
                <div className="summary-row">
                  <span>Management fee</span>
                  <strong>Exit above {draft.feePercent}%</strong>
                </div>
              )}
              {draft.relativeCapEnabled && (
                <div className="summary-row">
                  <span>Relative caps</span>
                  <strong>{draft.relativeCaps?.length ?? 0} market caps configured</strong>
                </div>
              )}
              {draft.adapterAllowlistEnabled && (
                <div className="summary-row">
                  <span>Adapter allowlist</span>
                  <strong>{draft.approvedAdapters?.length ?? 0} approved</strong>
                </div>
              )}
              {draft.redemptionGateAllowlistEnabled && (
                <div className="summary-row">
                  <span>Redemption gates</span>
                  <strong>Strict gate allowlist</strong>
                </div>
              )}
              <div className="summary-row">
                <span>Shares protected</span>
                <strong>
                  {draft.shares} {shareSymbol}
                </strong>
              </div>
              <div className="summary-row">
                <span>Minimum return</span>
                <strong>
                  {draft.minimumReturn} {assetSymbol}
                </strong>
              </div>
              <div className="summary-row">
                <span>Receiver</span>
                <strong>
                  {shorten(wallet.address ?? '0x0000000000000000000000000000000000000000')}
                </strong>
              </div>
              <div className="summary-row">
                <span>Rule duration</span>
                <strong>{draft.expiresHours} hours (7 days)</strong>
              </div>
            </div>

            {/* Progress indicators when working or complete */}
            {working || complete || error ? (
              <div style={{ margin: '18px 0' }}>
                <ul className="progress-list">
                  <li
                    className={`progress-item ${wallet.action.stage === 'approving' ? 'active' : ['arming', 'registering', 'complete'].includes(wallet.action.stage) ? 'done' : ''}`}
                  >
                    <span>1</span>
                    <span>Approve shares</span>
                    <span style={{ marginLeft: 'auto' }}>
                      {['arming', 'registering', 'complete'].includes(wallet.action.stage)
                        ? '✓'
                        : wallet.action.stage === 'approving'
                          ? 'Waiting for wallet…'
                          : ''}
                    </span>
                  </li>
                  <li
                    className={`progress-item ${wallet.action.stage === 'arming' || wallet.action.stage === 'registering' ? 'active' : wallet.action.stage === 'complete' ? 'done' : ''}`}
                  >
                    <span>2</span>
                    <span>Arm exit rule</span>
                    <span style={{ marginLeft: 'auto' }}>
                      {wallet.action.stage === 'complete'
                        ? '✓'
                        : wallet.action.stage === 'arming' || wallet.action.stage === 'registering'
                          ? 'Waiting for wallet…'
                          : ''}
                    </span>
                  </li>
                  <li
                    className={`progress-item ${wallet.action.stage === 'complete' ? 'done' : ''}`}
                  >
                    <span>3</span>
                    <span>Protection active</span>
                    <span style={{ marginLeft: 'auto' }}>
                      {wallet.action.stage === 'complete' ? '✓' : ''}
                    </span>
                  </li>
                </ul>

                {complete && (
                  <div
                    style={{
                      padding: '16px',
                      background: 'var(--verified-soft)',
                      borderRadius: '12px',
                      marginBottom: '16px',
                    }}
                  >
                    <strong
                      style={{ color: 'var(--verified)', display: 'block', fontSize: '15px' }}
                    >
                      Protection active
                    </strong>
                    <span
                      style={{
                        fontSize: '13px',
                        color: 'var(--ink)',
                        display: 'block',
                        marginTop: '4px',
                      }}
                    >
                      {draft.performanceFeeEnabled
                        ? `Performance fee ≤ ${draft.performanceFeePercent}%`
                        : 'Exit mandate confirmed onchain.'}
                    </span>
                    <p style={{ fontSize: '12px', color: 'var(--muted)', margin: '8px 0 0' }}>
                      VETO is watching this vault for a queued change that crosses your rule.
                    </p>
                  </div>
                )}

                {error && wallet.action.stage === 'error' && (
                  <div
                    style={{
                      padding: '14px',
                      background: '#fef2f2',
                      borderRadius: '10px',
                      color: '#b91c1c',
                      fontSize: '13px',
                      marginBottom: '16px',
                    }}
                  >
                    {wallet.action.message}
                  </div>
                )}

                <div className="drawer-actions-row">
                  {complete ? (
                    <button
                      className="button button-primary"
                      onClick={close}
                      style={{ width: '100%' }}
                      type="button"
                    >
                      Done
                    </button>
                  ) : error ? (
                    <button
                      className="button button-secondary"
                      onClick={() => wallet.resetAction()}
                      style={{ width: '100%' }}
                      type="button"
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div>
                <p
                  style={{
                    fontSize: '12px',
                    color: 'var(--muted)',
                    margin: '0 0 20px',
                    lineHeight: 1.5,
                  }}
                >
                  This requires two wallet confirmations:
                  <br />
                  1. Approve the selected vault shares
                  <br />
                  2. Arm your VETO rule
                </p>

                <div className="drawer-actions-row">
                  <button
                    className="button button-secondary"
                    onClick={() => setStep(2)}
                    type="button"
                  >
                    ← Back
                  </button>
                  <button
                    className="button button-primary"
                    onClick={() => void wallet.approveAndArm(draft)}
                    style={{ flex: 1 }}
                    type="button"
                  >
                    Approve & arm
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export function OperatorConsole({ evidence }: { evidence: Evidence }) {
  const [view, setView] = useState<View>('overview');
  const [drawer, setDrawer] = useState<'review' | 'new' | undefined>();
  const wallet = useVetoWallet();

  useEffect(() => {
    if (!drawer) return;
    const handleKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(undefined);
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [drawer]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary navigation">
          {navigation.map((item) => (
            <button
              aria-current={view === item.view ? 'page' : undefined}
              className={view === item.view ? 'nav-item active' : 'nav-item'}
              key={item.view}
              onClick={() => setView(item.view)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>Base Sepolia</span>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <Brand compact />
          <div className="network-pill">Base Sepolia</div>
          <button className="wallet-button" onClick={wallet.connect} type="button">
            <Icon name="wallet" />
            <span aria-live="polite">{wallet.message}</span>
          </button>
        </header>

        <div className="content-frame">
          {view === 'overview' ? (
            <Overview
              evidence={evidence}
              openNewRule={() => {
                wallet.resetAction();
                setDrawer('new');
              }}
              setView={setView}
              wallet={wallet}
            />
          ) : null}
          {view === 'rules' ? (
            <Rules
              openNewRule={() => {
                wallet.resetAction();
                setDrawer('new');
              }}
              wallet={wallet}
            />
          ) : null}
          {view === 'activity' ? <Activity setView={setView} wallet={wallet} /> : null}
          {view === 'evidence' ? <EvidenceView evidence={evidence} /> : null}
        </div>

        <nav aria-label="Mobile navigation" className="mobile-nav">
          {navigation.map((item) => (
            <button
              aria-current={view === item.view ? 'page' : undefined}
              className={view === item.view ? 'active' : ''}
              key={item.view}
              onClick={() => setView(item.view)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </section>

      {drawer ? (
        <RuleDrawer
          close={() => setDrawer(undefined)}
          key={`${drawer}-${wallet.address ?? 'disconnected'}`}
          mode={drawer}
          wallet={wallet}
        />
      ) : null}
    </main>
  );
}
